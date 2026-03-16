"""
FastAPI application for the Pipecat voice pipeline.

Owns the FastAPI app directly and uses SmallWebRTCRequestHandler for WebRTC
signaling. No monkey-patching of Pipecat internals.

Responsibilities:
- WebRTC signaling endpoints (/start, /sessions/{id}/api/offer)
- Twilio phone calling endpoints (/twilio/voice, /twilio/verify-pin, /twilio-stream)
- Health check and speed control API
- bot(): creates and runs a pipeline for each authenticated connection
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any

import uvicorn
from fastapi import BackgroundTasks, FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.runner import PipelineRunner
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.network.small_webrtc import SmallWebRTCTransport
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)

from src.auth.jwt_auth import verify_token
from src.auth.twilio_auth import (
    MAX_PIN_ATTEMPTS,
    build_twiml_connect,
    build_twiml_gather_pin,
    build_twiml_reject,
    check_usage_limit,
    lookup_user_by_phone,
    verify_pin,
)
from src.config import load_settings
from src.cost_tracker import CostTracker
from src.pipeline import create_pipeline
from src.session import end_session, load_user_context, start_session
from src.supabase_client import create_service_client
from src.tools.email_client import close_imap_connection, create_imap_connection
from src.transports.twilio import TwilioTransport, TwilioParams


logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

TWILIO_PIPELINE_SAMPLE_RATE = 16000
DEFAULT_SPEED = 1.5

# Shared mutable config -- updated by the speed API, read by AudioSpeedProcessor
_speed_config: dict[str, float] = {"speed": DEFAULT_SPEED}


# ============================================================================
# WEBRTC STATE
# ============================================================================

# In-memory store of pending sessions: session_id -> requestData body
_active_sessions: dict[str, dict[str, Any]] = {}

# SmallWebRTC request handler (initialized in lifespan)
_webrtc_handler: SmallWebRTCRequestHandler | None = None


# ============================================================================
# BOT HANDLER (shared by WebRTC and Twilio)
# ============================================================================

async def _setup_pipeline_session(transport, user_context, settings, supabase):
    """Set up a pipeline session: create session, IMAP connection, cost tracker, and pipeline task.

    Args:
        transport: Pipecat transport (SmallWebRTC or Twilio).
        user_context: Loaded user context with IMAP/SMTP config.
        settings: App settings.
        supabase: Supabase client.
    """
    session = start_session(user_context.user_id, supabase)
    cost_tracker = CostTracker()

    imap_client = create_imap_connection(user_context.imap_config)
    imap_holder = {
        "client": imap_client,
        "config": user_context.imap_config,
    }

    try:
        audio_config = {
            "sample_rate": 16000,
            "num_channels": 1,
            "speed_config": _speed_config,
        }

        task = create_pipeline(
            transport=transport,
            user_context=user_context,
            session=session,
            cost_tracker=cost_tracker,
            audio_config=audio_config,
            supabase=supabase,
            settings=settings,
            imap_holder=imap_holder,
        )

        return task, session, cost_tracker, imap_holder

    except Exception:
        try:
            close_imap_connection(imap_client)
        except Exception as exc:
            logger.warning("[server] Error closing IMAP on setup failure: %s", exc)
        raise


def _cleanup_session(imap_holder, cost_tracker, session, supabase) -> None:
    """Clean up after a pipeline session ends.

    Args:
        imap_holder: Mutable IMAP client holder.
        cost_tracker: Cost tracker for the session.
        session: Active session to finalize.
        supabase: Supabase client.
    """
    try:
        close_imap_connection(imap_holder["client"])
    except Exception as exc:
        logger.warning("[server] Error closing IMAP connection: %s", exc)

    try:
        cost_summary = cost_tracker.get_summary()
        end_session(session, cost_summary, supabase)
    except Exception as exc:
        logger.error("[server] Error ending session: %s", exc)


# ============================================================================
# WEBRTC BOT
# ============================================================================

async def _webrtc_bot(connection: SmallWebRTCConnection, body: dict) -> None:
    """Pipecat entry point for WebRTC browser connections.

    Verifies JWT, loads user context, creates and runs the pipeline.

    Args:
        connection: SmallWebRTCConnection from the request handler.
        body: requestData from the WebRTC offer (contains token).
    """
    token = body.get("token", "")
    if not token:
        logger.error("[server] WebRTC: no token in requestData")
        return

    settings = load_settings()
    supabase = create_service_client(settings)

    user_id = verify_token(token, supabase)
    if not user_id:
        logger.error("[server] WebRTC: invalid JWT")
        return

    logger.info("[server] WebRTC client authenticated: user %s", user_id)

    user_context = load_user_context(user_id, supabase)

    transport = SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    )

    task, session, cost_tracker, imap_holder = await _setup_pipeline_session(
        transport, user_context, settings, supabase
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("[server] WebRTC client connected, sending greeting")
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("[server] WebRTC client disconnected")
        await task.cancel()

    try:
        runner = PipelineRunner(handle_sigint=False)
        await runner.run(task)
    finally:
        _cleanup_session(imap_holder, cost_tracker, session, supabase)


# ============================================================================
# FASTAPI APP
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage app lifecycle: initialize and clean up WebRTC handler."""
    global _webrtc_handler
    _webrtc_handler = SmallWebRTCRequestHandler()
    yield
    await _webrtc_handler.close()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# ENDPOINTS: HEALTH + SPEED
# ============================================================================

@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


@app.get("/api/speed")
async def get_speed() -> JSONResponse:
    return JSONResponse({"speed": _speed_config["speed"]})


@app.post("/api/speed")
async def set_speed(request: Request) -> JSONResponse:
    body = json.loads(await request.body())
    speed = float(body.get("speed", _speed_config["speed"]))
    speed = max(0.5, min(2.0, speed))
    _speed_config["speed"] = speed
    logger.info("[server] Speed updated to %.1f", speed)
    return JSONResponse({"speed": speed})


# ============================================================================
# ENDPOINTS: WEBRTC SIGNALING
# ============================================================================

@app.post("/start")
async def webrtc_start(request: Request) -> JSONResponse:
    """Create a new WebRTC session. Returns sessionId for the client."""
    try:
        request_data = await request.json()
    except Exception:
        request_data = {}

    session_id = str(uuid.uuid4())
    _active_sessions[session_id] = request_data.get("body", {})

    return JSONResponse({"sessionId": session_id})


@app.post("/sessions/{session_id}/api/offer")
async def webrtc_offer(
    session_id: str, request: Request, background_tasks: BackgroundTasks
) -> dict:
    """Handle WebRTC SDP offer, return SDP answer."""
    active_session = _active_sessions.get(session_id)
    if active_session is None:
        return Response(content="Invalid session_id", status_code=404)

    request_data = await request.json()

    webrtc_request = SmallWebRTCRequest(
        sdp=request_data["sdp"],
        type=request_data["type"],
        pc_id=request_data.get("pc_id"),
        restart_pc=request_data.get("restart_pc"),
        request_data=request_data.get("request_data")
        or request_data.get("requestData")
        or active_session,
    )

    async def connection_callback(connection: SmallWebRTCConnection):
        body = webrtc_request.request_data or {}
        background_tasks.add_task(_webrtc_bot, connection, body)

    answer = await _webrtc_handler.handle_web_request(
        request=webrtc_request,
        webrtc_connection_callback=connection_callback,
    )
    return answer


@app.patch("/sessions/{session_id}/api/offer")
async def webrtc_ice_candidate(session_id: str, request: Request) -> JSONResponse:
    """Handle WebRTC ICE candidate."""
    if session_id not in _active_sessions:
        return Response(content="Invalid session_id", status_code=404)

    request_data = await request.json()
    from pipecat.transports.smallwebrtc.request_handler import IceCandidate

    patch_request = SmallWebRTCPatchRequest(
        pc_id=request_data["pc_id"],
        candidates=[IceCandidate(**c) for c in request_data.get("candidates", [])],
    )
    await _webrtc_handler.handle_patch_request(patch_request)
    return JSONResponse({"status": "success"})


# ============================================================================
# ENDPOINTS: TWILIO
# ============================================================================

@app.post("/twilio/voice")
async def twilio_voice(request: Request) -> Response:
    """Handle incoming Twilio voice calls.

    Looks up the caller by phone number, checks lock/usage,
    returns TwiML Gather for PIN or rejection.
    """
    form = await request.form()
    caller_phone = form.get("From", "")

    settings = load_settings()
    supabase = create_service_client(settings)

    logger.info("[twilio] Incoming call from %s", caller_phone)

    user_record = lookup_user_by_phone(caller_phone, supabase)

    if user_record is None:
        logger.info("[twilio] Unknown caller %s, rejecting", caller_phone)
        twiml = build_twiml_reject("This phone number is not registered. Goodbye.")
        return Response(content=twiml, media_type="application/xml")

    if user_record["pin_locked"]:
        logger.info("[twilio] Account locked for user %s", user_record["user_id"])
        twiml = build_twiml_reject("Your account is locked. Please contact support. Goodbye.")
        return Response(content=twiml, media_type="application/xml")

    if not check_usage_limit(user_record["user_id"], supabase):
        logger.info("[twilio] Usage limit exceeded for user %s", user_record["user_id"])
        twiml = build_twiml_reject("You have reached your monthly call limit. Goodbye.")
        return Response(content=twiml, media_type="application/xml")

    twiml = build_twiml_gather_pin(user_record["user_id"], attempt=1)
    return Response(content=twiml, media_type="application/xml")


@app.post("/twilio/verify-pin")
async def twilio_verify_pin(request: Request) -> Response:
    """Verify the caller's PIN and connect to the media stream."""
    form = await request.form()
    digits = form.get("Digits", "")
    user_id = request.query_params.get("userId", "")
    attempt = int(request.query_params.get("attempt", "1"))

    if not user_id:
        twiml = build_twiml_reject("Authentication error. Goodbye.")
        return Response(content=twiml, media_type="application/xml")

    settings = load_settings()
    supabase = create_service_client(settings)

    pin_response = (
        supabase.table("user_settings")
        .select("pin_hash")
        .eq("user_id", user_id)
        .single()
        .execute()
    )

    if pin_response.data is None or not pin_response.data.get("pin_hash"):
        twiml = build_twiml_reject("PIN not configured. Goodbye.")
        return Response(content=twiml, media_type="application/xml")

    pin_hash = pin_response.data["pin_hash"]

    if verify_pin(digits, pin_hash):
        stream_url = f"wss://{request.url.hostname}/twilio-stream?userId={user_id}"

        public_url = settings.public_url
        if public_url and public_url != f"http://localhost:{settings.port}":
            ws_scheme = "wss" if public_url.startswith("https") else "ws"
            host = public_url.split("://", 1)[1].rstrip("/")
            stream_url = f"{ws_scheme}://{host}/twilio-stream?userId={user_id}"

        logger.info("[twilio] PIN verified for user %s, connecting stream", user_id)
        twiml = build_twiml_connect(stream_url)
        return Response(content=twiml, media_type="application/xml")

    next_attempt = attempt + 1
    if next_attempt > MAX_PIN_ATTEMPTS:
        supabase.table("user_settings").update(
            {"pin_locked": True}
        ).eq("user_id", user_id).execute()

        logger.info("[twilio] Max PIN attempts reached, locking user %s", user_id)
        twiml = build_twiml_reject("Too many incorrect attempts. Your account has been locked. Goodbye.")
        return Response(content=twiml, media_type="application/xml")

    logger.info("[twilio] Incorrect PIN for user %s, attempt %d", user_id, attempt)
    twiml = build_twiml_gather_pin(user_id, attempt=next_attempt)
    return Response(content=twiml, media_type="application/xml")


@app.websocket("/twilio-stream")
async def twilio_stream_ws(websocket: WebSocket) -> None:
    """Handle Twilio media stream WebSocket connections."""
    await websocket.accept()

    user_id = websocket.query_params.get("userId", "")
    if not user_id:
        logger.error("[twilio] No userId in WebSocket query params")
        await websocket.close(code=1008, reason="Missing userId")
        return

    settings = load_settings()
    supabase = create_service_client(settings)

    logger.info("[twilio] Media stream connected for user %s", user_id)

    user_context = load_user_context(user_id, supabase)

    transport = TwilioTransport(
        websocket=websocket,
        params=TwilioParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
        pipeline_sample_rate=TWILIO_PIPELINE_SAMPLE_RATE,
    )

    task, session, cost_tracker, imap_holder = await _setup_pipeline_session(
        transport, user_context, settings, supabase
    )

    async def _send_greeting():
        await asyncio.sleep(0.5)
        await task.queue_frames([LLMRunFrame()])

    asyncio.create_task(_send_greeting())

    try:
        await task.run()
    finally:
        _cleanup_session(imap_holder, cost_tracker, session, supabase)


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    settings = load_settings()
    uvicorn.run(
        "src.server:app",
        host="0.0.0.0",
        port=settings.port,
        log_level="info",
    )
