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
- A [Supabase](https://supabase.com) project (for auth + database)
- An [OpenAI](https://platform.openai.com) API key with Realtime API access
- A [Twilio](https://twilio.com) account with a phone number (for voice calls)
- An IMAP/SMTP email account (e.g. Gmail with app password)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

**Voice Gateway** -- create `apps/voice-gateway/.env`:

```env
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
WS_HOST=localhost:3001
WS_SECURE=false
PORT=3001
```

**Web Dashboard** -- create `apps/web/.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

### 3. Run the database migration

Using the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
npx supabase link --project-ref your-project-ref
npx supabase db push
```

This creates the 7 tables: `user_settings`, `user_memory`, `sessions`, `actions`, `feature_requests`, `subscriptions`, `usage`.

### 4. Start the apps

```bash
# Terminal 1 -- voice gateway (port 3001)
npm run dev:gateway

# Terminal 2 -- web dashboard (port 3000)
npm run dev:web
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

Update your `.env` to match:

```env
WS_HOST=your-ngrok-url
WS_SECURE=true
```

## Call Flow

1. User calls Twilio number
2. Twilio hits `/twilio/voice` -- looks up caller ID, prompts for PIN
3. PIN verified via `/twilio/verify-pin` -- checks usage limits, starts media stream
4. WebSocket connects at `/media-stream?userId=xxx`
5. Audio is transcoded (mulaw 8kHz <-> PCM16 24kHz) and relayed to OpenAI Realtime API
6. Tool calls route through the action queue (auto-execute, queue for approval, or read-only)
7. On disconnect: session saved, IMAP connection closed

## Dashboard Pages

| Page | Description |
|------|-------------|
| `/dashboard` | Overview: recent calls, pending approvals, usage |
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
