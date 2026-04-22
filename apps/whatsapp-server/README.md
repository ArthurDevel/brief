# WhatsApp Server

Minimal Express webhook server for the WhatsApp calling MVP.

## What it does

- Handles Meta webhook verification and incoming webhook events
- Verifies the Meta webhook signature before processing requests
- Bridges WhatsApp events into the LiveKit voice flow
- Sends outbound WhatsApp replies and auth prompts

## Local run

```bash
cd apps/whatsapp-server
cp .env.example .env
pnpm dev
```

## Coolify deployment

Deploy this app from the monorepo root, not from `apps/whatsapp-server`.

Use the dedicated Dockerfile for this app:

- Base Directory: `/`
- Dockerfile Location: `apps/whatsapp-server/Dockerfile`

This app depends on the root `pnpm-workspace.yaml` and `pnpm-lock.yaml`, so app-level deployment from `apps/whatsapp-server` will fall back to `npm` and break the expected workspace setup.
