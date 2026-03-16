# Twilio Setup Guide

This app receives inbound phone calls via Twilio. Twilio hits your webhook URLs, authenticates the caller (phone number lookup + PIN), then opens a bidirectional WebSocket media stream for real-time voice AI.

## Prerequisites

- A [Twilio account](https://console.twilio.com/) (free trial works)
- A Twilio phone number with Voice capability
- Your server exposed to the internet (via ngrok, Cloudflare Tunnel, or a deployed host)

## 1. Expose your server

Twilio needs to reach your webhook endpoints over HTTPS. During development, use ngrok:

```bash
ngrok http 8765
```

Copy the `https://xxxxx.ngrok-free.app` URL — this is your `PUBLIC_URL`.

## 2. Set environment variables

Add `PUBLIC_URL` to your voice-pipeline `.env` so the app can construct the correct WebSocket URL for Twilio's `<Stream>`:

```env
PUBLIC_URL=https://xxxxx.ngrok-free.app
```

No Twilio SDK keys are needed — the app only receives webhooks, it doesn't call the Twilio API.

## 3. Configure the Twilio phone number

1. Go to **Phone Numbers** → **Manage** → **Active Numbers** in the [Twilio Console](https://console.twilio.com/us1/develop/phone-numbers/manage/incoming)
2. Click your phone number
3. Under **Voice Configuration**:
   - **A call comes in**: set to **Webhook**
   - **URL**: `https://your-public-url/twilio/voice`
   - **HTTP Method**: `POST`
4. Save

That's it. When someone calls your Twilio number, Twilio will POST to `/twilio/voice`, which kicks off the auth flow.

## 4. Call flow

```
Caller dials Twilio number
  → Twilio POSTs to /twilio/voice
  → App looks up caller phone in user_settings table
  → If found & not locked: returns TwiML <Gather> to collect 6-digit PIN
  → Twilio POSTs digits to /twilio/verify-pin?userId=...&attempt=1
  → App verifies PIN (bcrypt), checks monthly usage limit
  → On success: returns TwiML <Connect><Stream url="wss://.../twilio-stream" />
  → Twilio opens bidirectional WebSocket for real-time audio
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
- **`subscriptions`** — `user_id`, `hours_limit` (defaults to 1 hour if missing)
- **`sessions`** — `user_id`, `started_at`, `duration_seconds` (for usage tracking)

A user must have their phone number and a hashed PIN stored in `user_settings` before they can call in.

## 7. Troubleshooting

**"This phone number is not registered"** — The caller's phone number (E.164 format, e.g. `+15551234567`) isn't in `user_settings.phone_number`.

**"Your account is locked"** — 3 failed PIN attempts. Reset by setting `pin_locked = false` and `pin_attempts = 0` in `user_settings`.

**No audio / WebSocket doesn't connect** — Make sure `PUBLIC_URL` is set to your HTTPS ngrok/tunnel URL. The app derives the `wss://` stream URL from it.

**Twilio shows "HTTP retrieval failure"** — Your server isn't reachable. Check that ngrok is running and the URL matches.
