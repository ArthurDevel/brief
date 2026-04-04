# Voice Review - LiveKit Deepgram

Standalone TypeScript voice review app for comparing Deepgram Aura 2 voices at different speeds.

Two modes:
- `TTS Preview` generates a sample clip with the selected voice and speed
- `Live Call` joins a LiveKit room and talks to an LLM through Deepgram STT -> OpenRouter LLM -> Deepgram TTS -> WSOLA speed -> RMS normalization

## Setup

```bash
cd apps/voice-review/livekit-deepgram
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:8101

## Required Environment Variables

- `DEEPGRAM_API_KEY`
- `OPENROUTER_API_KEY`
- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`

Optional:
- `PORT` defaults to `8101`
- `OPENROUTER_MODEL` defaults to `google/gemini-3-flash-preview`

## Scripts

- `npm run dev` starts the client build watcher, HTTP server, and LiveKit worker
- `npm run build` builds the browser bundle and compiles the server and worker to `dist/`
- `npm run start` runs the compiled server and worker
