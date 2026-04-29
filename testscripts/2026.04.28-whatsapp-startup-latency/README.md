# WhatsApp Startup Latency Testscript

Draft notebook-style investigation for WhatsApp initial greeting latency. This is not part of the regular automated test suite and does not import from the main app.

## Goal

Measure the startup phases that affect how quickly a user hears the first greeting:

- Optional OpenRouter chat completion latency with a `send_message_to_user` tool schema.
- xAI TTS latency to response headers, first PCM audio chunk, and full response.
- Optional Deepgram TTS comparison when enabled.
- Estimated initial greeting path totals: OpenRouter full response + TTS first/full audio.

The script writes a timestamped JSON report to `output/` and prints a concise phase table in the terminal.

## How To Run

```bash
cd /Users/Focus/conductor/workspaces/brief/vancouver-v2/testscripts/2026.04.28-whatsapp-startup-latency
pnpm measure
```

The script uses Node's built-in `fetch`, `fs`, and `performance.now()`. No runtime dependencies are required.

## Environment Variables

Copy `.env.example` to `.env` or edit the included placeholder `.env`.

| Variable | Default | Notes |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | blank | Required when `RUN_OPENROUTER=true`. |
| `OPENROUTER_MODEL` | `google/gemini-3-flash-preview` | Model used for the chat completion test. |
| `XAI_API_KEY` | blank | Required when `RUN_XAI_TTS=true`. |
| `XAI_VOICE` | `ara` | xAI voice id. |
| `XAI_SAMPLE_RATE` | `24000` | xAI output sample rate. |
| `GREETING_TEXT` | `Hi, this is Brief. How can I help?` | Greeting text sent to TTS providers. |
| `RUN_OPENROUTER` | `true` | Enables OpenRouter measurement. |
| `RUN_XAI_TTS` | `true` | Enables xAI TTS measurement. |
| `RUN_DEEPGRAM_TTS` | `false` | Enables Deepgram TTS comparison. |
| `DEEPGRAM_API_KEY` | blank | Required when `RUN_DEEPGRAM_TTS=true`. |
| `DEEPGRAM_MODEL` | `aura-2-andromeda-en` | Deepgram TTS model. |

## Caveats

This is a small latency notebook, not a production benchmark. Results are affected by local network conditions, provider load, model cold starts, and account-specific routing.

The xAI request uses PCM output to match the deployed WhatsApp agent path, where audio must pass through our post-processing before LiveKit playback.

## Current Result

Ran locally on 2026-04-28 with OpenRouter, xAI TTS, and Deepgram TTS enabled.

```text
openrouter_chat_completion   full response: 1038.11ms
xai_tts                      first chunk: 637.05ms, full response: 1230.29ms
deepgram_tts                 first chunk: 433.65ms, full response: 1217.78ms
```

Estimated startup greeting provider time:

```text
OpenRouter full response + xAI first audio chunk: 1675.16ms
OpenRouter full response + xAI full audio:        2268.4ms
OpenRouter full response + Deepgram first audio: 1471.76ms
OpenRouter full response + Deepgram full audio:  2255.89ms
```

This does not explain a 10 second phone-side silence by provider API latency alone. The remaining suspects are LiveKit `onEnter` scheduling, `session.say().waitForPlayout()` behavior, audio post-processing/framing, LiveKit-to-WhatsApp bridge buffering, or WhatsApp media playback startup.
