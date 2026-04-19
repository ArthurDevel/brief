# Voice Review - Pipecat Deepgram

Compare Deepgram Aura 2 voices at different speeds with production-matching WSOLA processing.

Two modes:
- **TTS Preview** -- generate and play back a text sample with a selected voice + speed
- **Live Call** -- talk to an LLM through the full pipeline (STT -> LLM -> TTS -> WSOLA -> normalizer)
  - **Open Conversation** keeps the call free-form
  - **Demo Mode** injects a short demo brief into the system prompt so the LLM produces more directed, qualitative samples without tool calls
  - **Call My Phone** starts an outbound Twilio call that runs the same demo configuration over Twilio Media Streams

Recordings:
- Every live call writes separate `user` and `bot` WAV files to `~/Downloads`
- This applies to both browser WebRTC calls and Twilio phone demos

## Setup

```bash
cd apps/voice-review/pipecat-deepgram
pip install -r requirements.txt
uvicorn server:app --reload --port 8100
```

For local Twilio testing, prefer:

```bash
./dev-server-start.sh
```

That starts the server behind a Cloudflare tunnel and overrides `PUBLIC_URL`
for the running process so Twilio can reach the outbound callback and media stream.

If you specifically want to use a disposable quick tunnel instead, run:

```bash
./dev-server-start.sh --quick-tunnel
```

Requires `.env` with `DEEPGRAM_API_KEY` and `OPENROUTER_API_KEY`.

For Twilio phone demos, also set:
- `PUBLIC_URL` to an HTTPS URL Twilio can reach
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

Open http://localhost:8100
