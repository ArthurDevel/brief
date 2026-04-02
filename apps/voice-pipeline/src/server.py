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
from typing import Any, cast

import httpx
import uvicorn
from fastapi import BackgroundTasks, FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.runner import PipelineRunner
from pipecat.runner.utils import parse_telephony_websocket
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.network.small_webrtc import SmallWebRTCTransport
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from aiortc import RTCIceServer
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)

from src.auth.jwt_auth import verify_token
from src.auth.twilio_auth import (
    MAX_NO_INPUT_REPEATS,
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
from src.pipeline import create_pipeline, PipelineResult
from src.scheduler import start_scheduler
from src.session import end_session, load_user_context, start_session
from src.supabase_client import create_service_client
from src.tools.email_client import close_imap_connection, create_imap_connection
from src.tools import contact_sync
from src import session_logger

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

TWILIO_PIPELINE_SAMPLE_RATE = 8000
WEBRTC_PIPELINE_SAMPLE_RATE = 16000
METERED_CREDENTIALS_URL = "https://0x41.metered.live/api/v1/turn/credentials"



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

    aiortc only uses the first STUN and first TURN server, so we pick
    the best candidates: STUN on port 80, and TURNS over TCP on port 443
    (most likely to work through firewalls/proxies).

    Args:
        raw_servers: List of dicts with urls/username/credential from Metered API.

    Returns:
        List of RTCIceServer objects (1 STUN + 1 TURN) for aiortc.
    """
    stun_server: dict | None = None
    turn_server: dict | None = None

    # Find the best STUN and TURN server from the list
    for server in raw_servers:
        raw = server.get("urls") or server.get("url") or ""
        url: str = raw[0] if isinstance(raw, list) else raw

        # Prefer TURNS over TCP on 443 (works through any proxy)
        if url.startswith("turns:") and "transport=tcp" in url:
            turn_server = server
        # Fallback: any TURN server if no TURNS found yet
        elif url.startswith("turn:") and not turn_server:
            turn_server = server
        # Pick first STUN server
        elif url.startswith("stun:") and not stun_server:
            stun_server = server

    # Build RTCIceServer list -- TURN first so aioice picks it before STUN
    ice_servers: list[RTCIceServer] = []
    for selected in [turn_server, stun_server]:
        if not selected:
            continue
        raw_urls = selected.get("urls") or selected.get("url")
        if not raw_urls:
            continue
        url_list: list[str] = [raw_urls] if isinstance(raw_urls, str) else raw_urls
        ice_servers.append(RTCIceServer(
            urls=url_list,
            username=selected.get("username", ""),
            credential=selected.get("credential", ""),
        ))
    return ice_servers


RETRYABLE_HOOK_ERRORS = (httpx.ConnectError, httpx.TimeoutException)
MAX_HOOK_ATTEMPTS = 2
HOOK_RETRY_DELAY_S = 2


async def _trigger_end_of_session_hook(session_id: str, web_app_url: str, internal_api_key: str) -> None:
    """Fire the end-of-session webhook on the web app.

    Builds the URL, makes the POST request, and logs the result.
    Retries once after a 2s delay for transient network errors
    (ConnectError, TimeoutException). All other errors fail immediately.

    This function never raises -- errors are logged as warnings.

    Args:
        session_id: The session ID to include in the URL.
        web_app_url: Base URL of the web app.
        internal_api_key: Bearer token for the internal API.
    """
    url = f"{web_app_url}/api/sessions/{session_id}/end-of-session"
    try:
        for attempt in range(1, MAX_HOOK_ATTEMPTS + 1):
            try:
                hook_start = asyncio.get_event_loop().time()
                async with httpx.AsyncClient(timeout=10.0) as client:
                    response = await client.post(
                        url,
                        headers={"Authorization": f"Bearer {internal_api_key}"},
                    )
                    response.raise_for_status()
                    elapsed_ms = (asyncio.get_event_loop().time() - hook_start) * 1000
                    logger.info("[server] End-of-session hook completed for session %s in %.0fms (url=%s)", session_id, elapsed_ms, url)
                    return
            except RETRYABLE_HOOK_ERRORS as exc:
                logger.warning(
                    "[server] End-of-session hook attempt %d/%d failed for session %s (%s): %s (url=%s)",
                    attempt, MAX_HOOK_ATTEMPTS, session_id, type(exc).__name__, exc, url,
                )
                if attempt < MAX_HOOK_ATTEMPTS:
                    await asyncio.sleep(HOOK_RETRY_DELAY_S)
    except BaseException as exc:
        logger.warning(
            "[server] End-of-session hook failed for session %s (%s): %s (url=%s)",
            session_id, type(exc).__name__, exc, url,
        )


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


async def cancel_stt_tasks(stt: DeepgramFluxSTTService) -> None:
    """Cancel any surviving asyncio tasks owned by the STT service's task manager.

    After the pipeline runner returns, the Deepgram Flux STT service may still
    have dangling tasks stuck in a reconnect loop. This function force-cancels
    them so they do not leak across sessions.

    No public API exists for this. May break on pipecat upgrades.

    Args:
        stt: The DeepgramFluxSTTService instance whose tasks should be cancelled.
    """
    if not hasattr(stt, "_task_manager") or stt._task_manager is None:
        return

    tasks = stt._task_manager.current_tasks()
    if not tasks:
        return

    for task in tasks:
        task.cancel()

    try:
        await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=5.0,
        )
    except asyncio.TimeoutError:
        logger.warning("[server] Timed out waiting for %d STT tasks to cancel", len(tasks))

    logger.info("[server] Cancelled %d dangling STT task(s)", len(tasks))


# ============================================================================
# BOT HANDLER (shared by WebRTC and Twilio)
# ============================================================================

async def _setup_pipeline_session(transport, user_context, settings, supabase, transport_type):
    """Set up a pipeline session: create session, IMAP connection, cost tracker, and pipeline.

    Args:
        transport: Pipecat transport (SmallWebRTC or FastAPIWebsocketTransport).
        user_context: Loaded user context with IMAP/SMTP config.
        settings: App settings.
        supabase: Supabase client.
        transport_type: "webrtc" or "twilio".

    Returns:
        Tuple of (pipeline_result, session, cost_tracker, langfuse_observer, imap_holder).
    """
    session = start_session(user_context.user_id, supabase)
    session_logger.start(session.session_id)
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
        # Sample rate depends on transport: 8kHz for Twilio (mulaw native),
        # 16kHz for WebRTC (Flux STT native rate)
        sample_rate = TWILIO_PIPELINE_SAMPLE_RATE if transport_type == "twilio" else WEBRTC_PIPELINE_SAMPLE_RATE
        audio_config = {
            "sample_rate": sample_rate,
            "num_channels": 1,
        }

        pipeline_result = create_pipeline(
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
            recording_enabled=settings.recording_enabled,
        )

        # Register so lifespan shutdown can finalize if the process is killed
        _live_pipeline_sessions[session.session_id] = {
            "session": session,
            "cost_tracker": cost_tracker,
            "langfuse_observer": langfuse_observer,
            "imap_holder": imap_holder,
            "supabase": supabase,
            "settings": settings,
            "narration_http_session": pipeline_result.narration_http_session,
        }

        return pipeline_result, session, cost_tracker, langfuse_observer, imap_holder

    except Exception:
        session_logger.stop(session.session_id)
        try:
            close_imap_connection(imap_client)
        except Exception as exc:
            logger.warning("[server] Error closing IMAP on setup failure: %s", exc)
        raise


async def _cleanup_session(
    imap_holder,
    cost_tracker,
    langfuse_observer,
    session,
    supabase,
    settings,
    narration_http_session: dict[str, Any] | None = None,
) -> None:
    """Clean up after a pipeline session ends.

    Fetches actual LLM costs from OpenRouter before finalizing the session.
    Closes the narration HTTP session if one was created.

    Args:
        imap_holder: Mutable IMAP client holder.
        cost_tracker: Cost tracker for the session.
        langfuse_observer: Langfuse observer for the session.
        session: Active session to finalize.
        supabase: Supabase client.
        settings: App settings (for OpenRouter API key).
        narration_http_session: Mutable dict holding the shared aiohttp session, or None.
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

    # Trigger end-of-session processing (e.g. summary email) on the web app.
    # Awaited so hook logs are captured before session_logger.stop() below.
    if session_ended:
        await _trigger_end_of_session_hook(session.session_id, settings.web_app_url, settings.internal_api_key)

    # Close the narration HTTP session if one was lazily created
    if narration_http_session is not None and narration_http_session.get("session") is not None:
        try:
            await narration_http_session["session"].close()
        except BaseException as exc:
            logger.warning("[server] Error closing narration HTTP session: %s", exc)

    # Capture and upload session logs
    log_text = session_logger.stop(session.session_id)
    if log_text:
        await session_logger.upload_session_logs(session.session_id, log_text, supabase)

    # Incremental contact sync (fire-and-forget, never blocks cleanup)
    if imap_holder.get("config"):
        try:
            contact_sync.incremental_sync(imap_holder["config"], session.user_id, supabase)
            logger.info("[server] Incremental contact sync completed for user %s", session.user_id)
        except Exception as exc:
            logger.warning("[server] Incremental contact sync failed for user %s: %s", session.user_id, exc)

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

    pipeline_result, session, cost_tracker, langfuse_observer, imap_holder = await _setup_pipeline_session(
        transport, user_context, settings, supabase, transport_type="webrtc"
    )
    task = pipeline_result.task

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport_instance, client):
        logger.info("[server] WebRTC client connected, sending greeting")
        if pipeline_result.audio_buffer:
            await pipeline_result.audio_buffer.start_recording()
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport_instance, client):
        logger.info("[server] WebRTC client disconnected")
        await task.cancel()

    try:
        runner = PipelineRunner(handle_sigint=False)
        await runner.run(task)
    finally:
        await cancel_stt_tasks(pipeline_result.stt)
        await _cleanup_session(
            imap_holder, cost_tracker, langfuse_observer, session, supabase, settings,
            narration_http_session=pipeline_result.narration_http_session,
        )


# ============================================================================
# FASTAPI APP
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage app lifecycle: initialize and clean up WebRTC handler and Langfuse."""
    global _webrtc_handler

    # Fetch TURN/STUN servers so the server-side peer connection can traverse NAT
    settings = load_settings()
    session_logger.install()
    logger.info("[server] METERED_API_KEY present: %s", bool(settings.metered_api_key))
    ice_servers = None
    if settings.metered_api_key:
        try:
            ice_servers = await _fetch_ice_servers(settings.metered_api_key)
            logger.info("[server] Loaded %d ICE servers from Metered: %s", len(ice_servers), ice_servers)
        except Exception as exc:
            logger.exception("[server] Failed to fetch ICE servers at startup: %s", exc)
    else:
        logger.warning("[server] No METERED_API_KEY set, skipping TURN server setup")

    # Test actual TURN allocation from inside the container
    if ice_servers:
        try:
            from aioice import Connection as AioIceConnection
            from aiortc.rtcicetransport import connection_kwargs
            ice_kwargs = connection_kwargs(ice_servers)
            logger.info("[server] TURN test: aioice kwargs = %s", ice_kwargs)
            test_conn = AioIceConnection(ice_controlling=True, **ice_kwargs)
            await test_conn.gather_candidates()
            candidates = test_conn.local_candidates
            for c in candidates:
                logger.info("[server] TURN test candidate: type=%s host=%s:%s transport=%s", c.type, c.host, c.port, c.transport)
            relay_count = sum(1 for c in candidates if c.type == "relay")
            if relay_count == 0:
                logger.error("[server] TURN test: no relay candidates -- TURN relay will NOT work")
            else:
                logger.info("[server] TURN test: %d relay candidate(s) -- TURN is working", relay_count)
            await test_conn.close()
        except Exception as exc:
            logger.exception("[server] TURN allocation test failed: %s", exc)

    logger.info("[server] Creating SmallWebRTCRequestHandler with ice_servers=%s", ice_servers)
    _webrtc_handler = SmallWebRTCRequestHandler(ice_servers=ice_servers)

    # Start the scheduled-call background loop (only if Twilio credentials are set)
    scheduler_task = await start_scheduler(
        settings,
        supabase_factory=lambda: create_service_client(settings),
    )

    yield

    # Cancel the scheduler task if it was started
    if scheduler_task is not None:
        scheduler_task.cancel()
        try:
            await scheduler_task
        except asyncio.CancelledError:
            pass
        logger.info("[server] Scheduler task cancelled")

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
                narration_http_session=info.get("narration_http_session"),
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
# ENDPOINTS: INTERNAL API
# ============================================================================

def _run_contact_sync(user_id: str, mode: str = "full") -> None:
    """Background task: load IMAP config from DB/Vault and run contact sync.

    Args:
        user_id: The user to sync contacts for.
        mode: "full" for full scan, "incremental" for delta-only scan.
    """
    logger.info("[server] Contact sync background task started for user %s (mode=%s)", user_id, mode)
    try:
        settings = load_settings()
        supabase = create_service_client(settings)

        # Load IMAP config from DB + Vault (same pattern as load_user_context)
        settings_response = (
            supabase.table("user_settings")
            .select("imap_host, imap_port, imap_user, imap_password_secret_id")
            .eq("user_id", user_id)
            .single()
            .execute()
        )

        if not settings_response.data:
            logger.error("[server] sync-contacts: no settings found for user %s", user_id)
            return

        row = cast(dict[str, Any], settings_response.data)
        if not row.get("imap_password_secret_id"):
            logger.error("[server] sync-contacts: no IMAP credentials for user %s", user_id)
            return

        from src.tools.vault import retrieve_secret
        imap_password = retrieve_secret(supabase, str(row["imap_password_secret_id"]))

        from src.session import ImapConfig
        imap_config = ImapConfig(
            host=str(row["imap_host"]),
            port=int(row["imap_port"]),
            user=str(row["imap_user"]),
            password=imap_password,
        )

        if mode == "incremental":
            count = contact_sync.incremental_sync(imap_config, user_id, supabase)
            logger.info("[server] Incremental contact sync completed for user %s: %d contacts", user_id, count)
        else:
            count = contact_sync.full_sync(imap_config, user_id, supabase)
            logger.info("[server] Full contact sync completed for user %s: %d contacts", user_id, count)

    except Exception as exc:
        logger.error("[server] Contact sync failed for user %s (mode=%s): %s", user_id, mode, exc)


@app.post("/sync-contacts")
async def sync_contacts(request: Request, background_tasks: BackgroundTasks) -> JSONResponse:
    """Trigger a full contact sync for a user. Returns immediately, sync runs in background.

    Authenticated with INTERNAL_API_KEY via Bearer header.
    """
    settings = load_settings()

    # Authenticate
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer ") or auth_header[7:] != settings.internal_api_key:
        return JSONResponse({"error": "Unauthorized"}, status_code=401)

    body = await request.json()
    user_id = body.get("user_id")
    if not user_id:
        return JSONResponse({"error": "Missing user_id"}, status_code=400)

    mode = body.get("mode", "full")
    background_tasks.add_task(_run_contact_sync, user_id, mode)
    return JSONResponse({"status": "queued"})


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
            logger.exception("[server] Failed to fetch TURN credentials: %s", exc)
    else:
        logger.warning("[server] /start: no METERED_API_KEY, skipping TURN")

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
        twiml = build_twiml_reject("This phone number is not linked to a Brief account. Please create an account on brief dot ai and add your phone number in settings. Goodbye.")
        return Response(content=twiml, media_type="text/xml")

    if user_record["pin_locked"]:
        logger.info("[twilio] Account locked for user %s", user_record["user_id"])
        twiml = build_twiml_reject("Your account is locked. Please contact support. Goodbye.")
        return Response(content=twiml, media_type="text/xml")

    if not user_record["pin_configured"]:
        logger.info("[twilio] PIN not configured for user %s", user_record["user_id"])
        twiml = build_twiml_reject("Not configured. Please complete the onboarding or set your pin in settings.")
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


@app.post("/twilio/no-input")
async def twilio_no_input(request: Request) -> Response:
    """Handle Twilio redirect when the caller provides no PIN input.

    Re-prompts the caller up to MAX_NO_INPUT_REPEATS times before hanging up.
    """
    user_id = request.query_params.get("userId", "")
    attempt = request.query_params.get("attempt", "1")
    no_input_count = request.query_params.get("noInputCount", "1")

    logger.info("[twilio] No input from user %s, repeat %s/%s", user_id, no_input_count, MAX_NO_INPUT_REPEATS)

    twiml = build_twiml_gather_pin(user_id, attempt=int(attempt), no_input_count=int(no_input_count))
    return Response(content=twiml, media_type="text/xml")


@app.post("/twilio/scheduled-call")
async def twilio_scheduled_call(request: Request) -> Response:
    """Handle Twilio callback for scheduled outbound calls.

    Validates the internal API key from query params, then returns
    TwiML to connect the answered call to the media stream pipeline.
    Twilio sends this callback as form-encoded POST when the callee answers.
    """
    token = request.query_params.get("token", "")
    user_id = request.query_params.get("userId", "")

    settings = load_settings()

    if not token or token != settings.internal_api_key:
        logger.warning("[twilio] Scheduled call: invalid or missing token")
        return Response(content="Unauthorized", status_code=401)

    if not user_id:
        twiml = build_twiml_reject("Missing user identifier. Goodbye.")
        return Response(content=twiml, media_type="text/xml")

    # Parse form data (Twilio sends application/x-www-form-urlencoded)
    await request.form()

    # Build stream URL from settings.public_url (same logic as verify-pin)
    stream_url = f"wss://{request.url.hostname}/twilio-stream"

    public_url = settings.public_url
    if public_url and public_url != f"http://localhost:{settings.port}":
        ws_scheme = "wss" if public_url.startswith("https") else "ws"
        host = public_url.split("://", 1)[1].rstrip("/")
        stream_url = f"{ws_scheme}://{host}/twilio-stream"

    logger.info("[twilio] Scheduled call answered for user %s, connecting stream", user_id)
    twiml = build_twiml_connect(stream_url, user_id)
    return Response(content=twiml, media_type="text/xml")


@app.websocket("/twilio-stream")
async def twilio_stream_ws(websocket: WebSocket) -> None:
    """Handle Twilio media stream WebSocket connections.

    Uses parse_telephony_websocket() to extract stream metadata, then builds
    a pipeline with TwilioFrameSerializer + FastAPIWebsocketTransport.

    userId is passed via <Parameter> in TwiML. Twilio delivers it in
    the "start" event's customParameters, available via call_data["body"].
    """
    await websocket.accept()

    # parse_telephony_websocket reads the "connected" and "start" messages,
    # returning (transport_type, call_data). After this call, subsequent
    # messages flow through the transport's receive loop.
    _transport_type, call_data = await parse_telephony_websocket(websocket)
    stream_sid: str = call_data.get("stream_id", "")
    call_sid: str = call_data.get("call_id", "")
    body: dict[str, Any] = call_data.get("body", {})
    user_id: str = body.get("userId", "")

    if not user_id:
        logger.error("[twilio] No userId in stream start message")
        await websocket.close(code=1008, reason="Missing userId")
        return

    logger.info(
        "[twilio] Stream metadata: stream_sid=%s, call_sid=%s, user_id=%s",
        stream_sid, call_sid, user_id,
    )

    settings = load_settings()
    supabase = create_service_client(settings)

    logger.info("[twilio] Media stream connected for user %s", user_id)

    user_context = load_user_context(user_id, supabase)

    # TwilioFrameSerializer handles mulaw 8kHz <-> PCM16 transcoding via SOXR
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

    pipeline_result, session, cost_tracker, langfuse_observer, imap_holder = await _setup_pipeline_session(
        transport, user_context, settings, supabase, transport_type="twilio"
    )
    task = pipeline_result.task

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport_instance, client):
        logger.info("[twilio] Client connected, sending greeting")
        if pipeline_result.audio_buffer:
            await pipeline_result.audio_buffer.start_recording()
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport_instance, client):
        logger.info("[twilio] Client disconnected, cancelling pipeline")
        await task.cancel()

    try:
        runner = PipelineRunner(handle_sigint=False)
        await runner.run(task)
    finally:
        await cancel_stt_tasks(pipeline_result.stt)
        await _cleanup_session(
            imap_holder, cost_tracker, langfuse_observer, session, supabase, settings,
            narration_http_session=pipeline_result.narration_http_session,
        )


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
