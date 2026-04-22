# Meta WhatsApp Setup

Short overview of how Meta's WhatsApp setup fits together for this repo.

- Explains which Meta IDs matter and what they are used for
- Lists the minimum setup steps to make this app receive and send WhatsApp traffic
- Calls out the few steps that are worth delegating to an agent

## Mental model

Meta splits WhatsApp setup across a few different objects:

- Meta App
  This owns the webhook URL and webhook verification.
- WABA (WhatsApp Business Account)
  This owns message templates and app subscriptions.
- Phone Number ID
  This is the actual WhatsApp sender identity used for sending messages and receiving traffic.

The most important rule:

- The webhook is connected to the Meta app.
- Real WhatsApp traffic is delivered when the WABA is subscribed to that app.
- The server then uses the phone number ID and access token to send messages.

If one of those pieces is missing, the setup can look correct in the UI but still not work.

## What this repo expects

The WhatsApp webhook server lives in `apps/whatsapp-server`.

Important endpoints:

- Health check: `GET /health`
- Webhook verify + receive: `GET/POST /api/whatsapp/webhook`

The deployed webhook URL should be:

- `https://whatsapp-server.brewdock.ai/api/whatsapp/webhook`

Important env vars for the deployed server:

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_PHONE_NUMBER_ID`
- `WHATSAPP_BUSINESS_ACCOUNT_ID`
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- `META_APP_SECRET`

## Setup checklist

### 1. Create or choose the right Meta app

Use the app that should own the webhook for this product.

In practice:

- Open Meta Developers
- Open the app
- Add the WhatsApp product if it is not already there

### 2. Configure the webhook on the Meta app

In the Meta app's webhook settings:

- Set callback URL to `https://whatsapp-server.brewdock.ai/api/whatsapp/webhook`
- Set the verify token to the same value used in `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- Subscribe the app to the webhook fields you need

For messaging:

- `messages`

For WhatsApp calling:

- `messages`
- `calls`

Notes:

- The webhook URL is not configured on the phone number
- The phone number alone is not enough to start receiving events
- App webhook field subscriptions and WABA app subscriptions are separate things
- Calling can still show as misconfigured if the WABA is subscribed but the app is not subscribed to the `calls` webhook field

### 3. Make sure the WABA is subscribed to the Meta app

This is the step that is easiest to miss.

Even if the webhook URL is correct, real messages will not reach the app unless the WABA is subscribed to that app.

This is one of the steps that is reasonable to delegate to an agent.

```text
LLM task:
Subscribe WABA <WABA_ID> to the Brewdock Meta app and verify it appears in /subscribed_apps.

Expected API:
POST /<WABA_ID>/subscribed_apps
GET /<WABA_ID>/subscribed_apps
```

Important:

- Old app subscriptions can remain attached
- If multiple apps stay subscribed, webhook delivery can become confusing
- If Brewdock should be the only app, remove old subscriptions as part of the migration
- This step alone is not enough for calling; the Meta app must also be subscribed to the `calls` webhook field

### 4. Register the phone number for Cloud API

Adding a phone number to the WABA is not always enough.

If the phone number shows:

- `status: PENDING`
- `platform_type: NOT_APPLICABLE`
- Meta UI message like `Please register this phone number using the registration API`

then the number has not been registered for direct Cloud API use yet.

This is one of the fastest things to delegate to an agent.

```text
LLM task:
Check the phone number object. If it is PENDING / NOT_APPLICABLE, register it with
POST /<PHONE_NUMBER_ID>/register using a 6-digit PIN, then verify the phone number becomes
CONNECTED / CLOUD_API.
```

Expected API:

```bash
curl -X POST "https://graph.facebook.com/v23.0/<PHONE_NUMBER_ID>/register" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "pin": "<SIX_DIGIT_PIN>"
  }'
```

What success looks like:

- `platform_type: CLOUD_API`
- `status: CONNECTED`

### 5. Update the deployed server env

The deployed `whatsapp-server` must point at the new WhatsApp assets.

Set:

- `WHATSAPP_PHONE_NUMBER_ID` to the new phone number ID
- `WHATSAPP_BUSINESS_ACCOUNT_ID` to the new WABA ID
- `WHATSAPP_ACCESS_TOKEN` to a valid token that can send through that phone number
- `WHATSAPP_WEBHOOK_VERIFY_TOKEN` to the token used in the Meta webhook config
- `META_APP_SECRET` to the app secret for the same Meta app that owns the webhook

Common failure modes:

- Wrong phone number ID: sends fail
- Wrong WABA ID: template and management calls fail
- Wrong app secret: webhook POSTs fail signature validation
- Wrong verify token: Meta webhook verification fails

### 6. Create or migrate templates on the new WABA

Templates live on the WABA, not on the app and not on the phone number.

If a new WABA was created, the templates usually need to be recreated there.

This is worth delegating to an agent because it is repetitive and easy to get wrong.

This repo already has a one-off template copy script:

- `testscripts/2026.04.21-whatsapp-template-copy`

```text
LLM task:
Copy approved templates from source WABA <SOURCE_WABA_ID> to destination WABA <DESTINATION_WABA_ID>
using testscripts/2026.04.21-whatsapp-template-copy, run dry-run first, then apply, then verify
the final destination template list.
```

Notes:

- Meta may still re-review recreated templates
- `hello_world` is special and may be blocked because Meta treats it as a sample template name

### 7. Verify the setup end to end

After setup, verify these in order:

1. `GET /health` returns `200`
2. webhook verification succeeds in Meta
3. the phone number is `CONNECTED` and `CLOUD_API`
4. a signed test webhook POST is accepted
5. the deployed env uses the new phone number ID and WABA ID
6. inbound message events reach the server
7. outbound sends succeed from the new phone number

## How to think about the IDs

When Meta shows many similar-looking IDs, use this rule:

- WABA ID
  Used for templates and app subscriptions
- Phone Number ID
  Used for sending messages and phone number configuration
- Meta App ID
  Used for webhook ownership and app-level setup

If an ID supports:

- `/message_templates` or `/phone_numbers`, it is behaving like a WABA
- `display_phone_number`, it is behaving like a phone number object

If a phone number object shows:

- `status: PENDING`
- `platform_type: NOT_APPLICABLE`

then it still needs the registration API call before direct Cloud API sending and calling will work.

## Real example

One direct Meta number that was successfully registered in this project:

- WABA ID: `935045709508184`
- Phone number ID: `1066314633232618`
- Display number: `+1 650-977-4723`

Before registration:

- `status: PENDING`
- `platform_type: NOT_APPLICABLE`

After `POST /1066314633232618/register`:

- `status: CONNECTED`
- `platform_type: CLOUD_API`

The same setup also needed the WABA to be subscribed to the Brewdock app:

```bash
curl -X POST "https://graph.facebook.com/v23.0/935045709508184/subscribed_apps" \
  -d "access_token=<ACCESS_TOKEN>"
```

Verification:

- `GET /935045709508184/subscribed_apps` showed the `Brewdock` app

Calling note:

- Even after WABA subscription succeeds, WhatsApp calling still requires the Meta app webhook config to include the `calls` field

## What the user can usually do themselves

- Create the Meta app
- Paste the webhook URL and verify token into Meta
- Add the phone number and complete any verification code step
- Update the deployment env vars
- Check the Meta UI for the new phone number and WABA

## What is reasonable to delegate to an agent

- Subscribe or verify the WABA app connection
- Register a pending phone number with the registration API
- Copy templates from one WABA to another
- Verify webhook health, verification, and signed POST behavior
- Check which apps are still subscribed to a WABA

## Repo references

- `apps/whatsapp-server/src/server.ts`
- `apps/whatsapp-server/src/whatsAppBot.ts`
- `apps/whatsapp-server/.env.example`
- `testscripts/2026.04.21-whatsapp-template-copy`
