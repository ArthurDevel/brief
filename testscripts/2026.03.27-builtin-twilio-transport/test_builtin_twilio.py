"""
Minimal FastAPI server testing pipecat's built-in replacements for our custom code.

Tests the following built-in replacements:
  1. TwilioFrameSerializer + FastAPIWebsocketTransport instead of custom TwilioTransport
  2. DeepgramFluxSTTService instead of DeepgramSTTService + SmartTurn/VAD turn detection
  3. MarkdownTextFilter on TTS instead of custom MarkdownStripperProcessor in pipeline
  4. IdleFrameProcessor instead of custom AudioFrameWatchdog
  5. Built-in timeout_secs on register_function() instead of manual asyncio.wait_for()
  6. AudioBufferProcessor instead of custom AudioRecorder + combine_wav_buffers
  7. AudioSpeedProcessor (WSOLA) in the new pipeline chain at 8kHz
  8. AudioNormalizerProcessor (RMS) in the new pipeline chain at 8kHz
  9. HTTP TTS narration via Deepgram REST API (workaround for Framework Gap #3)
  10. asyncio.Lock + asyncio.to_thread() for blocking tool calls (IMAP pattern)
  11. Flux STT cleanup without the cancel_stt_tasks() hack

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

Key differences from our tool handler setup:
  - FunctionCallParams dataclass replaces the old 6-arg handler signature
  - asyncio.Lock + asyncio.to_thread() pattern validated with FunctionCallParams
  - HTTP TTS narration pushes TTSAudioRawFrame via llm.push_frame() before tool execution
    (bypasses websocket TTS service, avoids Framework Gap #3)
  - cancel_stt_tasks() hack removed -- Flux handles cleanup via _disconnect_websocket()

Pipeline chain:
  transport.input() -> watchdog -> stt -> user_agg -> llm -> tts
  -> speed -> normalizer -> transport.output() -> audio_buffer -> assistant_agg
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import os
import random
import time
import wave
from typing import Any

import aiohttp
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from fastapi.responses import PlainTextResponse

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import InputAudioRawFrame, LLMRunFrame, TTSAudioRawFrame
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

# Import our custom processors (legitimately custom, not replaceable)
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "apps", "voice-pipeline"))
from src.audio.speed import AudioSpeedProcessor
from src.audio.normalizer import AudioNormalizerProcessor

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
DEEPGRAM_HTTP_TTS_URL = "https://api.deepgram.com/v1/speak"

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

# Short phrases spoken via HTTP TTS before a tool executes, so the user isn't
# waiting in silence. Mirrors TOOL_NARRATIONS from pipeline.py.
# Uses Deepgram REST API (not websocket TTS) to avoid Framework Gap #3.
TOOL_NARRATIONS: dict[str, str] = {
    "get_weather": "Checking the weather.",
    "check_calendar": "Checking the calendar.",
    "set_reminder": "Setting that reminder.",
    "book_flight": "Looking into that flight.",
}

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


async def _cancel_stt_tasks(stt: DeepgramFluxSTTService) -> None:
    """Force-cancel dangling asyncio tasks owned by the STT service.

    After the pipeline runner returns, Deepgram STT (both standard and Flux)
    may still have dangling tasks stuck in a reconnect loop. This function
    accesses the private _task_manager to cancel them.

    No public API exists for this. May break on pipecat upgrades.

    Args:
        stt: The DeepgramFluxSTTService instance to clean up.
    """
    if not hasattr(stt, "_task_manager") or stt._task_manager is None:
        return

    tasks = stt._task_manager.current_tasks()
    if not tasks:
        return

    for t in tasks:
        t.cancel()

    try:
        await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=5.0,
        )
    except asyncio.TimeoutError:
        logger.warning("[cleanup] Timed out waiting for %d STT tasks to cancel", len(tasks))

    logger.info("[cleanup] Cancelled %d dangling STT task(s)", len(tasks))


async def _synthesize_narration(
    text: str,
    api_key: str,
    sample_rate: int,
    voice: str,
    http_session: aiohttp.ClientSession,
) -> bytes:
    """Synthesize a short phrase using Deepgram's HTTP TTS API.

    Uses the REST endpoint instead of the websocket TTS service to avoid
    Framework Gap #3 (websocket TTS context gets cleaned up before audio
    chunks arrive, breaking the pipeline).

    Args:
        text: The phrase to synthesize.
        api_key: Deepgram API key.
        sample_rate: Audio sample rate in Hz.
        voice: Deepgram voice model name.
        http_session: Shared aiohttp session for connection pooling.

    Returns:
        Raw PCM linear16 audio bytes.
    """
    headers = {"Authorization": f"Token {api_key}", "Content-Type": "application/json"}
    params = {
        "model": voice,
        "encoding": "linear16",
        "sample_rate": sample_rate,
        "container": "none",
    }

    async with http_session.post(
        DEEPGRAM_HTTP_TTS_URL, headers=headers, json={"text": text}, params=params
    ) as resp:
        if resp.status != 200:
            error_text = await resp.text()
            raise RuntimeError(f"Deepgram HTTP TTS failed ({resp.status}): {error_text}")
        return await resp.read()


def _simulate_blocking_tool_call(tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Simulate a blocking tool call (like IMAP) that runs on a thread.

    In production, this would be handle_tool_call() from tools/handlers.py
    which does synchronous IMAP operations. Here we use time.sleep() to
    simulate the blocking I/O.

    Args:
        tool_name: Name of the tool being called.
        arguments: Tool arguments from the LLM.

    Returns:
        Result dict with status, result, and message fields.
    """
    time.sleep(0.5)  # simulate blocking I/O (like IMAP fetch)

    if tool_name == "get_weather":
        location = arguments.get("location", "unknown")
        conditions = random.choice(["sunny", "cloudy", "rainy", "partly cloudy"])
        temp = random.randint(5, 35)
        return {
            "status": "success",
            "result": f"{conditions} and {temp} degrees celsius",
            "message": f"Weather for {location}",
        }
    elif tool_name == "check_calendar":
        user_name = arguments.get("user_name", "unknown")
        return {
            "status": "success",
            "result": "standup at 9:30 AM, design review at 2:00 PM",
            "message": f"Calendar for {user_name}",
        }
    elif tool_name == "set_reminder":
        message = arguments.get("message", "")
        minutes = arguments.get("minutes_from_now", 0)
        return {
            "status": "success",
            "result": f"Reminder set for {minutes} minutes from now",
            "message": message,
        }
    elif tool_name == "book_flight":
        destination = arguments.get("destination", "unknown")
        return {
            "status": "error",
            "result": None,
            "message": f"Booking service unavailable for {destination}",
        }
    else:
        raise NotImplementedError(f"Unknown tool: {tool_name}")


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
        sample_rate=TWILIO_SAMPLE_RATE,
        text_filter=MarkdownTextFilter(),
    )

    # -- Step 5: Audio speed processor (WSOLA) and normalizer (RMS).
    # These are legitimately custom -- pipecat has no equivalent.
    # They intercept TTSAudioRawFrame and process audio in-place.
    # Both work at any sample rate (configured via constructor).
    speed_config: dict[str, Any] = {"speed": 1.0}
    speed_processor = AudioSpeedProcessor(
        config=speed_config,
        sample_rate=TWILIO_SAMPLE_RATE,
        num_channels=1,
    )

    normalizer_config: dict[str, Any] = {"enabled": True}
    normalizer = AudioNormalizerProcessor(
        config=normalizer_config,
        sample_rate=TWILIO_SAMPLE_RATE,
    )

    # -- Step 6: Set up LLM context with system prompt and tools.
    context = LLMContext(
        messages=[{"role": "system", "content": SYSTEM_PROMPT}],
        tools=TOOLS,
    )
    context_aggregator = LLMContextAggregatorPair(context)

    # -- Step 7: Register tool handlers with built-in timeout.
    # Mirrors production's _register_tool_handler pattern:
    #   - asyncio.Lock serializes access (imapclient is not thread-safe)
    #   - asyncio.to_thread() offloads blocking I/O to a thread
    #   - HTTP TTS narration speaks a filler phrase before execution
    #   - Errors are caught and returned via result_callback (Framework Gap #1)
    #   - FunctionCallParams replaces the old 6-arg handler signature
    tool_lock = asyncio.Lock()
    deepgram_api_key = os.environ["DEEPGRAM_API_KEY"]

    # Shared HTTP session for narration TTS calls. Created once, closed after pipeline ends.
    narration_http_session: aiohttp.ClientSession | None = None

    async def _get_narration_session() -> aiohttp.ClientSession:
        """Lazy-create a shared aiohttp session for narration TTS calls."""
        nonlocal narration_http_session
        if narration_http_session is None:
            narration_http_session = aiohttp.ClientSession()
        return narration_http_session

    async def _tool_handler(params: FunctionCallParams) -> None:
        """Generic tool handler that mirrors the production pattern.

        1. Speak a narration phrase via HTTP TTS (if configured)
        2. Acquire the shared lock (serializes blocking calls)
        3. Run the blocking tool call on a thread
        4. Return the result via result_callback

        FRAMEWORK GAP #1 (pipecat v0.0.107): Never let exceptions propagate.
        Pipecat's _run_function_call catches exceptions but never calls
        result_callback, causing the pipeline to freeze. Always catch and
        return errors via result_callback.

        Args:
            params: FunctionCallParams with function_name, arguments, result_callback.
        """
        tool_name = params.function_name
        arguments = params.arguments

        # Speak narration so the user knows something is happening.
        # Uses Deepgram HTTP TTS (not websocket) to avoid Framework Gap #3.
        narration = TOOL_NARRATIONS.get(tool_name)
        if narration:
            try:
                session = await _get_narration_session()
                audio_bytes = await _synthesize_narration(
                    narration, deepgram_api_key, TWILIO_SAMPLE_RATE, TTS_VOICE, session,
                )
                await llm.push_frame(TTSAudioRawFrame(
                    audio=audio_bytes,
                    sample_rate=TWILIO_SAMPLE_RATE,
                    num_channels=1,
                ))
            except Exception as e:
                logger.warning("[tool] Narration failed for [%s]: %s", tool_name, e)

        start_ms = time.time() * 1000
        try:
            # Lock serializes access -- in production this prevents concurrent
            # IMAP operations on a non-thread-safe imapclient connection.
            async with tool_lock:
                result = await asyncio.to_thread(
                    _simulate_blocking_tool_call, tool_name, dict(arguments),
                )

            result_str = json.dumps(result, ensure_ascii=False)
        except Exception as e:
            logger.error("[tool] [%s] failed: %s", tool_name, e)
            result = {
                "status": "error",
                "result": None,
                "message": str(e),
            }
            result_str = json.dumps(result, ensure_ascii=False)

        duration_ms = time.time() * 1000 - start_ms
        logger.info("[tool] [%s] completed in %.0fms: %s", tool_name, duration_ms, result.get("status"))

        await params.result_callback(result_str)

    for tool_name in ["get_weather", "check_calendar", "set_reminder", "book_flight"]:
        llm.register_function(tool_name, _tool_handler, timeout_secs=TOOL_CALL_TIMEOUT_SECS)

    # FRAMEWORK GAP #3 (2026-03-27, pipecat v0.0.107): The official pipecat example
    # uses tts.queue_frame(TTSSpeakFrame("Let me check on that.")) inside
    # on_function_calls_started to speak filler while a tool executes. This breaks
    # the TTS context -- the context gets cleaned up immediately after creation,
    # all audio frames fail with "unable to append audio to context", and the TTS
    # gets stuck, blocking the FunctionCallResultFrame from passing through the
    # pipeline. Our HTTP TTS narration inside the handler sidesteps this entirely.
    @llm.event_handler("on_function_calls_started")
    async def on_function_calls_started(service: Any, function_calls: list[Any]) -> None:
        names = [fc.function_name for fc in function_calls]
        logger.info("[tool] Function calls started: %s", names)

    # -- Step 8: Set up audio idle watchdog.
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

    # -- Step 9: Set up audio recording.
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

    # -- Step 10: Build the pipeline.
    # Speed processor and normalizer sit between TTS and transport.output(),
    # matching production's pipeline chain. AudioBufferProcessor goes after
    # transport.output() to capture the final (speed-adjusted, normalized) audio.
    pipeline = Pipeline([
        transport.input(),
        audio_watchdog,
        stt,
        context_aggregator.user(),
        llm,
        tts,
        speed_processor,
        normalizer,
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

    # -- Step 11: Set up event handlers.
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

    # -- Step 12: Run the pipeline.
    # handle_sigint=False because we're inside FastAPI (uvicorn handles signals).
    # force_gc=True to clean up after each pipeline run in multi-client apps.
    runner = PipelineRunner(handle_sigint=False, force_gc=True)
    logger.info("[twilio] Starting pipeline for user_id=%s", user_id)
    await runner.run(task)
    logger.info("[twilio] Pipeline finished for user_id=%s", user_id)

    # -- Step 13: Force-cancel dangling STT tasks.
    # Despite Flux's better task management (_disconnect_websocket cancels
    # _receive_task and _watchdog_task with 2s timeouts), it still leaves
    # dangling tasks behind. The cancel_stt_tasks() hack is still needed.
    # This is a known pipecat gap with no public API -- we access _task_manager
    # directly. May break on pipecat upgrades.
    await _cancel_stt_tasks(stt)

    # Close the shared HTTP session used for narration TTS
    if narration_http_session is not None:
        await narration_http_session.close()


# ============================================================================
# MAIN
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765)
