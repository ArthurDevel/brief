# Voice Pipeline Test (Pipecat + WebRTC)

STT (Deepgram Nova-2) → LLM (OpenRouter/Gemini Flash) → TTS (Deepgram Aura 2), streamed end-to-end over WebRTC. Browser handles echo cancellation natively, so interruptions work without picking up the bot's own voice.

Uses Smart Turn v3 for prosody-based endpointing (not silence-based) and MinWords filtering to ignore backchannels. Includes a cost tracker that prints per-session and per-minute cost breakdown.

## Setup

```bash
# Create venv and install deps
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Configure API keys
cp .env.example .env
# Edit .env with your DEEPGRAM_API_KEY and OPENROUTER_API_KEY
```

## Run

```bash
source .venv/bin/activate
python voice_pipeline.py
```

Open **http://localhost:7860/client** in your browser and click the mic button to start talking.
