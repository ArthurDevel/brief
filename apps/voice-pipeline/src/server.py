"""
FastAPI application for the Pipecat voice pipeline.

Serves the WebRTC browser calling interface, Twilio phone calling endpoints,
and a health check. Two transport paths coexist: WebRTC for browser clients
and a custom TwilioTransport for phone calls via Twilio Media Streams.

- create_app: build the FastAPI app with all routes
- GET /health: status check
- POST /twilio/voice: incoming Twilio call handler (phone lookup, TwiML Gather)
- POST /twilio/verify-pin: PIN verification, returns TwiML Connect or reject
- WS /twilio-stream: Twilio media stream WebSocket, runs the pipeline
- bot: Pipecat entry point for WebRTC connections
- __main__: run the app with SmallWebRTCConnection
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import JSONResponse, Response

from pipecat.frames.frames import LLMMessagesFrame
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.network.small_webrtc import SmallWebRTCTransport
from pipecat.transports.network.webrtc_connection import SmallWebRTCConnection

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


# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

def create_app() -> FastAPI:
    """Create the FastAPI application with all routes.

    Returns:
        Configured FastAPI app instance.
    """
    app = FastAPI(title="Voice Pipeline")

    # ------------------------------------------------------------------
    # Health check
    # ------------------------------------------------------------------

    @app.get("/health")
    async def health() -> JSONResponse:
        """Health check endpoint.

        Returns:
            JSON response with status "ok".
        """
        return JSONResponse({"status": "ok"})

    # ------------------------------------------------------------------
    # Twilio endpoints
    # ------------------------------------------------------------------

    @app.post("/twilio/voice")
    async def twilio_voice(request: Request) -> Response:
        """Handle incoming Twilio voice calls.

        Looks up the caller by phone number. If found and not locked,
        returns TwiML that gathers a 6-digit PIN via DTMF. If not found
        or account is locked, returns a rejection TwiML.

        Args:
            request: The incoming HTTP request with Twilio form data.

        Returns:
            TwiML XML response.
        """
        form = await request.form()
        caller_phone = form.get("From", "")

        settings = load_settings()
        supabase = create_service_client(settings)

        logger.info("[twilio] Incoming call from %s", caller_phone)

        # Look up the caller
        user_record = lookup_user_by_phone(caller_phone, supabase)

        if user_record is None:
            logger.info("[twilio] Unknown caller %s, rejecting", caller_phone)
            twiml = build_twiml_reject("This phone number is not registered. Goodbye.")
            return Response(content=twiml, media_type="application/xml")

        if user_record["pin_locked"]:
            logger.info("[twilio] Account locked for user %s", user_record["user_id"])
            twiml = build_twiml_reject("Your account is locked. Please contact support. Goodbye.")
            return Response(content=twiml, media_type="application/xml")

        # Check usage limits
        if not check_usage_limit(user_record["user_id"], supabase):
            logger.info("[twilio] Usage limit exceeded for user %s", user_record["user_id"])
            twiml = build_twiml_reject("You have reached your monthly call limit. Goodbye.")
            return Response(content=twiml, media_type="application/xml")

        # Prompt for PIN
        twiml = build_twiml_gather_pin(user_record["user_id"], attempt=1)
        return Response(content=twiml, media_type="application/xml")

    @app.post("/twilio/verify-pin")
    async def twilio_verify_pin(request: Request) -> Response:
        """Verify the caller's PIN and connect to the media stream.

        Reads the DTMF digits from Twilio's form data, verifies against
        the stored bcrypt hash. On success, returns TwiML Connect with
        a WebSocket stream URL. On failure, either retries or rejects.

        Args:
            request: The incoming HTTP request with Twilio form data.

        Returns:
            TwiML XML response.
        """
        form = await request.form()
        digits = form.get("Digits", "")
        user_id = request.query_params.get("userId", "")
        attempt = int(request.query_params.get("attempt", "1"))

        if not user_id:
            twiml = build_twiml_reject("Authentication error. Goodbye.")
            return Response(content=twiml, media_type="application/xml")

        settings = load_settings()
        supabase = create_service_client(settings)

        # Fetch the PIN hash from user_settings
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
            # PIN correct -- connect to media stream
            stream_url = f"wss://{request.url.hostname}/twilio-stream?userId={user_id}"

            # Use public_url if configured (for ngrok/production)
            public_url = settings.public_url
            if public_url and public_url != "http://localhost:7860":
                ws_scheme = "wss" if public_url.startswith("https") else "ws"
                host = public_url.split("://", 1)[1].rstrip("/")
                stream_url = f"{ws_scheme}://{host}/twilio-stream?userId={user_id}"

            logger.info("[twilio] PIN verified for user %s, connecting stream", user_id)
            twiml = build_twiml_connect(stream_url)
            return Response(content=twiml, media_type="application/xml")

        # PIN incorrect
        next_attempt = attempt + 1
        if next_attempt > MAX_PIN_ATTEMPTS:
            # Lock the account after max attempts
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
        """Handle Twilio media stream WebSocket connections.

        Creates a TwilioTransport, loads user context, builds and runs the
        full Pipecat pipeline. Each session gets its own IMAP connection,
        which is closed in the finally block.

        Args:
            websocket: The WebSocket connection from Twilio.
        """
        await websocket.accept()

        user_id = websocket.query_params.get("userId", "")
        if not user_id:
            logger.error("[twilio] No userId in WebSocket query params")
            await websocket.close(code=1008, reason="Missing userId")
            return

        settings = load_settings()
        supabase = create_service_client(settings)

        logger.info("[twilio] Media stream connected for user %s", user_id)

        # Load user context
        user_context = load_user_context(user_id, supabase)

        # Create session
        session = start_session(user_id, supabase)

        # Create cost tracker
        cost_tracker = CostTracker()

        # Create IMAP connection for this session
        imap_client = create_imap_connection(user_context.imap_config)
        imap_holder = {
            "client": imap_client,
            "config": user_context.imap_config,
        }

        try:
            # Create Twilio transport
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
            }

            # Build the pipeline
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

            # Send initial greeting after the pipeline starts.
            # The TwiML already says "Connected. How can I help you?" but
            # the pipeline should also send a greeting frame for consistency.
            async def _send_greeting():
                # Small delay to let the pipeline initialize
                await asyncio.sleep(0.5)
                await task.queue_frames(
                    [LLMMessagesFrame(messages=[
                        {"role": "system", "content": "Greet the user briefly."},
                    ])]
                )

            asyncio.create_task(_send_greeting())

            # Run the pipeline (blocks until stream ends)
            await task.run()

        finally:
            # Close IMAP connection
            try:
                close_imap_connection(imap_holder["client"])
            except Exception as exc:
                logger.warning("[twilio] Error closing IMAP connection: %s", exc)

            # End session and record cost
            try:
                cost_summary = cost_tracker.get_summary()
                end_session(session, cost_summary, supabase)
            except Exception as exc:
                logger.error("[twilio] Error ending session: %s", exc)

    return app


# ============================================================================
# WEBRTC BOT HANDLER
# ============================================================================

async def bot(
    webrtc_connection: SmallWebRTCConnection,
) -> None:
    """Pipecat entry point for WebRTC browser connections.

    Verifies the JWT token, loads user context, creates an IMAP connection,
    builds and runs the full pipeline. Cleans up IMAP on disconnect.

    Args:
        webrtc_connection: The WebRTC connection from Pipecat runner.
    """
    settings = load_settings()
    supabase = create_service_client(settings)

    # Extract and verify JWT token from connection parameters
    token = webrtc_connection.token
    if not token:
        logger.error("[server] No token provided in WebRTC connection")
        return

    user_id = verify_token(token, supabase)
    if not user_id:
        logger.error("[server] Invalid or expired token")
        return

    logger.info("[server] Authenticated user %s via WebRTC", user_id)

    # Load user context (settings, memory, credentials)
    user_context = load_user_context(user_id, supabase)

    # Create session
    session = start_session(user_id, supabase)

    # Create cost tracker
    cost_tracker = CostTracker()

    # Create IMAP connection for this session
    imap_client = create_imap_connection(user_context.imap_config)
    imap_holder = {
        "client": imap_client,
        "config": user_context.imap_config,
    }

    try:
        # Create WebRTC transport
        transport = SmallWebRTCTransport(
            webrtc_connection=webrtc_connection,
            vad_enabled=True,
        )

        audio_config = {
            "sample_rate": 16000,
            "num_channels": 1,
        }

        # Build the pipeline
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

        # Send initial LLMRunFrame after transport is ready to trigger greeting.
        # Without this, the assistant stays silent until the user speaks first.
        @transport.event_handler("on_client_connected")
        async def on_client_connected(transport, client):
            logger.info("[server] WebRTC client connected, sending greeting frame")
            await task.queue_frames(
                [LLMMessagesFrame(messages=[
                    {"role": "system", "content": "Greet the user briefly."},
                ])]
            )

        # Run the pipeline
        await task.run()

    finally:
        # Close IMAP connection
        try:
            close_imap_connection(imap_holder["client"])
        except Exception as exc:
            logger.warning("[server] Error closing IMAP connection: %s", exc)

        # End session and record cost
        try:
            cost_summary = cost_tracker.get_summary()
            end_session(session, cost_summary, supabase)
        except Exception as exc:
            logger.error("[server] Error ending session: %s", exc)


# ============================================================================
# APP RUNNER
# ============================================================================

if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO)

    settings = load_settings()

    app = create_app()
    webrtc_connection = SmallWebRTCConnection()

    # Mount the WebRTC client page
    app.mount("/client", webrtc_connection.get_client_app())

    # Register the bot entry point
    @app.post("/connect")
    async def connect(request_data: dict):
        """Handle WebRTC connection requests."""
        return await webrtc_connection.connect(request_data)

    @app.post("/disconnect")
    async def disconnect(request_data: dict):
        """Handle WebRTC disconnection requests."""
        return await webrtc_connection.disconnect(request_data)

    # Start the Pipecat runner with the bot function
    from pipecat.transports.network.small_webrtc import SmallWebRTCTransport

    import uvicorn

    # Register the bot function
    webrtc_connection.on_bot_ready(bot)

    logger.info("[server] Starting voice pipeline on port %d", settings.port)
    uvicorn.run(app, host="0.0.0.0", port=settings.port)
