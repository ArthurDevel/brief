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
import uuid
import wave
from contextlib import asynccontextmanager
from typing import Any

import aiohttp
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import os

from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.network.small_webrtc import SmallWebRTCTransport
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
    IceCandidate,
)
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter

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
SAMPLE_RATE = 16000
NUM_CHANNELS = 1

SYSTEM_PROMPT = (
    "You are a friendly voice assistant used for testing voice quality. "
    "Have a casual, natural conversation. Keep responses concise (1-3 sentences). "
    "You can talk about anything -- weather, hobbies, travel, food, tech, etc. "
    "Be warm and conversational, as if chatting with a friend."
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
    _active_sessions[session_id] = {
        "voice": request_data.get("voice", "aura-2-andromeda-en"),
        "speed": request_data.get("speed", 1.2),
    }

    return JSONResponse({"sessionId": session_id})


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


# Mount static files AFTER API routes so they don't shadow them
app.mount("/", StaticFiles(directory="static", html=True), name="static")


# ============================================================================
# WEBRTC BOT
# ============================================================================

async def _webrtc_bot(connection: SmallWebRTCConnection, config: dict) -> None:
    """Run a stripped-down Pipecat pipeline for a WebRTC connection.

    Pipeline: transport.input() -> STT -> LLM -> TTS -> speed -> normalizer -> transport.output()

    Args:
        connection: SmallWebRTCConnection from the request handler.
        config: Dict with "voice" and "speed" keys.
    """
    voice = config.get("voice", "aura-2-andromeda-en")
    speed = config.get("speed", 1.2)

    logger.info("[bot] Starting pipeline: voice=%s, speed=%s", voice, speed)

    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
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
        sample_rate=SAMPLE_RATE,
        text_filter=MarkdownTextFilter(),
    )

    # -- Speed processor (WSOLA) --
    speed_processor = AudioSpeedProcessor(
        speed=speed,
        sample_rate=SAMPLE_RATE,
        num_channels=NUM_CHANNELS,
    )

    # -- Audio normalizer --
    normalizer = AudioNormalizerProcessor(sample_rate=SAMPLE_RATE)

    # -- LLM context --
    messages: list[Any] = [{"role": "system", "content": SYSTEM_PROMPT}]
    context = LLMContext(messages=messages)
    context_aggregator = LLMContextAggregatorPair(context)

    # -- Assemble pipeline --
    pipeline = Pipeline([
        transport.input(),
        stt,
        context_aggregator.user(),
        llm,
        tts,
        speed_processor,
        normalizer,
        transport.output(),
        context_aggregator.assistant(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=SAMPLE_RATE,
            audio_out_sample_rate=SAMPLE_RATE,
        ),
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport_instance, client):
        logger.info("[bot] Client connected, sending greeting")
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport_instance, client):
        logger.info("[bot] Client disconnected")
        await task.cancel()

    try:
        runner = PipelineRunner(handle_sigint=False)
        await runner.run(task)
    except Exception:
        logger.exception("[bot] Pipeline error")
    finally:
        logger.info("[bot] Pipeline ended")


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
