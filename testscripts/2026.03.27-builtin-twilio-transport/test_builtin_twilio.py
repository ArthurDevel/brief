"""
Minimal FastAPI server testing pipecat's built-in replacements for our custom code.

Tests the following built-in replacements:
  1. TwilioFrameSerializer + FastAPIWebsocketTransport instead of custom TwilioTransport
  2. DeepgramFluxSTTService instead of DeepgramSTTService + SmartTurn/VAD turn detection
  3. MarkdownTextFilter on TTS instead of custom MarkdownStripperProcessor in pipeline
  4. IdleFrameProcessor instead of custom AudioFrameWatchdog
  5. Built-in timeout_secs on register_function() instead of manual asyncio.wait_for()
  6. AudioBufferProcessor instead of custom AudioRecorder + combine_wav_buffers

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

Key differences from our custom processors:
  - No MarkdownStripperProcessor in the pipeline chain -- MarkdownTextFilter integrates
    directly into the TTS service, handling more cases (code blocks, tables, HTML)
  - No AudioFrameWatchdog with manual background task -- IdleFrameProcessor provides
    the same timeout-based cancellation with a simpler callback API
  - No asyncio.wait_for() wrapper around tool handlers -- register_function() accepts
    timeout_secs directly, removing the need for manual timeout management
  - No two AudioRecorder instances + combine_wav_buffers -- AudioBufferProcessor handles
    user/bot track separation, buffer synchronization (silence padding), and mixing
    natively. Only WAV wrapping + upload remain custom.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import random
import wave
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.responses import PlainTextResponse

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import InputAudioRawFrame, LLMRunFrame
from pipecat.services.llm_service import FunctionCallParams
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from pipecat.processors.idle_frame_processor import IdleFrameProcessor
from pipecat.runner.utils import parse_telephony_websocket
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("test_builtin_twilio")

app = FastAPI()


# ============================================================================
# CONSTANTS
# ============================================================================

TWILIO_SAMPLE_RATE = 8000
SYSTEM_PROMPT = (
    "You are a helpful voice assistant. Keep responses brief. "
    "You have access to tools: get_weather (get current weather for a city), "
    "check_calendar (check today's calendar events for a user), "
    "set_reminder (set a reminder for the user), "
    "and book_flight (book a flight to a destination). "
    "Use them when the user asks about weather, their schedule, reminders, or flights."
)
TTS_VOICE = "aura-2-thalia-en"
LLM_MODEL = "google/gemini-2.5-flash"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Timeout for audio watchdog -- cancels pipeline if no audio arrives for this long.
# Replaces our custom AudioFrameWatchdog (src/audio/watchdog.py).
AUDIO_IDLE_TIMEOUT_SECS = 10.0

# Timeout for tool call execution -- must be shorter than pipecat's default 10s
# function_call_timeout_secs so our handler returns a proper error first.
# Replaces our manual asyncio.wait_for() wrapper in pipeline.py.
TOOL_CALL_TIMEOUT_SECS = 8.0

# Directory for saving recordings in this test script.
# In production, recordings are uploaded to Supabase Storage instead.
RECORDINGS_DIR = "output"

# Tool definitions for testing register_function() with timeout_secs.
TOOLS = ToolsSchema(
    standard_tools=[
        FunctionSchema(
            name="get_weather",
            description="Get the current weather for a city.",
            properties={
                "location": {
                    "type": "string",
                    "description": "City name, e.g. 'San Francisco'",
                },
            },
            required=["location"],
        ),
        FunctionSchema(
            name="check_calendar",
            description="Check today's calendar events for a user.",
            properties={
                "user_name": {
                    "type": "string",
                    "description": "The name of the user to check the calendar for.",
                },
            },
            required=["user_name"],
        ),
        FunctionSchema(
            name="set_reminder",
            description="Set a reminder for the user.",
            properties={
                "message": {
                    "type": "string",
                    "description": "The reminder message.",
                },
                "minutes_from_now": {
                    "type": "integer",
                    "description": "How many minutes from now the reminder should fire.",
                },
            },
            required=["message", "minutes_from_now"],
        ),
        FunctionSchema(
            name="book_flight",
            description="Book a flight to a destination. This is a test tool that always fails.",
            properties={
                "destination": {
                    "type": "string",
                    "description": "The destination city, e.g. 'Tokyo'",
                },
            },
            required=["destination"],
        ),
    ],
)


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _write_wav(pcm_data: bytes, sample_rate: int, num_channels: int) -> bytes:
    """Write raw PCM16 data into a complete WAV file.

    Args:
        pcm_data: Raw PCM16 audio bytes.
        sample_rate: Audio sample rate in Hz.
        num_channels: Number of audio channels.

    Returns:
        Complete WAV file as bytes.
    """
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(num_channels)
        wf.setsampwidth(2)  # 2 bytes per sample (PCM16)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return buf.getvalue()


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
    4. Runs the pipeline until the client disconnects or audio times out

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
        call_sid=call_sid,
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

    # MarkdownTextFilter integrates directly into the TTS service.
    # Replaces our custom MarkdownStripperProcessor (src/audio/markdown_stripper.py)
    # which was a separate pipeline processor. The built-in handles more cases
    # (code blocks, tables, HTML tags) and doesn't need a spot in the pipeline chain.
    tts = DeepgramTTSService(
        api_key=os.environ["DEEPGRAM_API_KEY"],
        voice=TTS_VOICE,
        text_filter=MarkdownTextFilter(),
    )

    # -- Step 5: Set up LLM context with system prompt and tools.
    context = LLMContext(
        messages=[{"role": "system", "content": SYSTEM_PROMPT}],
        tools=TOOLS,
    )
    context_aggregator = LLMContextAggregatorPair(context)

    # -- Step 6: Register tool handlers with built-in timeout.
    # Replaces our manual asyncio.wait_for() wrapper in pipeline.py.
    # timeout_secs is passed directly to register_function() -- pipecat handles
    # the timeout internally, removing the need for custom timeout management.

    async def handle_get_weather(params: FunctionCallParams) -> None:
        """Mock weather lookup. Simulates a short API delay."""
        location = params.arguments.get("location", "unknown")
        logger.info("[tool] get_weather called for location=%s", location)
        await asyncio.sleep(0.5)  # simulate API call
        conditions = random.choice(["sunny", "cloudy", "rainy", "partly cloudy"])
        temp = random.randint(5, 35)
        await params.result_callback(
            f"{conditions} and {temp} degrees celsius in {location}."
        )

    async def handle_check_calendar(params: FunctionCallParams) -> None:
        """Mock calendar lookup. Returns fake events."""
        user_name = params.arguments.get("user_name", "unknown")
        logger.info("[tool] check_calendar called for user_name=%s", user_name)
        await asyncio.sleep(0.3)  # simulate DB query
        await params.result_callback(
            f"{user_name} has 2 events today: "
            "standup at 9:30 AM and a design review at 2:00 PM."
        )

    async def handle_set_reminder(params: FunctionCallParams) -> None:
        """Mock reminder setter. Logs the reminder and confirms."""
        message = params.arguments.get("message", "")
        minutes = params.arguments.get("minutes_from_now", 0)
        logger.info("[tool] set_reminder: '%s' in %d minutes", message, minutes)
        await params.result_callback(
            f"Reminder set: '{message}' in {minutes} minutes."
        )

    async def handle_book_flight(params: FunctionCallParams) -> None:
        """Mock flight booking that always fails.

        Returns the error via result_callback so the LLM can inform the user.

        FRAMEWORK GAP #1 (2026-03-27, pipecat v0.0.107): Raising an exception here
        would cause the pipeline to freeze. Pipecat's _run_function_call catches
        the exception and pushes a non-fatal ErrorFrame, but never calls
        result_callback. The function call stays stuck in _function_calls_in_progress
        forever, and the LLM never gets a tool result back.
        Workaround: always catch errors inside the handler and return them via
        result_callback. Never let exceptions propagate out of a tool handler.
        See: https://github.com/pipecat-ai/pipecat/issues/1735
        See: https://github.com/pipecat-ai/pipecat/issues/2179

        FRAMEWORK GAP #2 (2026-03-27, pipecat v0.0.107): Tool handlers that complete
        instantly cause a race condition. The FunctionCallResultFrame arrives at the
        assistant aggregator before the FunctionCallsStartedFrame (which must travel
        through the full pipeline: LLM -> TTS -> transport -> audio_buffer ->
        aggregator). The aggregator drops the result because the tool_call_id is not
        yet in _function_calls_in_progress, and the pipeline freezes.
        Workaround: yield to the event loop (asyncio.sleep(0)) so the started frame
        propagates first.
        See: https://github.com/pipecat-ai/pipecat/issues/3661
        """
        destination = params.arguments.get("destination", "unknown")
        logger.info("[tool] book_flight called for destination=%s", destination)

        # Yield to event loop so FunctionCallsStartedFrame reaches the aggregator
        # before our result does. See FRAMEWORK GAP #2 above.
        await asyncio.sleep(0)

        await params.result_callback(
            f"ERROR: Booking service is currently unavailable for {destination}. "
            "Please try again later."
        )

    llm.register_function("get_weather", handle_get_weather, timeout_secs=TOOL_CALL_TIMEOUT_SECS)
    llm.register_function("check_calendar", handle_check_calendar, timeout_secs=TOOL_CALL_TIMEOUT_SECS)
    llm.register_function("set_reminder", handle_set_reminder, timeout_secs=TOOL_CALL_TIMEOUT_SECS)
    llm.register_function("book_flight", handle_book_flight, timeout_secs=TOOL_CALL_TIMEOUT_SECS)

    # FRAMEWORK GAP #3 (2026-03-27, pipecat v0.0.107): The official pipecat example
    # uses tts.queue_frame(TTSSpeakFrame("Let me check on that.")) inside
    # on_function_calls_started to speak filler while a tool executes. This breaks
    # the TTS context -- the context gets cleaned up immediately after creation,
    # all audio frames fail with "unable to append audio to context", and the TTS
    # gets stuck, blocking the FunctionCallResultFrame from passing through the
    # pipeline. Removing the TTSSpeakFrame fixes the freeze. The official example
    # likely only works when function calls take significant time (real API calls).
    @llm.event_handler("on_function_calls_started")
    async def on_function_calls_started(service: Any, function_calls: list[Any]) -> None:
        names = [fc.function_name for fc in function_calls]
        logger.info("[tool] Function calls started: %s", names)

    # -- Step 7: Set up audio idle watchdog.
    # IdleFrameProcessor replaces our custom AudioFrameWatchdog (src/audio/watchdog.py).
    # It monitors InputAudioRawFrame arrival and fires the callback after timeout.
    # No manual background task or set_task() wiring needed.
    async def on_audio_idle(processor: IdleFrameProcessor) -> None:
        logger.warning("[watchdog] No audio for %.0fs, cancelling pipeline", AUDIO_IDLE_TIMEOUT_SECS)
        await task.cancel()

    audio_watchdog = IdleFrameProcessor(
        callback=on_audio_idle,
        timeout=AUDIO_IDLE_TIMEOUT_SECS,
        types=[InputAudioRawFrame],
    )

    # -- Step 8: Set up audio recording.
    # AudioBufferProcessor replaces our two custom AudioRecorder instances + combine_wav_buffers
    # (src/audio/recorder.py). It handles:
    #   - Separate user/bot track capture (via on_track_audio_data event)
    #   - Buffer synchronization (pads shorter track with silence automatically)
    #   - Merged/mixed audio output (via on_audio_data event)
    # Only WAV wrapping and upload remain custom.
    audio_buffer = AudioBufferProcessor(
        sample_rate=TWILIO_SAMPLE_RATE,
        num_channels=1,
    )

    @audio_buffer.event_handler("on_audio_data")
    async def on_audio_data(
        buffer: AudioBufferProcessor,
        audio: bytes,
        sample_rate: int,
        num_channels: int,
    ) -> None:
        """Save merged (user + bot) audio as a WAV file.

        In production, this would upload to Supabase Storage instead of saving locally.
        """
        if not audio:
            return
        wav_bytes = _write_wav(audio, sample_rate, num_channels)
        filepath = os.path.join(RECORDINGS_DIR, f"{call_sid}.wav")
        with open(filepath, "wb") as f:
            f.write(wav_bytes)
        logger.info("[recorder] Saved merged recording: %s (%d bytes)", filepath, len(wav_bytes))

    @audio_buffer.event_handler("on_track_audio_data")
    async def on_track_audio_data(
        buffer: AudioBufferProcessor,
        user_audio: bytes,
        bot_audio: bytes,
        sample_rate: int,
        num_channels: int,
    ) -> None:
        """Save separate user and bot audio tracks as WAV files."""
        for label, audio_data in [("user", user_audio), ("bot", bot_audio)]:
            if not audio_data:
                continue
            wav_bytes = _write_wav(audio_data, sample_rate, 1)
            filepath = os.path.join(RECORDINGS_DIR, f"{call_sid}_{label}.wav")
            with open(filepath, "wb") as f:
                f.write(wav_bytes)
            logger.info("[recorder] Saved %s track: %s (%d bytes)", label, filepath, len(wav_bytes))

    # -- Step 9: Build the pipeline.
    # AudioBufferProcessor goes after transport.output() to capture both user and bot audio.
    # This matches the placement in pipecat's official examples.
    pipeline = Pipeline([
        transport.input(),
        audio_watchdog,
        stt,
        context_aggregator.user(),
        llm,
        tts,
        transport.output(),
        audio_buffer,
        context_aggregator.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=TWILIO_SAMPLE_RATE,
            audio_out_sample_rate=TWILIO_SAMPLE_RATE,
            enable_metrics=True,
        ),
    )

    # -- Step 10: Set up event handlers.
    # on_client_connected: start recording and send a greeting.
    @transport.event_handler("on_client_connected")
    async def on_connected(transport_instance: Any, client: Any) -> None:
        logger.info("[twilio] Client connected, sending greeting")
        await audio_buffer.start_recording()
        context.add_message({"role": "user", "content": "Say hello and introduce yourself briefly."})
        await task.queue_frames([LLMRunFrame()])

    # on_client_disconnected: cancel the pipeline task.
    # AudioBufferProcessor auto-stops recording on CancelFrame/EndFrame,
    # which triggers the on_audio_data and on_track_audio_data events.
    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(transport_instance: Any, client: Any) -> None:
        logger.info("[twilio] Client disconnected, cancelling pipeline")
        await task.cancel()

    # -- Step 11: Run the pipeline.
    # handle_sigint=False because we're inside FastAPI (uvicorn handles signals).
    # force_gc=True to clean up after each pipeline run in multi-client apps.
    runner = PipelineRunner(handle_sigint=False, force_gc=True)
    logger.info("[twilio] Starting pipeline for user_id=%s", user_id)
    await runner.run(task)
    logger.info("[twilio] Pipeline finished for user_id=%s", user_id)


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765)
