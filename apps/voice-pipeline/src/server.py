"""
FastAPI application for the Pipecat voice pipeline.

Uses pipecat.runner.run.main() for WebRTC signaling (SmallWebRTC) and
patches the runner's FastAPI app to add Twilio phone calling endpoints.

- bot(): Pipecat entry point for WebRTC connections (called by the runner)
- GET /health: status check
- POST /twilio/voice: incoming Twilio call handler (phone lookup, TwiML Gather)
- POST /twilio/verify-pin: PIN verification, returns TwiML Connect or reject
- WS /twilio-stream: Twilio media stream WebSocket, runs the pipeline
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import Request, WebSocket
from fastapi.responses import JSONResponse, Response

from pipecat.frames.frames import LLMMessagesFrame, LLMRunFrame
from pipecat.pipeline.runner import PipelineRunner
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.network.small_webrtc import SmallWebRTCTransport

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

# Shared mutable config dict -- updated live by the speed API, read by AudioSpeedProcessor
_speed_config: dict[str, float] = {"speed": DEFAULT_SPEED}


# ============================================================================
# WEBRTC BOT HANDLER
# ============================================================================

async def bot(runner_args) -> None:
    """Pipecat entry point for WebRTC browser connections.

    Called by pipecat.runner.run.main() when a WebRTC offer comes in.
    Verifies JWT, loads user context, creates session, IMAP connection,
    and runs the full pipeline with tools.

    Args:
        runner_args: SmallWebRTCRunnerArguments provided by the Pipecat runner.
    """
    settings = load_settings()
    supabase = create_service_client(settings)

    # -- Auth: extract JWT from the offer body (sent as requestData by the client) --
    body = runner_args.body or {}
    token = body.get("token", "")
    if not token:
        logger.error("[server] WebRTC: no token in requestData")
        return

    user_id = verify_token(token, supabase)
    if not user_id:
        logger.error("[server] WebRTC: invalid JWT")
        return

    logger.info("[server] WebRTC client authenticated: user %s", user_id)

    # -- Load user context and start session --
    user_context = load_user_context(user_id, supabase)
    session = start_session(user_id, supabase)
    cost_tracker = CostTracker()

    # -- Create IMAP connection for this session --
    imap_client = create_imap_connection(user_context.imap_config)
    imap_holder = {
        "client": imap_client,
        "config": user_context.imap_config,
    }

    try:
        transport = SmallWebRTCTransport(
            webrtc_connection=runner_args.webrtc_connection,
            params=TransportParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
            ),
        )

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

        @transport.event_handler("on_client_connected")
        async def on_client_connected(transport, client):
            logger.info("[server] WebRTC client connected, sending greeting")
            await task.queue_frames([LLMRunFrame()])

        @transport.event_handler("on_client_disconnected")
        async def on_client_disconnected(transport, client):
            logger.info("[server] WebRTC client disconnected")
            await task.cancel()

        runner = PipelineRunner(handle_sigint=False)
        await runner.run(task)

    finally:
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
# TWILIO ROUTE PATCHING
# ============================================================================

def _patch_routes():
    """Monkey-patch pipecat's server app to add custom endpoints."""
    import json as _json
    import pipecat.runner.run as _pipecat_run

    _orig_create = _pipecat_run._create_server_app

    def _patched_create_server_app(args):
        app = _orig_create(args)

        # -- Health check --
        @app.get("/health")
        async def health() -> JSONResponse:
            return JSONResponse({"status": "ok"})

        # -- Speed API --
        @app.get("/api/speed")
        async def get_speed() -> JSONResponse:
            return JSONResponse({"speed": _speed_config["speed"]})

        @app.post("/api/speed")
        async def set_speed(request: Request) -> JSONResponse:
            body = _json.loads(await request.body())
            speed = float(body.get("speed", _speed_config["speed"]))
            speed = max(0.5, min(2.0, speed))
            _speed_config["speed"] = speed
            logger.info("[server] Speed updated to %.1f", speed)
            return JSONResponse({"speed": speed})

        # -- Twilio: incoming call --
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

        # -- Twilio: verify PIN --
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

        # -- Twilio: media stream WebSocket --
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
            session = start_session(user_id, supabase)
            cost_tracker = CostTracker()

            imap_client = create_imap_connection(user_context.imap_config)
            imap_holder = {
                "client": imap_client,
                "config": user_context.imap_config,
            }

            try:
                params = TwilioParams(
                    audio_in_enabled=True,
                    audio_out_enabled=True,
                )

                transport = TwilioTransport(
                    websocket=websocket,
                    params=params,
                    pipeline_sample_rate=TWILIO_PIPELINE_SAMPLE_RATE,
                )

                audio_config = {
                    "sample_rate": TWILIO_PIPELINE_SAMPLE_RATE,
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

                async def _send_greeting():
                    await asyncio.sleep(0.5)
                    await task.queue_frames([LLMRunFrame()])

                asyncio.create_task(_send_greeting())

                await task.run()

            finally:
                try:
                    close_imap_connection(imap_holder["client"])
                except Exception as exc:
                    logger.warning("[twilio] Error closing IMAP connection: %s", exc)

                try:
                    cost_summary = cost_tracker.get_summary()
                    end_session(session, cost_summary, supabase)
                except Exception as exc:
                    logger.error("[twilio] Error ending session: %s", exc)

        return app

    _pipecat_run._create_server_app = _patched_create_server_app


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    _patch_routes()

    from pipecat.runner.run import main
    main()
