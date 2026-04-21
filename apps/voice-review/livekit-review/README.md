# LiveKit Review

Standalone TypeScript voice review app for comparing speech providers under one consistent UI.

What it does:
- `TTS Preview` generates a sample clip with the selected TTS provider, voice, and speed
- `Live Call` joins a LiveKit room and talks to an LLM through the selected STT provider -> OpenRouter LLM -> selected TTS provider
- Keeps the existing speed and loudness post-processing so voice comparisons stay apples-to-apples

Currently supported:
- TTS: `Deepgram`, `xAI`
- STT: `Deepgram`, `xAI`
- LLM: `OpenRouter`

## Setup

```bash
cd apps/voice-review/livekit-review
pnpm install --ignore-workspace
cp .env.example .env
pnpm dev
```

Open http://localhost:8101

## Required Environment Variables

- `OPENROUTER_API_KEY`
- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

Provider keys are required only when you select that provider:
- `DEEPGRAM_API_KEY`
- `XAI_API_KEY`

Optional:
- `PORT` defaults to `8101`
- `OPENROUTER_MODEL` defaults to `google/gemini-3-flash-preview`

## Scripts

- `pnpm dev` starts the client build watcher, HTTP server, and LiveKit worker
- `pnpm build` builds the browser bundle and compiles the server and worker to `dist/`
- `pnpm start` runs the compiled server and worker
