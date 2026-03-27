"""
Minimal FastAPI server testing pipecat's built-in Twilio transport approach.

Tests two built-in replacements for our custom code:
  1. TwilioFrameSerializer + FastAPIWebsocketTransport instead of custom TwilioTransport
  2. DeepgramFluxSTTService instead of DeepgramSTTService + SmartTurn/VAD turn detection

Key differences from our custom transport (apps/voice-pipeline/src/transports/twilio.py):
  - No manual mulaw<->PCM16 transcoding -- TwilioFrameSerializer uses SOXR internally
  - No custom read loop -- FastAPIWebsocketTransport handles the WebSocket lifecycle
  - No buffered_messages pattern -- parse_telephony_websocket() consumes the early
    messages, then the transport's receive loop picks up from there
  - No set_pipeline_task() -- on_client_disconnected event handler cancels instead

Key differences from our STT + turn detection setup:
  - No SmartTurn v3 or SileroVAD-based turn detection -- Flux handles it natively
  - Flux emits UserStartedSpeakingFrame/UserStoppedSpeakingFrame directly
  - VAD disabled on transport since Flux manages turn boundaries
"""

from __future__ import annotations

import logging
import os
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.responses import PlainTextResponse
from openai.types.chat import (
    ChatCompletionSystemMessageParam,
    ChatCompletionUserMessageParam,
)

from pipecat.frames.frames import LLMMessagesFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.runner.utils import parse_telephony_websocket
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("test_builtin_twilio")

app = FastAPI()


# ============================================================================
# CONSTANTS
# ============================================================================

PIPELINE_SAMPLE_RATE = 16000
SYSTEM_PROMPT = "You are a helpful voice assistant. Keep responses brief."
TTS_VOICE = "aura-2-thalia-en"
LLM_MODEL = "google/gemini-2.5-flash"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


# ============================================================================
# ENDPOINTS
# ============================================================================

@app.get("/")
async def health() -> PlainTextResponse:
    """Health check endpoint."""
    return PlainTextResponse("ok")


@app.websocket("/twilio-stream")
async def twilio_stream(websocket: WebSocket) -> None:
    """Handle an incoming Twilio media stream WebSocket connection.

    This is the main entry point. It:
    1. Accepts the WebSocket
    2. Reads the first messages to extract stream_sid, call_sid, userId
    3. Builds a pipeline with the built-in Twilio serializer + transport
    4. Runs the pipeline until the client disconnects

    Args:
        websocket: The incoming FastAPI WebSocket connection from Twilio.
    """
    await websocket.accept()
    logger.info("[twilio] WebSocket accepted")

    # -- Step 1: Extract Twilio metadata from the first few messages.
    # parse_telephony_websocket() reads the "connected" and "start" messages,
    # returning a tuple of (transport_type, call_data).
    # After this call, subsequent messages flow through the transport's receive loop.
    # This replaces our custom "buffered_messages" pattern.
    _transport_type, call_data = await parse_telephony_websocket(websocket)
    stream_sid: str = call_data.get("stream_id", "")
    call_sid: str = call_data.get("call_id", "")

    # Extract userId from Twilio's customParameters (nested in "body")
    body: dict[str, Any] = call_data.get("body", {})
    user_id: str = body.get("userId", "unknown")

    logger.info(
        "[twilio] Stream metadata: stream_sid=%s, call_sid=%s, user_id=%s",
        stream_sid, call_sid, user_id,
    )

    # -- Step 2: Create the serializer.
    # TwilioFrameSerializer handles mulaw 8kHz <-> PCM16 transcoding using SOXR
    # (better quality than our custom linear interpolation).
    # It also sends {"event": "clear"} on InterruptionFrame automatically.
    serializer = TwilioFrameSerializer(
        stream_sid=stream_sid,
        params=TwilioFrameSerializer.InputParams(auto_hang_up=False),
    )

    # -- Step 3: Create the built-in transport.
    # FastAPIWebsocketTransport wraps the WebSocket with a receive loop and
    # uses the serializer for frame conversion. This replaces our entire
    # TwilioInputTransport + TwilioOutputTransport (~200 lines).
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=PIPELINE_SAMPLE_RATE,
            audio_out_sample_rate=PIPELINE_SAMPLE_RATE,
            vad_enabled=False,
            serializer=serializer,
        ),
    )

    # -- Step 4: Create pipeline services.
    stt = DeepgramFluxSTTService(
        api_key=os.environ["DEEPGRAM_API_KEY"],
    )

    llm = OpenAILLMService(
        api_key=os.environ["OPENROUTER_API_KEY"],
        base_url=OPENROUTER_BASE_URL,
        model=LLM_MODEL,
    )

    tts = DeepgramTTSService(
        api_key=os.environ["DEEPGRAM_API_KEY"],
        voice=TTS_VOICE,
    )

    # -- Step 5: Set up LLM context with system prompt.
    system_message = ChatCompletionSystemMessageParam(role="system", content=SYSTEM_PROMPT)
    context = OpenAILLMContext([system_message])
    context_aggregator = llm.create_context_aggregator(context)

    # -- Step 6: Build the pipeline.
    pipeline = Pipeline([
        transport.input(),
        stt,
        context_aggregator.user(),
        llm,
        tts,
        transport.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
        ),
    )

    # -- Step 7: Set up event handlers.
    # on_client_connected: send a greeting so the user hears something immediately.
    # This replaces our manual "push LLMMessagesFrame after pipeline start" pattern.
    @transport.event_handler("on_client_connected")
    async def on_connected(transport_instance: Any, client: Any) -> None:
        logger.info("[twilio] Client connected, sending greeting")
        greeting_messages = [
            ChatCompletionSystemMessageParam(role="system", content=SYSTEM_PROMPT),
            ChatCompletionUserMessageParam(
                role="user", content="Say hello and introduce yourself briefly."
            ),
        ]
        await task.queue_frames([LLMMessagesFrame(greeting_messages)])

    # on_client_disconnected: cancel the pipeline task.
    # This replaces our custom set_pipeline_task() + cancel pattern in the read loop.
    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(transport_instance: Any, client: Any) -> None:
        logger.info("[twilio] Client disconnected, cancelling pipeline")
        await task.cancel()

    # -- Step 8: Run the pipeline.
    # handle_sigint=False because we're inside FastAPI (uvicorn handles signals).
    runner = PipelineRunner(handle_sigint=False)
    logger.info("[twilio] Starting pipeline for user_id=%s", user_id)
    await runner.run(task)
    logger.info("[twilio] Pipeline finished for user_id=%s", user_id)


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765)
