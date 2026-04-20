# WhatsApp Voice Options Investigation

## Goal

Verify that the WhatsApp voice settings page can load available voices dynamically from the active voice provider, without hardcoding the options in the frontend.

## What we tested

- A standalone provider adapter with one active provider constant
- Dynamic voice loading from Deepgram's models API
- Normalization into a WhatsApp-specific DTO that the frontend and agent can both use
- Validation of a selected voice and speed against the dynamically loaded catalog

## What failed

- Directly coupling the page to an existing app-specific voice route would tie WhatsApp to the wrong surface.
- Using a fixed frontend allowlist would work short-term, but it would force code changes whenever the provider catalog changes.

## Solution

Use a WhatsApp-specific backend route that loads voices from the active provider and returns a normalized DTO.

For this draft test:
- The active provider is selected with a file-level constant in `investigate.ts`
- The provider is queried dynamically at runtime
- The normalized output is written to `output/voice-options.json`

## How to run

```bash
cd testscripts/2026.04.20-whatsapp-voice-options
pnpm install
pnpm run run
```

Set `DEEPGRAM_API_KEY` in `.env` first.

## Result

If this draft works, production should follow the same shape:
- `apps/web` exposes a WhatsApp-only route for voice options
- `apps/web` uses that route in `/whatsapp/settings/voice`
- `apps/whatsapp-agent` validates and uses the same provider-backed voice IDs

Current investigation result:
- Deepgram currently returns 41 English `aura-2-*` voices through the models API
- That is already enough to justify dynamic loading instead of keeping a stale hardcoded WhatsApp list
- The normalized output is written to `output/voice-options.json`
