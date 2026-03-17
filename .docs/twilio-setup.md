# Twilio Setup Guide

This app receives inbound phone calls via Twilio. Twilio hits your webhook URLs, authenticates the caller (phone number lookup + PIN), then opens a bidirectional WebSocket media stream for real-time voice AI.

## Prerequisites

- A [Twilio account](https://console.twilio.com/) (free trial works)
- A Twilio phone number with Voice capability
- `cloudflared` installed (`brew install cloudflared`)

## 1. Environment variables

Add these to `apps/voice-pipeline/.env`:

```env
TWILIO_ACCOUNT_SID=ACxxxxx
TWILIO_AUTH_TOKEN=xxxxx
TWILIO_PHONE_NUMBER=+15551234567
```

## 2. Local development

The dev script handles everything — tunnel, webhook configuration, venv setup, type checking, and server start:

```bash
cd apps/voice-pipeline
./dev-server-start.sh
```

This will:
1. Create a `.venv` and install dependencies (if needed)
2. Run pyright type checks
3. Start a Cloudflare quick tunnel
4. Automatically update your Twilio phone number's webhook to point at the tunnel
5. Start the voice pipeline server

No manual Twilio Console configuration needed for local dev.

## 3. Production

For deployed environments, set `PUBLIC_URL` to your server's HTTPS URL and configure the Twilio phone number webhook manually:

1. Go to **Phone Numbers** → **Manage** → **Active Numbers** in the [Twilio Console](https://console.twilio.com/us1/develop/phone-numbers/manage/incoming)
2. Click your phone number
3. Under **Voice Configuration**:
   - **A call comes in**: set to **Webhook**
   - **URL**: `https://your-domain/twilio/voice`
   - **HTTP Method**: `POST`
4. Save

## 4. Call flow

```
Caller dials Twilio number
  → Twilio POSTs to /twilio/voice
  → App looks up caller phone in user_settings table
  → If found & not locked: returns TwiML <Gather> to collect 6-digit PIN
  → Twilio POSTs digits to /twilio/verify-pin
  → App verifies PIN (bcrypt), checks monthly usage limit
  → On success: returns TwiML <Connect><Stream> with userId parameter
  → Twilio opens bidirectional WebSocket to /twilio-stream
  → userId is extracted from Twilio's "start" event customParameters
```

## 5. Endpoints

| Endpoint | Path |
|---|---|
| Incoming call webhook | `POST /twilio/voice` |
| PIN verification | `POST /twilio/verify-pin` |
| Media stream WebSocket | `WS /twilio-stream` |

## 6. Database requirements

The auth flow reads from these Supabase tables:

- **`user_settings`** — `phone_number`, `pin_hash` (bcrypt), `pin_locked`, `pin_attempts`, `user_id`
- **`subscriptions`** — `user_id`, `plan` (free = 1hr/month, pro = 10hr/month)
- **`sessions`** — `user_id`, `started_at`, `duration_seconds` (for usage tracking)

A user must have their phone number and a hashed PIN stored in `user_settings` before they can call in. Set your PIN via the dashboard settings page.

## 7. Troubleshooting

**"This phone number is not registered"** — The caller's phone number (E.164 format, e.g. `+15551234567`) isn't in `user_settings.phone_number`.

**"Your account is locked"** — 3 failed PIN attempts. Reset by setting `pin_locked = false` and `pin_attempts = 0` in `user_settings`.

**No audio / WebSocket doesn't connect** — Make sure `PUBLIC_URL` is set to your HTTPS tunnel URL. The app derives the `wss://` stream URL from it.

**Twilio shows "HTTP retrieval failure"** — Your server isn't reachable. Check that the tunnel is running.

**"Invalid salt" on PIN verify** — The PIN in the database isn't bcrypt-hashed. Re-save your PIN from the dashboard.
