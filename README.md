# Voice Email Assistant

A voice-powered email assistant. Users call a phone number, authenticate via caller ID + PIN, and manage their email inbox using voice commands. A Next.js dashboard lets users configure settings, approve/undo actions, and review call history.

**Stack**: OpenAI Realtime API, Twilio, Supabase, Next.js, ImapFlow, TypeScript

## Architecture

```
/
  packages/
    tools/          Shared tool definitions, action queue, classification, vault helpers
    email/          IMAP client (ImapFlow) and SMTP client (nodemailer)
  apps/
    voice-gateway/  Express + WebSocket server handling Twilio media streams + OpenAI relay
    web/            Next.js dashboard (auth, settings, actions, history, billing)
  supabase/
    migrations/     Database schema (7 tables + RLS policies)
```

## Prerequisites

- Node.js >= 18
- [pnpm](https://pnpm.io) >= 9
- A [Supabase](https://supabase.com) project (for auth + database)
- An [OpenAI](https://platform.openai.com) API key with Realtime API access
- A [Twilio](https://twilio.com) account with a phone number (for voice calls)
- An IMAP/SMTP email account (e.g. Gmail with app password)

## Setup

### 1. Install dependencies

```bash
pnpm install
```

Run this from the project root. This is a monorepo -- a single `pnpm install` at the root installs dependencies for all packages and apps at once, and links the local packages (`@dublin/tools`, `@dublin/email`) so they can import each other. You do not need to run install inside individual apps.

### 2. Configure environment variables

Copy the example files and fill in your values:

```bash
cp apps/voice-gateway/.env.example apps/voice-gateway/.env
cp apps/web/.env.example apps/web/.env.local
```

**Voice Gateway** (`apps/voice-gateway/.env`):

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key with Realtime API access |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (bypasses RLS) |
| `PUBLIC_URL` | Public URL where this server is reachable (default: `http://localhost:3001`). Used to build the WebSocket URL that Twilio connects back to. Set to your ngrok/deployed URL in production. |
| `PORT` | Server port (default: `3001`) |

**Web Dashboard** (`apps/web/.env.local`):

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only, used for Vault secret storage) |

### 3. Run the database migration

Using the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
npx supabase link --project-ref your-project-ref
npx supabase db push
```

This creates the 7 tables: `user_settings`, `user_memory`, `sessions`, `actions`, `feature_requests`, `subscriptions`, `usage`.

### 4. Start the apps

From the project root:

```bash
# Terminal 1 -- voice gateway (port 3001)
pnpm dev:gateway

# Terminal 2 -- web dashboard (port 3000)
pnpm dev:web
```

Or run them individually from their directories:

```bash
cd apps/voice-gateway && pnpm dev
cd apps/web && pnpm dev
```

- Dashboard: http://localhost:3000
- Voice gateway: http://localhost:3001
- Health check: http://localhost:3001/health

## Twilio Setup

The voice gateway requires Twilio to be able to reach your server. For local development, use [ngrok](https://ngrok.com):

```bash
ngrok http 3001
```

Then configure your Twilio phone number:
1. Go to your Twilio Console > Phone Numbers > Active Numbers
2. Set the Voice webhook to `https://your-ngrok-url/twilio/voice` (HTTP POST)

Update `apps/voice-gateway/.env` to match:

```env
PUBLIC_URL=https://your-ngrok-url
```

## WhatsApp Local Dev

For the WhatsApp call flow, run the web app, the WhatsApp webhook server, and the WhatsApp agent locally.

### 1. Configure env files

```bash
cp apps/web/.env.example apps/web/.env.local
cp apps/whatsapp-server/.env.example apps/whatsapp-server/.env
cp apps/whatsapp-agent/.env.example apps/whatsapp-agent/.env
cp apps/whatsapp-emulator/.env.example apps/whatsapp-emulator/.env
```

Important values:
- `apps/whatsapp-server/.env`
  - `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
  - `WHATSAPP_ACCESS_TOKEN`
  - `WHATSAPP_PHONE_NUMBER_ID`
  - `WHATSAPP_BUSINESS_ACCOUNT_ID`
  - `WHATSAPP_WEB_BASE_URL`
  - `DEEPGRAM_API_KEY`
  - `LIVEKIT_URL`
  - `LIVEKIT_API_KEY`
  - `LIVEKIT_API_SECRET`
- `apps/whatsapp-agent/.env`
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `COMPOSIO_API_KEY`
  - `LIVEKIT_URL`
  - `LIVEKIT_API_KEY`
  - `LIVEKIT_API_SECRET`
- `apps/whatsapp-emulator/.env`
  - `WHATSAPP_SERVER_URL`
  - `LIVEKIT_URL`
  - `LIVEKIT_API_KEY`
  - `LIVEKIT_API_SECRET`
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`

Keep `LIVEKIT_AGENT_NAME` the same in both `apps/whatsapp-server/.env` and `apps/whatsapp-agent/.env`.
Set `WHATSAPP_TRANSPORT_MODE=emulator` and `WHATSAPP_EMULATOR_URL=http://localhost:3030` when you want
`apps/whatsapp-server` to deliver outbound chat replies into the emulator instead of the real WhatsApp transport.

### 2. Start the local apps

```bash
# Terminal 1
pnpm dev:web

# Terminal 2
cd apps/whatsapp-server && pnpm dev

# Terminal 3
cd apps/whatsapp-agent && pnpm dev
```

Or start the full local WhatsApp stack from the repo root:

```bash
pnpm dev:whatsapp-stack
```

This starts:
- `apps/web`
- `apps/whatsapp-server`
- `apps/whatsapp-agent`
- `apps/whatsapp-emulator`

### 3. Expose the WhatsApp webhook with ngrok

```bash
ngrok http 3020
```

Use the `https` URL from `ngrok` in two places:
- Set the Meta webhook URL to `https://<your-ngrok-subdomain>.ngrok.app/api/whatsapp/webhook`
- Set `WHATSAPP_WEB_BASE_URL=https://<your-ngrok-subdomain>.ngrok.app` in `apps/whatsapp-server/.env`

When Meta verifies the webhook, it will call:

```text
GET /api/whatsapp/webhook
```

When a user sends a WhatsApp message or starts a call, Meta will post to:

```text
POST /api/whatsapp/webhook
```

## Call Flow

### Phone (Twilio)

1. User calls Twilio number
2. Twilio hits `/twilio/voice` -- looks up caller ID, prompts for PIN
3. PIN verified via `/twilio/verify-pin` -- checks usage limits, starts media stream
4. WebSocket connects at `/media-stream?userId=xxx`
5. Audio is transcoded (mulaw 8kHz <-> PCM16 24kHz) and relayed to OpenAI Realtime API
6. Tool calls route through the action queue (auto-execute, queue for approval, or read-only)
7. On disconnect: session saved, IMAP connection closed

### Browser (localhost debugging)

1. User clicks "Start Call" on `/dashboard/call`
2. Browser captures mic audio via AudioWorklet, resamples 48kHz -> 24kHz PCM16
3. WebSocket connects at `/browser-stream?token=<supabase-jwt>`
4. Gateway authenticates the JWT, loads user context, and opens an OpenAI Realtime session
5. PCM16 24kHz audio is relayed directly to OpenAI (no transcoding needed)
6. Response audio streams back to the browser and plays via a playback AudioWorklet

## Dashboard Pages

| Page | Description |
|------|-------------|
| `/dashboard` | Overview: recent calls, pending approvals, usage |
| `/dashboard/call` | Browser-based voice call (for localhost debugging without Twilio) |
| `/dashboard/settings` | IMAP/SMTP config, phone, PIN, voice preference, tool approval toggles, memory |
| `/dashboard/actions` | Pending actions (approve/reject), executed actions (undo) |
| `/dashboard/history` | Past call sessions with transcripts |
| `/dashboard/billing` | Plan info, usage progress, upgrade CTA (Stripe not wired) |
| `/dashboard/feature-requests` | User-submitted feature requests |

## Billing

Consumption-based on call hours:
- **Free**: 1 hour/month
- **Pro**: 5 hours/month (Stripe not wired for MVP)

Usage is checked at call start. No mid-call cutoff.

## Available Tools

| Tool | Classification | Undoable |
|------|---------------|----------|
| `list_inbox` | read_only | -- |
| `read_email` | read_only | -- |
| `search_emails` | read_only | -- |
| `mark_as_read` | mutating_auto | No |
| `archive_email` | mutating_auto | Yes (move back) |
| `draft_email` | mutating_auto | Yes (delete draft) |
| `delete_email` | mutating_queued | Yes (move back from Trash) |
| `send_email` | mutating_queued (locked) | No |
| `save_memory` | mutating_auto | Yes (restore previous) |
| `submit_feature_request` | mutating_auto | Yes (delete) |

Users can override classifications in dashboard settings (except `send_email`, always queued).
