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
import uuid
from contextlib import asynccontextmanager
from typing import Any, cast

import httpx
import uvicorn
from fastapi import BackgroundTasks, FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.runner import PipelineRunner
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.network.small_webrtc import SmallWebRTCTransport
from aiortc import RTCIceServer
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
from src.langfuse_client import shutdown_langfuse_client
from src.langfuse_observer import LangfuseObserver
from src.tracked_services import UsageTracker
from src.pipeline import create_pipeline
from src.session import end_session, load_user_context, start_session
from src.supabase_client import create_service_client
from src.tools.email_client import close_imap_connection, create_imap_connection
from src.transports.twilio import TwilioTransport, TwilioParams


from loguru import logger


# ============================================================================
# CONSTANTS
# ============================================================================

TWILIO_PIPELINE_SAMPLE_RATE = 16000
DEFAULT_SPEED = 1.5
METERED_CREDENTIALS_URL = "https://0x41.metered.live/api/v1/turn/credentials"

# Shared mutable config -- updated by the speed API, read by AudioSpeedProcessor
_speed_config: dict[str, float] = {"speed": DEFAULT_SPEED}  # Overridden per-session from user settings


# ============================================================================
# WEBRTC STATE
# ============================================================================

# In-memory store of pending sessions: session_id -> requestData body
_active_sessions: dict[str, dict[str, Any]] = {}

# SmallWebRTC request handler (initialized in lifespan)
_webrtc_handler: SmallWebRTCRequestHandler | None = None

# Track sessions that are currently in a pipeline so we can finalize them on shutdown
_live_pipeline_sessions: dict[str, dict[str, Any]] = {}  # db_session_id -> cleanup info


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _to_rtc_ice_servers(raw_servers: list[dict]) -> list[RTCIceServer]:
    """Convert Metered API response dicts to RTCIceServer objects.

    Args:
        raw_servers: List of dicts with urls/username/credential from Metered API.

    Returns:
        List of RTCIceServer objects for use with aiortc peer connections.
    """
    ice_servers = []
    for server in raw_servers:
        urls = server.get("urls") or server.get("url")
        if not urls:
            continue
        if isinstance(urls, str):
            urls = [urls]
        ice_servers.append(RTCIceServer(
            urls=urls,
            username=server.get("username", ""),
            credential=server.get("credential", ""),
        ))
    return ice_servers


async def _fetch_ice_servers(api_key: str) -> list[RTCIceServer]:
    """Fetch TURN/STUN credentials from the Metered API.

    Args:
        api_key: Metered API key.

    Returns:
        List of RTCIceServer objects for use with aiortc peer connections.
    """
    async with httpx.AsyncClient(timeout=5.0) as client:
        resp = await client.get(f"{METERED_CREDENTIALS_URL}?apiKey={api_key}")
        resp.raise_for_status()
        return _to_rtc_ice_servers(resp.json())


# ============================================================================
# BOT HANDLER (shared by WebRTC and Twilio)
# ============================================================================

async def _setup_pipeline_session(transport, user_context, settings, supabase, transport_type):
    """Set up a pipeline session: create session, IMAP connection, cost tracker, and pipeline task.

    Args:
        transport: Pipecat transport (SmallWebRTC or Twilio).
        user_context: Loaded user context with IMAP/SMTP config.
        settings: App settings.
        supabase: Supabase client.
        transport_type: "webrtc" or "twilio".
    """
    session = start_session(user_context.user_id, supabase)
    usage_tracker = UsageTracker()
    cost_tracker = CostTracker(usage_tracker)
    langfuse_observer = LangfuseObserver(session, transport_type, voice=user_context.voice_preference)
    langfuse_observer.start_trace()

    imap_client = create_imap_connection(user_context.imap_config)
    imap_holder = {
        "client": imap_client,
        "config": user_context.imap_config,
    }

    try:
        _speed_config["speed"] = user_context.voice_speed
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
            langfuse_observer=langfuse_observer,
            usage_tracker=usage_tracker,
            audio_config=audio_config,
            supabase=supabase,
            settings=settings,
            imap_holder=imap_holder,
        )

        # Register so lifespan shutdown can finalize if the process is killed
        _live_pipeline_sessions[session.session_id] = {
            "session": session,
            "cost_tracker": cost_tracker,
            "langfuse_observer": langfuse_observer,
            "imap_holder": imap_holder,
            "supabase": supabase,
            "settings": settings,
        }

        return task, session, cost_tracker, langfuse_observer, imap_holder

    except Exception:
        try:
            close_imap_connection(imap_client)
        except Exception as exc:
            logger.warning("[server] Error closing IMAP on setup failure: %s", exc)
        raise


async def _cleanup_session(imap_holder, cost_tracker, langfuse_observer, session, supabase, settings) -> None:
    """Clean up after a pipeline session ends.

    Fetches actual LLM costs from OpenRouter before finalizing the session.

    Args:
        imap_holder: Mutable IMAP client holder.
        cost_tracker: Cost tracker for the session.
        langfuse_observer: Langfuse observer for the session.
        session: Active session to finalize.
        supabase: Supabase client.
        settings: App settings (for OpenRouter API key).
    """
    try:
        close_imap_connection(imap_holder["client"])
    except BaseException as exc:
        logger.warning("[server] Error closing IMAP connection: %s", exc)

    try:
        await cost_tracker.fetch_llm_costs(settings.openrouter_api_key)
    except BaseException as exc:
        logger.error("[server] Error fetching LLM costs: %s", exc)

    try:
        cost_summary = cost_tracker.get_summary()
        langfuse_observer.end_trace(cost_summary)
    except BaseException as exc:
        logger.error("[server] Error ending Langfuse trace: %s", exc)

    session_ended = False
    try:
        cost_summary = cost_tracker.get_summary()
        end_session(session, cost_summary, supabase)
        session_ended = True
    except BaseException as exc:
        logger.error("[server] Error ending session: %s", exc)

    # Trigger end-of-session processing (e.g. summary email) on the web app
    if session_ended:
        try:
            url = f"{settings.web_app_url}/api/sessions/{session.session_id}/end-of-session"
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    url,
                    headers={"Authorization": f"Bearer {settings.internal_api_key}"},
                )
                response.raise_for_status()
                logger.info("[server] End-of-session hook completed for session %s", session.session_id)
        except BaseException as exc:
            logger.warning("[server] End-of-session hook failed for session %s: %s", session.session_id, exc)

    _live_pipeline_sessions.pop(session.session_id, None)


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

    task, session, cost_tracker, langfuse_observer, imap_holder = await _setup_pipeline_session(
        transport, user_context, settings, supabase, transport_type="webrtc"
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
        await _cleanup_session(imap_holder, cost_tracker, langfuse_observer, session, supabase, settings)


# ============================================================================
# FASTAPI APP
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage app lifecycle: initialize and clean up WebRTC handler and Langfuse."""
    global _webrtc_handler

    # Fetch TURN/STUN servers so the server-side peer connection can traverse NAT
    settings = load_settings()
    logger.info("[server] METERED_API_KEY present: %s", bool(settings.metered_api_key))
    ice_servers = None
    if settings.metered_api_key:
        try:
            ice_servers = await _fetch_ice_servers(settings.metered_api_key)
            logger.info("[server] Loaded %d ICE servers from Metered: %s", len(ice_servers), ice_servers)
        except Exception as exc:
            logger.error("[server] Failed to fetch ICE servers at startup: %s", exc, exc_info=True)
    else:
        logger.warning("[server] No METERED_API_KEY set, skipping TURN server setup")

    logger.info("[server] Creating SmallWebRTCRequestHandler with ice_servers=%s", ice_servers)
    _webrtc_handler = SmallWebRTCRequestHandler(ice_servers=ice_servers)
    yield

    # Finalize any sessions that were still active when the server was killed
    for sid, info in list(_live_pipeline_sessions.items()):
        logger.info("[server] Finalizing orphaned session %s on shutdown", sid)
        try:
            await _cleanup_session(
                info["imap_holder"],
                info["cost_tracker"],
                info["langfuse_observer"],
                info["session"],
                info["supabase"],
                info["settings"],
            )
        except BaseException as exc:
            logger.error("[server] Failed to finalize session %s: %s", sid, exc)

    await _webrtc_handler.close()
    shutdown_langfuse_client()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================================
# ENDPOINTS: HEALTH
# ============================================================================

@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse({"status": "ok"})


# ============================================================================
# ENDPOINTS: WEBRTC SIGNALING
# ============================================================================

@app.post("/start")
async def webrtc_start(request: Request) -> JSONResponse:
    """Create a new WebRTC session. Returns sessionId for the client.

    Verifies the JWT token and checks usage limits before allowing the session.
    """
    try:
        request_data = await request.json()
    except Exception:
        request_data = {}

    token = request_data.get("token", "")
    if not token:
        return JSONResponse({"error": "Missing token"}, status_code=401)

    settings = load_settings()
    supabase = create_service_client(settings)

    user_id = verify_token(token, supabase)
    if not user_id:
        return JSONResponse({"error": "Invalid token"}, status_code=401)

    if not check_usage_limit(user_id, supabase):
        return JSONResponse({"error": "Monthly call limit reached", "code": "LIMIT_REACHED"}, status_code=403)

    session_id = str(uuid.uuid4())
    _active_sessions[session_id] = request_data.get("body", {})

    # Fetch fresh TURN/STUN credentials from Metered for the client,
    # and update the server-side handler so both sides can traverse NAT
    ice_servers_for_client: list[dict] = []
    if settings.metered_api_key:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{METERED_CREDENTIALS_URL}?apiKey={settings.metered_api_key}")
                resp.raise_for_status()
                ice_servers_for_client = resp.json()
            logger.info("[server] /start fetched %d ICE servers for client: %s", len(ice_servers_for_client), ice_servers_for_client)

            # Convert to RTCIceServer objects for the server-side peer connection
            rtc_ice_servers = _to_rtc_ice_servers(ice_servers_for_client)
            logger.info("[server] /start converted %d RTCIceServer objects, updating handler", len(rtc_ice_servers))
            if _webrtc_handler:
                _webrtc_handler.update_ice_servers(rtc_ice_servers)
        except Exception as exc:
            logger.error("[server] Failed to fetch TURN credentials: %s", exc, exc_info=True)
    else:
        logger.warning("[server] /start: No METERED_API_KEY, skipping TURN")

    return JSONResponse({"sessionId": session_id, "iceServers": ice_servers_for_client})


@app.post("/sessions/{session_id}/api/offer")
async def webrtc_offer(
    session_id: str, request: Request, background_tasks: BackgroundTasks
) -> Response:
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

    assert _webrtc_handler is not None
    answer = await _webrtc_handler.handle_web_request(
        request=webrtc_request,
        webrtc_connection_callback=connection_callback,
    )
    return JSONResponse(content=answer)


@app.patch("/sessions/{session_id}/api/offer")
async def webrtc_ice_candidate(session_id: str, request: Request) -> Response:
    """Handle WebRTC ICE candidate."""
    if session_id not in _active_sessions:
        return Response(content="Invalid session_id", status_code=404)

    request_data = await request.json()
    from pipecat.transports.smallwebrtc.request_handler import IceCandidate

    patch_request = SmallWebRTCPatchRequest(
        pc_id=request_data["pc_id"],
        candidates=[IceCandidate(**c) for c in request_data.get("candidates", [])],
    )
    assert _webrtc_handler is not None
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
    caller_phone = str(form.get("From", ""))

    settings = load_settings()
    supabase = create_service_client(settings)

    logger.info("[twilio] Incoming call from %s", caller_phone)

    user_record = lookup_user_by_phone(caller_phone, supabase)

    if user_record is None:
        logger.info("[twilio] Unknown caller %s, rejecting", caller_phone)
        twiml = build_twiml_reject("This phone number is not registered. Goodbye.")
        return Response(content=twiml, media_type="text/xml")

    if user_record["pin_locked"]:
        logger.info("[twilio] Account locked for user %s", user_record["user_id"])
        twiml = build_twiml_reject("Your account is locked. Please contact support. Goodbye.")
        return Response(content=twiml, media_type="text/xml")

    if not check_usage_limit(user_record["user_id"], supabase):
        logger.info("[twilio] Usage limit exceeded for user %s", user_record["user_id"])
        twiml = build_twiml_reject("You have reached your monthly call limit. Goodbye.")
        return Response(content=twiml, media_type="text/xml")

    twiml = build_twiml_gather_pin(user_record["user_id"], attempt=1)
    logger.info("[twilio] Returning TwiML:\n%s", twiml)
    return Response(content=twiml, media_type="text/xml")


@app.post("/twilio/verify-pin")
async def twilio_verify_pin(request: Request) -> Response:
    """Verify the caller's PIN and connect to the media stream."""
    form = await request.form()
    digits = str(form.get("Digits", ""))
    user_id = request.query_params.get("userId", "")
    attempt = int(request.query_params.get("attempt", "1"))

    if not user_id:
        twiml = build_twiml_reject("Authentication error. Goodbye.")
        return Response(content=twiml, media_type="text/xml")

    settings = load_settings()
    supabase = create_service_client(settings)

    pin_response = (
        supabase.table("user_settings")
        .select("pin_hash")
        .eq("user_id", user_id)
        .single()
        .execute()
    )

    pin_data = cast(dict[str, Any], pin_response.data) if pin_response.data is not None else None
    if pin_data is None or not pin_data.get("pin_hash"):
        twiml = build_twiml_reject("PIN not configured. Goodbye.")
        return Response(content=twiml, media_type="text/xml")

    pin_hash = str(pin_data["pin_hash"])

    if verify_pin(digits, pin_hash):
        stream_url = f"wss://{request.url.hostname}/twilio-stream"

        public_url = settings.public_url
        if public_url and public_url != f"http://localhost:{settings.port}":
            ws_scheme = "wss" if public_url.startswith("https") else "ws"
            host = public_url.split("://", 1)[1].rstrip("/")
            stream_url = f"{ws_scheme}://{host}/twilio-stream"

        logger.info("[twilio] PIN verified for user %s, connecting stream", user_id)
        twiml = build_twiml_connect(stream_url, user_id)
        return Response(content=twiml, media_type="text/xml")

    next_attempt = attempt + 1
    if next_attempt > MAX_PIN_ATTEMPTS:
        supabase.table("user_settings").update(
            {"pin_locked": True}
        ).eq("user_id", user_id).execute()

        logger.info("[twilio] Max PIN attempts reached, locking user %s", user_id)
        twiml = build_twiml_reject("Too many incorrect attempts. Your account has been locked. Goodbye.")
        return Response(content=twiml, media_type="text/xml")

    logger.info("[twilio] Incorrect PIN for user %s, attempt %d", user_id, attempt)
    twiml = build_twiml_gather_pin(user_id, attempt=next_attempt)
    return Response(content=twiml, media_type="text/xml")


@app.websocket("/twilio-stream")
async def twilio_stream_ws(websocket: WebSocket) -> None:
    """Handle Twilio media stream WebSocket connections.

    userId is passed via <Parameter> in TwiML. Twilio delivers it in
    the "start" event's customParameters. We intercept the first messages
    to extract it, then replay them into a queue so the TwilioTransport
    read loop still sees them.
    """
    await websocket.accept()

    # Buffer early messages so the transport can replay them
    buffered_messages: list[str] = []
    user_id = ""

    for _ in range(5):
        raw = await websocket.receive_text()
        buffered_messages.append(raw)
        msg = json.loads(raw)
        if msg.get("event") == "start":
            custom_params = msg.get("start", {}).get("customParameters", {})
            user_id = custom_params.get("userId", "")
            break

    if not user_id:
        logger.error("[twilio] No userId in stream start message")
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
        buffered_messages=buffered_messages,
    )

    task, session, cost_tracker, langfuse_observer, imap_holder = await _setup_pipeline_session(
        transport, user_context, settings, supabase, transport_type="twilio"
    )

    async def _send_greeting():
        await asyncio.sleep(0.5)
        await task.queue_frames([LLMRunFrame()])

    asyncio.create_task(_send_greeting())

    try:
        runner = PipelineRunner(handle_sigint=False)
        await runner.run(task)
    finally:
        await _cleanup_session(imap_holder, cost_tracker, langfuse_observer, session, supabase, settings)


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
