# Voice Review - Pipecat Deepgram

Compare Deepgram Aura 2 voices at different speeds with production-matching WSOLA processing.

Two modes:
- **TTS Preview** -- generate and play back a text sample with a selected voice + speed
- **Live Call** -- talk to an LLM through the full pipeline (STT -> LLM -> TTS -> WSOLA -> normalizer)

## Setup

```bash
cd apps/voice-review/pipecat-deepgram
pip install -r requirements.txt
uvicorn server:app --reload --port 8100
```

Requires `.env` with `DEEPGRAM_API_KEY` and `OPENROUTER_API_KEY` (copied from voice-pipeline).

Open http://localhost:8100
