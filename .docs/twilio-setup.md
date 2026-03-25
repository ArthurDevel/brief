# Twilio Setup Guide

This app receives inbound phone calls via Twilio. Twilio hits your webhook URLs, authenticates the caller (phone number lookup + PIN), then opens a bidirectional WebSocket media stream for real-time voice AI.

Phone numbers are managed in the `company_phone_numbers` database table, with separate numbers for `dev` and `prod` environments. Each country gets one number per environment.

## Prerequisites

- A [Twilio account](https://console.twilio.com/) (free trial works)
- One or more Twilio phone numbers with Voice capability
- `cloudflared` installed (`brew install cloudflared`)
- `jq` installed (`brew install jq`)

## 1. Environment variables

Add these to `apps/voice-pipeline/.env`:

```env
TWILIO_ACCOUNT_SID=ACxxxxx
TWILIO_AUTH_TOKEN=xxxxx
APP_ENVIRONMENT=dev
```

Phone numbers are no longer configured via env vars. They come from the `company_phone_numbers` table in Supabase.

## 2. Adding phone numbers

Use the setup script to add a company phone number to the database and optionally configure its Twilio webhook:

```bash
./scripts/add-company-phone.sh \
  --phone "+15551234567" \
  --country US \
  --label "United States" \
  --env dev \
  --webhook-url "https://your-tunnel-url.com"
```

This inserts a row into `company_phone_numbers` and (if `--webhook-url` is provided) configures the Twilio voice webhook.

## 3. Local development

The dev script handles everything -- tunnel, webhook configuration, venv setup, type checking, and server start:

```bash
cd apps/voice-pipeline
./dev-server-start.sh
```

This will:
1. Create a `.venv` and install dependencies (if needed)
2. Run pyright type checks
3. Start a Cloudflare quick tunnel
4. Query `company_phone_numbers` for all dev numbers and configure their webhooks
5. Start the voice pipeline server with `APP_ENVIRONMENT=dev`

If no dev phone numbers exist in the database, the server starts without Twilio webhook setup. A message will point you to `scripts/add-company-phone.sh`.

## 4. Production

For deployed environments, set `APP_ENVIRONMENT=prod` and configure webhooks using the update script:

```bash
./scripts/update-twilio-webhooks.sh --url "https://your-production-server.com" --env prod
```

This queries all active prod phone numbers from the database and updates each one's Twilio webhook to `<url>/twilio/voice`.

## 5. Call flow

```
Caller dials a company Twilio number
  -> Twilio POSTs to /twilio/voice
  -> App looks up caller phone in user_settings.phone->>number (JSONB)
  -> If found & not locked: returns TwiML <Gather> to collect 6-digit PIN
  -> Twilio POSTs digits to /twilio/verify-pin
  -> App verifies PIN (bcrypt), checks monthly usage limit
  -> On success: returns TwiML <Connect><Stream> with userId parameter
  -> Twilio opens bidirectional WebSocket to /twilio-stream
  -> userId is extracted from Twilio's "start" event customParameters
```

## 6. Endpoints

| Endpoint | Path |
|---|---|
| Incoming call webhook | `POST /twilio/voice` |
| PIN verification | `POST /twilio/verify-pin` |
| Media stream WebSocket | `WS /twilio-stream` |

## 7. Database tables

The auth flow reads from these Supabase tables:

- **`user_settings`** -- `phone` (JSONB: `{ "number": "+1...", "countryCode": "US" }`), `pin_hash` (bcrypt), `pin_locked`, `pin_attempts`, `user_id`
- **`company_phone_numbers`** -- `phone_number`, `country_code`, `label`, `environment` (`dev`/`prod`), `is_active`
- **`subscriptions`** -- `user_id`, `plan` (free = 1hr/month, pro = 10hr/month)
- **`sessions`** -- `user_id`, `started_at`, `duration_seconds` (for usage tracking)

A user must have their phone number (as JSONB) and a hashed PIN stored in `user_settings` before they can call in. Set your PIN via the dashboard settings page.

## 8. Setup scripts

| Script | Description |
|---|---|
| `scripts/add-company-phone.sh` | Add a company phone number to the DB and optionally configure its Twilio webhook |
| `scripts/update-twilio-webhooks.sh` | Update Twilio voice webhooks for all company phone numbers to a new server URL |

## 9. Troubleshooting

**"This phone number is not registered"** -- The caller's phone number (E.164 format, e.g. `+15551234567`) isn't in `user_settings.phone->>number`.

**"Your account is locked"** -- 3 failed PIN attempts. Reset by setting `pin_locked = false` and `pin_attempts = 0` in `user_settings`.

**No audio / WebSocket doesn't connect** -- Make sure `PUBLIC_URL` is set to your HTTPS tunnel URL. The app derives the `wss://` stream URL from it.

**Twilio shows "HTTP retrieval failure"** -- Your server isn't reachable. Check that the tunnel is running.

**"Invalid salt" on PIN verify** -- The PIN in the database isn't bcrypt-hashed. Re-save your PIN from the dashboard.
