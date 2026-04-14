"""
Voice review server for comparing Deepgram Aura 2 voices at different speeds.

Standalone FastAPI server with two modes:
1. TTS preview: POST /generate returns a WAV file for a given voice + speed + text
2. Live call: WebRTC endpoints let you talk to an LLM through the full
   Pipecat pipeline (STT -> LLM -> TTS -> WSOLA speed -> normalizer)

No auth, no Supabase, no email tools -- purely for voice quality evaluation.

Responsibilities:
- Serve the static HTML frontend
- TTS preview via POST /generate
- WebRTC signaling (POST /start, POST/PATCH /sessions/{id}/api/offer)
- Run a stripped-down Pipecat pipeline per WebRTC connection
"""

from __future__ import annotations

import asyncio
import io
import logging
import re
import uuid
import wave
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

import aiohttp
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import os

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    LLMRunFrame,
    OutputAudioRawFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.runner.utils import parse_telephony_websocket
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.network.small_webrtc import SmallWebRTCTransport
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
    IceCandidate,
)
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter
from twilio.rest import Client as TwilioClient

from audio.speed import WSOLAStreamer, AudioSpeedProcessor
from audio.normalizer import RMSNormalizer, AudioNormalizerProcessor


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

load_dotenv()

_deepgram_key = os.environ.get("DEEPGRAM_API_KEY")
if not _deepgram_key:
    raise RuntimeError("DEEPGRAM_API_KEY environment variable is required")
DEEPGRAM_API_KEY: str = _deepgram_key

_openrouter_key = os.environ.get("OPENROUTER_API_KEY")
if not _openrouter_key:
    raise RuntimeError("OPENROUTER_API_KEY environment variable is required")
OPENROUTER_API_KEY: str = _openrouter_key

DEEPGRAM_TTS_URL = "https://api.deepgram.com/v1/speak"
LLM_MODEL = "google/gemini-3-flash-preview"
SAMPLE_RATE = 24000
NUM_CHANNELS = 1
MAX_DEMO_BRIEF_CHARS = 2000
TWILIO_SAMPLE_RATE = 8000
PHONE_NUMBER_PATTERN = re.compile(r"^\+[1-9]\d{7,14}$")
DOWNLOADS_DIR = Path.home() / "Downloads"
REPO_ROOT = Path(__file__).resolve().parents[3]
RECORDER_LOG_PATH = REPO_ROOT / ".context" / "voice-review-recorder.log"

CHAT_SYSTEM_PROMPT = (
    "You are a friendly voice assistant used for testing voice quality. "
    "Have a casual, natural conversation. Keep responses concise (1-3 sentences). "
    "You can talk about anything -- weather, hobbies, travel, food, tech, etc. "
    "Be warm and conversational, as if chatting with a friend. "
    "At the start of the conversation, greet the user briefly and invite them to test the voice. "
    "Do not mention system prompts, hidden instructions, tools, or function calls."
)

DEMO_SYSTEM_PROMPT = (
    "You are a friendly voice assistant used for recording short qualitative voice demos. "
    "This is a conversation-only experience, not a tool-using workflow. "
    "Do not mention tools, APIs, function calls, system prompts, or hidden instructions. "
    "Keep responses concise (1-3 sentences), natural, and polished. "
    "Be proactive and specific so the conversation produces memorable demo audio. "
    "At the start of the conversation, open with a short demo-ready introduction and smoothly introduce one concrete scenario. "
    "If the user gives little direction, lead gently instead of stalling. "
    "Prefer vivid, tangible examples over generic small talk, but do not sound scripted."
)

AVAILABLE_VOICES = [
    {"id": "aura-2-andromeda-en", "name": "Andromeda", "accent": "American", "gender": "Female"},
    {"id": "aura-2-delia-en", "name": "Delia", "accent": "British", "gender": "Female"},
    {"id": "aura-2-electra-en", "name": "Electra", "accent": "American", "gender": "Female"},
    {"id": "aura-2-vesta-en", "name": "Vesta", "accent": "American", "gender": "Female"},
    {"id": "aura-2-mars-en", "name": "Mars", "accent": "American", "gender": "Male"},
    {"id": "aura-2-odysseus-en", "name": "Odysseus", "accent": "British", "gender": "Male"},
    {"id": "aura-2-orpheus-en", "name": "Orpheus", "accent": "American", "gender": "Male"},
    {"id": "aura-2-zeus-en", "name": "Zeus", "accent": "American", "gender": "Male"},
]


# ============================================================================
# WEBRTC STATE
# ============================================================================

# session_id -> {voice, speed} from the /start request
_active_sessions: dict[str, dict[str, Any]] = {}
_pending_twilio_calls: dict[str, dict[str, Any]] = {}
_active_twilio_calls: dict[str, dict[str, Any]] = {}

# SmallWebRTC request handler (initialized in lifespan)
_webrtc_handler: SmallWebRTCRequestHandler | None = None


# ============================================================================
# REQUEST / RESPONSE MODELS
# ============================================================================

class GenerateRequest(BaseModel):
    """Request body for the /generate endpoint."""
    voice: str
    speed: float
    text: str


class TwilioCallRequest(BaseModel):
    """Request body for starting an outbound Twilio phone demo."""
    phoneNumber: str
    voice: str
    speed: float
    mode: str = "chat"
    demoBrief: str | None = None


class RecorderProbeProcessor(FrameProcessor):
    """Counts audio frame types passing a point in the pipeline for debugging."""

    def __init__(self, recording_id: str, label: str):
        super().__init__()
        self.recording_id = recording_id
        self.label = label
        self.input_frames = 0
        self.input_bytes = 0
        self.output_frames = 0
        self.output_bytes = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, InputAudioRawFrame):
            self.input_frames += 1
            self.input_bytes += len(frame.audio)
        elif isinstance(frame, OutputAudioRawFrame):
            self.output_frames += 1
            self.output_bytes += len(frame.audio)

        if isinstance(frame, (CancelFrame, EndFrame)):
            await _log_recorder_event(
                self.recording_id,
                (
                    f"probe {self.label} summary "
                    f"input_frames={self.input_frames} input_bytes={self.input_bytes} "
                    f"output_frames={self.output_frames} output_bytes={self.output_bytes}"
                ),
            )

        await self.push_frame(frame, direction)


class SingleTrackRecorderProcessor(FrameProcessor):
    """Records only one audio frame type and writes it on pipeline shutdown."""

    def __init__(self, recording_id: str, track: str, target_sample_rate: int, frame_type: type[Frame]):
        super().__init__()
        self.recording_id = recording_id
        self.track = track
        self.target_sample_rate = target_sample_rate
        self.frame_type = frame_type
        self.buffer = bytearray()
        self.frame_count = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, self.frame_type):
            audio = frame.audio
            self.buffer.extend(audio)
            self.frame_count += 1

        if isinstance(frame, (CancelFrame, EndFrame)):
            await _log_recorder_event(
                self.recording_id,
                f"{self.track} single-track summary frames={self.frame_count} bytes={len(self.buffer)}",
            )
            await _save_single_track_recording(
                self.recording_id,
                self.track,
                bytes(self.buffer),
                self.target_sample_rate,
            )

        await self.push_frame(frame, direction)


def _build_system_prompt(mode: str, demo_brief: str | None) -> str:
    """Build the live-call system prompt for either open chat or demo mode."""
    if mode != "demo":
        return CHAT_SYSTEM_PROMPT

    if not demo_brief:
        return DEMO_SYSTEM_PROMPT

    return (
        f"{DEMO_SYSTEM_PROMPT}\n\n"
        f"Demo brief:\n{demo_brief}\n\n"
        "Use the demo brief as product direction for what to naturally surface in the "
        "conversation. Do not recite it mechanically unless the wording fits organically."
    )


def _normalize_call_config(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize session config shared by WebRTC and Twilio call flows."""
    mode = "demo" if raw.get("mode") == "demo" else "chat"
    demo_brief_raw = raw.get("demoBrief")
    voice_raw = raw.get("voice")
    speed_raw = raw.get("speed", 1.2)

    try:
        speed = float(speed_raw)
    except (TypeError, ValueError):
        speed = 1.2

    demo_brief = (
        demo_brief_raw.strip()[:MAX_DEMO_BRIEF_CHARS]
        if isinstance(demo_brief_raw, str)
        else ""
    )

    return {
        "voice": voice_raw if isinstance(voice_raw, str) and voice_raw else "aura-2-andromeda-en",
        "speed": speed,
        "mode": mode,
        "demo_brief": demo_brief or None,
        "recording_id": (
            raw.get("recordingId")
            if isinstance(raw.get("recordingId"), str) and raw.get("recordingId")
            else str(uuid.uuid4())
        ),
    }


def _build_twilio_stream_url(request: Request) -> str:
    """Build the absolute WebSocket URL that Twilio should stream to."""
    public_url = os.environ.get("PUBLIC_URL", "").strip()
    if public_url:
        ws_scheme = "wss" if public_url.startswith("https://") else "ws"
        host = public_url.split("://", 1)[1].rstrip("/")
        return f"{ws_scheme}://{host}/twilio-stream"

    return f"wss://{request.url.hostname}/twilio-stream"


def _build_twiml_connect(stream_url: str) -> str:
    """Build TwiML that starts a bidirectional Twilio media stream."""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<Response>\n"
        "  <Connect>\n"
        f'    <Stream url="{stream_url}">\n'
        "    </Stream>\n"
        "  </Connect>\n"
        "</Response>"
    )


def _twilio_ready() -> tuple[bool, str]:
    """Validate that the Twilio-specific environment is present."""
    required = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "PUBLIC_URL"]
    missing = [name for name in required if not os.environ.get(name, "").strip()]
    if missing:
        return False, f"Missing Twilio env vars: {', '.join(missing)}"

    if not os.environ["PUBLIC_URL"].startswith("https://"):
        return False, "PUBLIC_URL must be https:// for Twilio webhooks and media streams"

    return True, ""


# ============================================================================
# LIFESPAN
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize and clean up the WebRTC request handler."""
    global _webrtc_handler
    _webrtc_handler = SmallWebRTCRequestHandler()
    yield
    await _webrtc_handler.close()


# ============================================================================
# MAIN ENDPOINTS
# ============================================================================

app = FastAPI(title="Voice Review - Pipecat Deepgram", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Shared aiohttp session (created on first request)
_http_session: aiohttp.ClientSession | None = None


@app.get("/api/voices")
async def get_voices() -> list[dict]:
    """Return the list of available Deepgram Aura 2 voices.

    Returns:
        List of voice objects with id, name, accent, and gender.
    """
    return AVAILABLE_VOICES


@app.post("/generate")
async def generate(req: GenerateRequest) -> Response:
    """Generate a WAV audio sample for the given voice, speed, and text.

    Args:
        req: Request with voice ID, speed multiplier, and text to synthesize.

    Returns:
        WAV audio file response.
    """
    # Step 1: Call Deepgram TTS to get raw PCM audio
    raw_pcm = await _call_deepgram_tts(req.text, req.voice)

    # Step 2: Apply WSOLA speed adjustment (skip if 1.0x)
    if req.speed != 1.0:
        raw_pcm = _apply_speed(raw_pcm, req.speed)

    # Step 3: Apply RMS normalization
    raw_pcm = _apply_normalization(raw_pcm)

    # Step 4: Wrap as WAV
    wav_bytes = _pcm_to_wav(raw_pcm)

    return Response(content=wav_bytes, media_type="audio/wav")


# ============================================================================
# WEBRTC ENDPOINTS
# ============================================================================

@app.post("/start")
async def webrtc_start(request: Request) -> JSONResponse:
    """Create a new WebRTC session. Returns sessionId for the client.

    Expects JSON body with optional voice and speed fields.
    No authentication required.
    """
    try:
        request_data = await request.json()
    except Exception:
        request_data = {}

    session_id = str(uuid.uuid4())
    _active_sessions[session_id] = _normalize_call_config(request_data)

    return JSONResponse({"sessionId": session_id})


@app.post("/api/twilio/call")
async def twilio_call(req: TwilioCallRequest, request: Request) -> JSONResponse:
    """Start an outbound phone call for the current review config."""
    logger.info(
        "[twilio] /api/twilio/call requested: phone=%s mode=%s voice=%s speed=%s",
        req.phoneNumber,
        req.mode,
        req.voice,
        req.speed,
    )
    twilio_ok, twilio_error = _twilio_ready()
    if not twilio_ok:
        logger.error("[twilio] /api/twilio/call rejected: %s", twilio_error)
        return JSONResponse({"error": twilio_error}, status_code=500)

    phone_number = req.phoneNumber.strip()
    if not PHONE_NUMBER_PATTERN.match(phone_number):
        logger.warning("[twilio] /api/twilio/call invalid phone number: %s", phone_number)
        return JSONResponse({"error": "phoneNumber must be E.164 format, for example +14155550123"}, status_code=400)

    config = _normalize_call_config(
        {
            "voice": req.voice,
            "speed": req.speed,
            "mode": req.mode,
            "demoBrief": req.demoBrief,
        }
    )
    call_token = str(uuid.uuid4())
    _pending_twilio_calls[call_token] = config
    logger.info(
        "[twilio] Prepared outbound config: call_token=%s recording_id=%s mode=%s voice=%s",
        call_token,
        config["recording_id"],
        config["mode"],
        config["voice"],
    )

    callback_url = f"{os.environ['PUBLIC_URL'].rstrip('/')}/twilio/outbound/{call_token}"
    logger.info("[twilio] Outbound callback URL: %s", callback_url)

    try:
        twilio_client = TwilioClient(
            os.environ["TWILIO_ACCOUNT_SID"],
            os.environ["TWILIO_AUTH_TOKEN"],
        )
        call = twilio_client.calls.create(
            to=phone_number,
            from_=os.environ["TWILIO_FROM_NUMBER"],
            url=callback_url,
        )
    except Exception as exc:
        _pending_twilio_calls.pop(call_token, None)
        logger.exception("[twilio] Failed to initiate outbound review call")
        return JSONResponse({"error": str(exc)}, status_code=502)

    logger.info(
        "[twilio] Outbound review call started: sid=%s mode=%s voice=%s",
        call.sid,
        config["mode"],
        config["voice"],
    )
    return JSONResponse({"success": True, "callSid": call.sid})


@app.post("/twilio/outbound/{call_token}")
async def twilio_outbound(call_token: str, request: Request) -> Response:
    """Return TwiML for an answered outbound Twilio review call."""
    form = await request.form()
    call_sid = str(form.get("CallSid", ""))
    call_status = str(form.get("CallStatus", ""))
    from_number = str(form.get("From", ""))
    to_number = str(form.get("To", ""))
    logger.info(
        "[twilio] /twilio/outbound hit: call_token=%s call_sid=%s status=%s from=%s to=%s",
        call_token,
        call_sid,
        call_status,
        from_number,
        to_number,
    )
    config = _pending_twilio_calls.get(call_token)
    if config is None:
        logger.error("[twilio] /twilio/outbound unknown call token: %s", call_token)
        return Response(content="Unknown call token", status_code=404)

    if call_sid:
        _active_twilio_calls[call_sid] = config
        _pending_twilio_calls.pop(call_token, None)
        logger.info(
            "[twilio] Stored active call config: call_sid=%s recording_id=%s mode=%s voice=%s",
            call_sid,
            config["recording_id"],
            config["mode"],
            config["voice"],
        )

    stream_url = _build_twilio_stream_url(request)
    logger.info(
        "[twilio] /twilio/outbound connecting stream: call_sid=%s stream_url=%s recording_id=%s",
        call_sid,
        stream_url,
        config["recording_id"],
    )
    twiml = _build_twiml_connect(stream_url)
    return Response(content=twiml, media_type="text/xml")


@app.post("/sessions/{session_id}/api/offer")
async def webrtc_offer(
    session_id: str, request: Request, background_tasks: BackgroundTasks
) -> JSONResponse:
    """Handle WebRTC SDP offer, return SDP answer.

    Args:
        session_id: The session ID from /start.
        request: The incoming HTTP request with SDP offer.
        background_tasks: FastAPI background tasks for running the bot.

    Returns:
        SDP answer as JSON.
    """
    session_config = _active_sessions.get(session_id)
    if session_config is None:
        return JSONResponse({"error": "Invalid session_id"}, status_code=404)

    request_data = await request.json()

    webrtc_request = SmallWebRTCRequest(
        sdp=request_data["sdp"],
        type=request_data["type"],
        pc_id=request_data.get("pc_id"),
        restart_pc=request_data.get("restart_pc"),
        request_data=session_config,
    )

    async def connection_callback(connection: SmallWebRTCConnection):
        background_tasks.add_task(_webrtc_bot, connection, session_config)

    assert _webrtc_handler is not None
    answer = await _webrtc_handler.handle_web_request(
        request=webrtc_request,
        webrtc_connection_callback=connection_callback,
    )
    return JSONResponse(content=answer)


@app.patch("/sessions/{session_id}/api/offer")
async def webrtc_ice_candidate(session_id: str, request: Request) -> JSONResponse:
    """Handle WebRTC ICE candidate.

    Args:
        session_id: The session ID from /start.
        request: The incoming HTTP request with ICE candidates.

    Returns:
        Success status.
    """
    if session_id not in _active_sessions:
        return JSONResponse({"error": "Invalid session_id"}, status_code=404)

    request_data = await request.json()
    patch_request = SmallWebRTCPatchRequest(
        pc_id=request_data["pc_id"],
        candidates=[IceCandidate(**c) for c in request_data.get("candidates", [])],
    )
    assert _webrtc_handler is not None
    await _webrtc_handler.handle_patch_request(patch_request)
    return JSONResponse({"status": "success"})


async def _run_bot(transport, config: dict[str, Any], sample_rate: int) -> None:
    """Run the review bot for either WebRTC or Twilio transports."""
    voice = config.get("voice", "aura-2-andromeda-en")
    speed = config.get("speed", 1.2)
    mode = "demo" if config.get("mode") == "demo" else "chat"
    demo_brief = config.get("demo_brief")
    recording_id = str(config.get("recording_id", str(uuid.uuid4())))
    system_prompt = _build_system_prompt(mode, demo_brief)

    logger.info(
        "[bot] Starting pipeline: voice=%s, speed=%s, mode=%s, sample_rate=%s",
        voice,
        speed,
        mode,
        sample_rate,
    )
    await _log_recorder_event(
        recording_id,
        (
            f"pipeline start voice={voice} speed={speed} mode={mode} sample_rate={sample_rate} "
            f"transport={type(transport).__name__}"
        ),
    )

    # -- STT (Deepgram Flux with native turn detection) --
    stt = DeepgramFluxSTTService(api_key=DEEPGRAM_API_KEY)

    # -- LLM (OpenRouter, OpenAI-compatible) --
    llm = OpenAILLMService(
        api_key=OPENROUTER_API_KEY,
        model=LLM_MODEL,
        base_url="https://openrouter.ai/api/v1",
    )

    # -- TTS (Deepgram with markdown filtering) --
    tts = DeepgramTTSService(
        api_key=DEEPGRAM_API_KEY,
        voice=voice,
        sample_rate=sample_rate,
        text_filter=MarkdownTextFilter(),
    )

    # -- Speed processor (WSOLA) --
    speed_processor = AudioSpeedProcessor(
        speed=speed,
        sample_rate=sample_rate,
        num_channels=NUM_CHANNELS,
    )

    # -- Audio normalizer --
    normalizer = AudioNormalizerProcessor(sample_rate=sample_rate)

    # -- Audio recording --
    user_probe = RecorderProbeProcessor(recording_id, "user_probe")
    user_recorder = SingleTrackRecorderProcessor(
        recording_id=recording_id,
        track="user",
        target_sample_rate=sample_rate,
        frame_type=InputAudioRawFrame,
    )
    bot_probe = RecorderProbeProcessor(recording_id, "bot_probe")
    bot_recorder = SingleTrackRecorderProcessor(
        recording_id=recording_id,
        track="bot",
        target_sample_rate=sample_rate,
        frame_type=OutputAudioRawFrame,
    )

    # -- LLM context --
    messages: list[Any] = [{"role": "system", "content": system_prompt}]
    context = LLMContext(messages=messages)
    context_aggregator = LLMContextAggregatorPair(context)

    # -- Assemble pipeline --
    pipeline = Pipeline([
        transport.input(),
        user_probe,
        user_recorder,
        stt,
        context_aggregator.user(),
        llm,
        tts,
        speed_processor,
        normalizer,
        bot_probe,
        bot_recorder,
        transport.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=sample_rate,
            audio_out_sample_rate=sample_rate,
        ),
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport_instance, client):
        logger.info("[bot] Client connected, sending greeting")
        await _log_recorder_event(recording_id, "client connected; starting recorders")
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport_instance, client):
        logger.info("[bot] Client disconnected")
        await _log_recorder_event(recording_id, "client disconnected; cancelling task")
        await task.cancel()

    try:
        runner = PipelineRunner(handle_sigint=False)
        await runner.run(task)
    except Exception:
        logger.exception("[bot] Pipeline error")
    finally:
        await _log_recorder_event(recording_id, "stopping recorders")
        await _log_recorder_event(recording_id, "pipeline end")
        logger.info("[bot] Pipeline ended")


# ============================================================================
# TWILIO STREAMING
# ============================================================================

@app.websocket("/twilio-stream")
async def twilio_stream_ws(websocket: WebSocket) -> None:
    """Handle Twilio Media Streams for outbound phone demos."""
    logger.info("[twilio] /twilio-stream websocket connection starting")
    await websocket.accept()
    logger.info("[twilio] /twilio-stream websocket accepted")

    try:
        _transport_type, call_data = await parse_telephony_websocket(websocket)

        stream_sid: str = call_data.get("stream_id", "")
        call_sid: str = call_data.get("call_id", "")
        body: dict[str, Any] = call_data.get("body", {})
        config = _active_twilio_calls.get(call_sid)
        if config is None:
            logger.error(
                "[twilio] No active config found for call_sid=%s. Body params were: %s",
                call_sid,
                body,
            )
            await websocket.close(code=1011, reason="Missing active call config")
            return

        logger.info(
            "[twilio] Media stream metadata: call_sid=%s stream_sid=%s mode=%s voice=%s recording_id=%s",
            call_sid,
            stream_sid,
            config["mode"],
            config["voice"],
            config["recording_id"],
        )
        logger.info("[twilio] Media stream custom params: %s", body)
        await _log_recorder_event(
            str(config["recording_id"]),
            (
                f"twilio stream connected call_sid={call_sid} stream_sid={stream_sid} "
                f"mode={config['mode']} voice={config['voice']}"
            ),
        )

        serializer = TwilioFrameSerializer(
            stream_sid=stream_sid,
            call_sid=call_sid,
            params=TwilioFrameSerializer.InputParams(auto_hang_up=False),
        )
        transport = FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                vad_enabled=False,
                serializer=serializer,
            ),
        )

        await _run_bot(transport, config, sample_rate=TWILIO_SAMPLE_RATE)
    except Exception:
        logger.exception("[twilio] /twilio-stream failed")
        raise
    finally:
        call_sid = locals().get("call_sid")
        if call_sid:
            _active_twilio_calls.pop(call_sid, None)
            logger.info("[twilio] Cleared active call config: call_sid=%s", call_sid)


# ============================================================================
# WEBRTC BOT
# ============================================================================

async def _webrtc_bot(connection: SmallWebRTCConnection, config: dict[str, Any]) -> None:
    """Run the review bot over a WebRTC transport."""
    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    )
    await _log_recorder_event(
        str(config["recording_id"]),
        f"webrtc bot start mode={config['mode']} voice={config['voice']}",
    )
    await _run_bot(transport, config, sample_rate=SAMPLE_RATE)


# Mount static files AFTER API routes so they don't shadow them
app.mount("/", StaticFiles(directory="static", html=True), name="static")


# ============================================================================
# TTS HELPER FUNCTIONS
# ============================================================================

async def _get_http_session() -> aiohttp.ClientSession:
    """Get or create the shared aiohttp session.

    Returns:
        The shared aiohttp ClientSession.
    """
    global _http_session
    if _http_session is None or _http_session.closed:
        _http_session = aiohttp.ClientSession()
    return _http_session


def _write_wav(pcm_data: bytes, sample_rate: int, num_channels: int) -> bytes:
    """Wrap raw PCM16 audio bytes in a WAV container."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(num_channels)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return buf.getvalue()


def _recording_path(recording_id: str, track: str) -> Path:
    """Build the target path for a saved track recording."""
    safe_id = re.sub(r"[^A-Za-z0-9._-]", "-", recording_id)
    return DOWNLOADS_DIR / f"voice-review-{safe_id}-{track}.wav"


def _append_recorder_log(recording_id: str, message: str) -> None:
    """Append a timestamped recorder debug line to the shared recorder log."""
    RECORDER_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).isoformat()
    with RECORDER_LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(f"{timestamp} [{recording_id}] {message}\n")


async def _log_recorder_event(recording_id: str, message: str) -> None:
    """Write a recorder debug line without blocking the event loop."""
    await asyncio.to_thread(_append_recorder_log, recording_id, message)


def _write_recording_file(path: Path, wav_bytes: bytes) -> None:
    """Write a WAV recording to disk, ensuring the Downloads folder exists."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(wav_bytes)


async def _save_single_track_recording(
    recording_id: str,
    track: str,
    audio: bytes,
    sample_rate: int,
) -> None:
    """Persist a single user or bot recording to the local Downloads folder."""
    if not audio:
        logger.warning("[recorder] %s track was empty for recording %s", track, recording_id)
        await _log_recorder_event(recording_id, f"{track} track empty")
        return

    wav_bytes = _write_wav(audio, sample_rate, 1)
    path = _recording_path(recording_id, track)
    await asyncio.to_thread(_write_recording_file, path, wav_bytes)
    non_silent_bytes = sum(1 for byte in audio if byte != 0)
    first_nonzero_index = next((i for i, byte in enumerate(audio) if byte != 0), -1)
    logger.info(
        "[recorder] Saved %s track recording to %s (bytes=%d non_silent_bytes=%d)",
        track,
        path,
        len(audio),
        non_silent_bytes,
    )
    await _log_recorder_event(
        recording_id,
        (
            f"saved {track} track path={path} bytes={len(audio)} "
            f"non_silent_bytes={non_silent_bytes} first_nonzero_index={first_nonzero_index} "
            f"sample_rate={sample_rate}"
        ),
    )


async def _call_deepgram_tts(text: str, voice: str) -> bytes:
    """Call Deepgram's HTTP TTS API to synthesize speech.

    Args:
        text: The text to synthesize.
        voice: Deepgram voice model name (e.g. "aura-2-andromeda-en").

    Returns:
        Raw PCM linear16 audio bytes at SAMPLE_RATE Hz.
    """
    session = await _get_http_session()
    headers = {
        "Authorization": f"Token {DEEPGRAM_API_KEY}",
        "Content-Type": "application/json",
    }
    params = {
        "model": voice,
        "encoding": "linear16",
        "sample_rate": SAMPLE_RATE,
        "container": "none",
    }

    async with session.post(
        DEEPGRAM_TTS_URL, headers=headers, json={"text": text}, params=params
    ) as resp:
        if resp.status != 200:
            error_text = await resp.text()
            raise RuntimeError(f"Deepgram TTS failed ({resp.status}): {error_text}")
        return await resp.read()


def _apply_speed(raw_pcm: bytes, speed: float) -> bytes:
    """Apply pitch-preserving speed adjustment using WSOLA.

    Args:
        raw_pcm: Raw int16 PCM audio bytes.
        speed: Speed multiplier (0.5 to 2.0).

    Returns:
        Speed-adjusted int16 PCM audio bytes.
    """
    streamer = WSOLAStreamer(SAMPLE_RATE, NUM_CHANNELS, speed)
    processed = streamer.process(raw_pcm)
    flushed = streamer.flush()
    return processed + flushed


def _apply_normalization(raw_pcm: bytes) -> bytes:
    """Apply RMS normalization with peak limiting.

    Args:
        raw_pcm: Raw int16 PCM audio bytes.

    Returns:
        Normalized int16 PCM audio bytes.
    """
    normalizer = RMSNormalizer(sample_rate=SAMPLE_RATE)
    return normalizer.process(raw_pcm)


def _pcm_to_wav(raw_pcm: bytes) -> bytes:
    """Wrap raw PCM int16 audio bytes in a WAV container.

    Args:
        raw_pcm: Raw int16 PCM audio bytes.

    Returns:
        Complete WAV file bytes.
    """
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(NUM_CHANNELS)
        wf.setsampwidth(2)  # 16-bit = 2 bytes
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(raw_pcm)
    return buf.getvalue()
