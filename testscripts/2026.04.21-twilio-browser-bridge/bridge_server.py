"""
Twilio-to-browser audio bridge for local voice testing.

- Accepts incoming Twilio voice calls and connects them to a media stream
- Exposes a browser page where you can pick up the call and talk through your mic
- Relays audio both ways between Twilio mu-law 8kHz and browser PCM16 48kHz
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs

import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.websockets import WebSocketState
from twilio.rest import Client as TwilioClient


# ============================================================================
# CONSTANTS
# ============================================================================

DEFAULT_PORT = 8780
STATIC_DIR = Path(__file__).resolve().parent / "static"
TWILIO_SAMPLE_RATE = 8_000
BROWSER_SAMPLE_RATE = 48_000
CALL_RESERVATION_TIMEOUT_SECS = 30
TWILIO_BUSY_MESSAGE = "This test bridge is already busy with another call. Goodbye."
TWILIO_CONNECTING_MESSAGE = "Connecting you to the browser bridge."
SAFE_BROWSER_ERROR_MESSAGE = "Something went wrong. Check the server logs and try again."
G711_BIAS = 0x84
G711_CLIP = 32635
G711_SEGMENT_END = (
    0xFF,
    0x1FF,
    0x3FF,
    0x7FF,
    0xFFF,
    0x1FFF,
    0x3FFF,
    0x7FFF,
)


# ============================================================================
# DATA TRANSFER OBJECTS
# ============================================================================

@dataclass(frozen=True)
class BridgeSettings:
    """Configuration values for the bridge server."""

    port: int
    public_url: str
    twilio_account_sid: str
    twilio_auth_token: str


@dataclass
class BridgeCallDto:
    """Active call state shared across request handlers."""

    call_sid: str
    from_number: str
    stream_sid: str = ""
    twilio_websocket: WebSocket | None = None
    browser_joined: bool = False
    twilio_to_browser_resampler: "StreamingResampler" = field(
        default_factory=lambda: StreamingResampler(TWILIO_SAMPLE_RATE, BROWSER_SAMPLE_RATE)
    )
    browser_to_twilio_resampler: "StreamingResampler" = field(
        default_factory=lambda: StreamingResampler(BROWSER_SAMPLE_RATE, TWILIO_SAMPLE_RATE)
    )


# ============================================================================
# HELPER CLASSES
# ============================================================================

class StreamingResampler:
    """Simple streaming linear resampler for mono float audio."""

    def __init__(self, input_rate: int, output_rate: int) -> None:
        self._input_rate = input_rate
        self._output_rate = output_rate
        self._buffer = np.zeros(0, dtype=np.float32)
        self._position = 0.0

    def process(self, samples: np.ndarray) -> np.ndarray:
        """Resample a mono float32 array while keeping chunk continuity."""
        if samples.size == 0:
            return np.zeros(0, dtype=np.float32)

        if samples.dtype != np.float32:
            raise TypeError("Resampler expects float32 input")

        self._buffer = np.concatenate((self._buffer, samples))
        if self._buffer.size < 2:
            return np.zeros(0, dtype=np.float32)

        max_position = self._buffer.size - 1
        step = self._input_rate / self._output_rate
        output_positions: list[float] = []

        while self._position < max_position:
            output_positions.append(self._position)
            self._position += step

        if not output_positions:
            return np.zeros(0, dtype=np.float32)

        source_positions = np.arange(self._buffer.size, dtype=np.float32)
        output = np.interp(output_positions, source_positions, self._buffer).astype(np.float32)

        consumed_samples = int(self._position)
        if consumed_samples > 0:
            self._buffer = self._buffer[consumed_samples:]
            self._position -= consumed_samples

        return output


class AudioCodec:
    """Audio conversion helpers for Twilio mu-law and browser PCM16."""

    @staticmethod
    def decode_twilio_mulaw(mulaw_audio: bytes) -> np.ndarray:
        """Convert Twilio mu-law bytes into mono float32 audio."""
        samples = [AudioCodec._ulaw_to_linear(sample) for sample in mulaw_audio]
        return (np.asarray(samples, dtype=np.float32) / 32768.0).clip(-1.0, 1.0)

    @staticmethod
    def encode_twilio_mulaw(samples: np.ndarray) -> bytes:
        """Convert mono float32 audio into Twilio mu-law bytes."""
        clipped = np.clip(samples, -1.0, 1.0)
        pcm_samples = np.round(clipped * 32767.0).astype(np.int16)
        return bytes(AudioCodec._linear_to_ulaw(int(sample)) for sample in pcm_samples)

    @staticmethod
    def decode_browser_pcm16(pcm_audio: bytes) -> np.ndarray:
        """Convert browser PCM16 bytes into mono float32 audio."""
        if len(pcm_audio) % 2 != 0:
            raise ValueError("Browser PCM16 payload length must be even")

        int_samples = np.frombuffer(pcm_audio, dtype="<i2").astype(np.float32)
        return (int_samples / 32768.0).clip(-1.0, 1.0)

    @staticmethod
    def encode_browser_pcm16(samples: np.ndarray) -> bytes:
        """Convert mono float32 audio into browser PCM16 bytes."""
        clipped = np.clip(samples, -1.0, 1.0)
        pcm_samples = np.round(clipped * 32767.0).astype("<i2")
        return pcm_samples.tobytes()

    @staticmethod
    def _linear_to_ulaw(sample: int) -> int:
        """Encode a single 16-bit PCM sample to G.711 mu-law."""
        sign_mask = 0x80 if sample < 0 else 0x00
        magnitude = min(abs(sample), G711_CLIP) + G711_BIAS

        segment = 0
        while segment < len(G711_SEGMENT_END) and magnitude > G711_SEGMENT_END[segment]:
            segment += 1

        if segment >= 8:
            return 0x7F ^ sign_mask ^ 0xFF

        mantissa = (magnitude >> (segment + 3)) & 0x0F
        encoded = ~(sign_mask | (segment << 4) | mantissa) & 0xFF
        return encoded

    @staticmethod
    def _ulaw_to_linear(sample: int) -> int:
        """Decode a single G.711 mu-law sample to 16-bit PCM."""
        value = (~sample) & 0xFF
        sign = value & 0x80
        exponent = (value >> 4) & 0x07
        mantissa = value & 0x0F

        magnitude = ((mantissa << 3) + G711_BIAS) << exponent
        pcm_sample = magnitude - G711_BIAS
        return -pcm_sample if sign else pcm_sample


class BridgeService:
    """Coordinates the active call, browser client, and audio relay."""

    def __init__(self, settings: BridgeSettings) -> None:
        self._settings = settings
        self._browser_websocket: WebSocket | None = None
        self._active_call: BridgeCallDto | None = None
        self._lock = asyncio.Lock()
        self._twilio_client = self._create_twilio_client()

    async def reserve_incoming_call(self, call_sid: str, from_number: str) -> bool:
        """Reserve the bridge for an incoming call before Twilio opens the stream."""
        async with self._lock:
            if self._active_call is not None:
                return False

            self._active_call = BridgeCallDto(call_sid=call_sid, from_number=from_number)

        asyncio.create_task(self._expire_reserved_call(call_sid))
        await self._broadcast_state()
        return True

    async def attach_twilio_stream(
        self,
        websocket: WebSocket,
        call_sid: str,
        stream_sid: str,
    ) -> BridgeCallDto:
        """Attach the active Twilio media stream to the reserved call."""
        async with self._lock:
            if self._active_call is None:
                raise RuntimeError("No reserved call exists for this Twilio stream")

            if self._active_call.call_sid != call_sid:
                raise RuntimeError("Twilio stream call SID does not match the reserved call")

            self._active_call.stream_sid = stream_sid
            self._active_call.twilio_websocket = websocket
            call = self._active_call

        await self._broadcast_state()
        return call

    async def register_browser(self, websocket: WebSocket) -> None:
        """Register the single allowed browser control connection."""
        async with self._lock:
            if (
                self._browser_websocket is not None
                and self._browser_websocket.client_state == WebSocketState.CONNECTED
            ):
                raise RuntimeError("Only one browser client can connect at a time")

            self._browser_websocket = websocket

        await self._send_state_to_browser()

    async def unregister_browser(self, websocket: WebSocket) -> None:
        """Unregister the browser connection and end the call if it was picked up."""
        should_end_call = False

        async with self._lock:
            if self._browser_websocket is websocket:
                self._browser_websocket = None
                should_end_call = self._active_call is not None and self._active_call.browser_joined
                if self._active_call is not None:
                    self._active_call.browser_joined = False

        if should_end_call:
            await self.end_active_call("browser_disconnected")

        await self._broadcast_state()

    async def pickup_call(self) -> None:
        """Mark the browser as having picked up the current call."""
        async with self._lock:
            if self._browser_websocket is None:
                raise RuntimeError("Open the browser page before picking up the call")

            if self._active_call is None or self._active_call.twilio_websocket is None:
                raise RuntimeError("There is no active Twilio call to pick up")

            self._active_call.browser_joined = True

        await self._broadcast_state()

    async def end_active_call(self, reason: str) -> None:
        """End the active call and reset the bridge state."""
        twilio_websocket: WebSocket | None = None
        call_sid = ""

        async with self._lock:
            if self._active_call is None:
                return

            twilio_websocket = self._active_call.twilio_websocket
            call_sid = self._active_call.call_sid
            self._active_call = None

        if self._twilio_client is not None and call_sid:
            try:
                await asyncio.to_thread(
                    self._twilio_client.calls(call_sid).update,
                    status="completed",
                )
            except Exception:
                logging.exception("Failed to complete Twilio call %s for reason %s", call_sid, reason)

        if twilio_websocket is not None:
            try:
                await twilio_websocket.close(code=1000, reason=reason)
            except Exception:
                logging.exception("Failed to close Twilio WebSocket for reason %s", reason)

        await self._broadcast_state()

    async def clear_call_if_match(self, call_sid: str) -> None:
        """Clear the active call only if it matches the disconnected call."""
        async with self._lock:
            if self._active_call is None or self._active_call.call_sid != call_sid:
                return

            self._active_call = None

        await self._broadcast_state()

    async def forward_twilio_audio_to_browser(self, payload: str) -> None:
        """Forward inbound Twilio media to the browser as PCM16 binary audio."""
        async with self._lock:
            browser_websocket = self._browser_websocket
            active_call = self._active_call

        if browser_websocket is None or active_call is None or not active_call.browser_joined:
            return

        mulaw_audio = base64.b64decode(payload)
        twilio_samples = AudioCodec.decode_twilio_mulaw(mulaw_audio)
        browser_samples = active_call.twilio_to_browser_resampler.process(twilio_samples)
        if browser_samples.size == 0:
            return

        await browser_websocket.send_bytes(AudioCodec.encode_browser_pcm16(browser_samples))

    async def forward_browser_audio_to_twilio(self, browser_audio: bytes) -> None:
        """Forward browser PCM16 audio to Twilio as mu-law media frames."""
        async with self._lock:
            active_call = self._active_call

        if active_call is None or active_call.twilio_websocket is None:
            return

        if not active_call.browser_joined:
            return

        browser_samples = AudioCodec.decode_browser_pcm16(browser_audio)
        twilio_samples = active_call.browser_to_twilio_resampler.process(browser_samples)
        if twilio_samples.size == 0:
            return

        mulaw_audio = AudioCodec.encode_twilio_mulaw(twilio_samples)
        media_message = {
            "event": "media",
            "streamSid": active_call.stream_sid,
            "media": {
                "payload": base64.b64encode(mulaw_audio).decode("ascii"),
            },
        }
        await active_call.twilio_websocket.send_text(json.dumps(media_message))

    async def send_browser_message(self, message: dict[str, Any]) -> None:
        """Send a control message to the browser if connected."""
        async with self._lock:
            browser_websocket = self._browser_websocket

        if browser_websocket is None:
            return

        if browser_websocket.client_state != WebSocketState.CONNECTED:
            return

        await browser_websocket.send_text(json.dumps(message))

    async def build_bridge_state(self) -> dict[str, Any]:
        """Build the browser-visible bridge state."""
        async with self._lock:
            has_browser = self._browser_websocket is not None
            active_call = self._active_call

            if active_call is None:
                call_state: dict[str, Any] = {
                    "status": "idle",
                    "fromNumber": "",
                    "callSid": "",
                    "streamSid": "",
                    "browserJoined": False,
                }
            else:
                stream_ready = active_call.twilio_websocket is not None
                call_state = {
                    "status": "live" if stream_ready else "ringing",
                    "fromNumber": active_call.from_number,
                    "callSid": active_call.call_sid,
                    "streamSid": active_call.stream_sid,
                    "browserJoined": active_call.browser_joined,
                }

        return {
            "type": "bridge_state",
            "browserConnected": has_browser,
            "call": call_state,
        }

    def _create_twilio_client(self) -> TwilioClient | None:
        """Create a Twilio client only when credentials are present."""
        if not self._settings.twilio_account_sid or not self._settings.twilio_auth_token:
            return None

        return TwilioClient(
            self._settings.twilio_account_sid,
            self._settings.twilio_auth_token,
        )

    async def _broadcast_state(self) -> None:
        """Broadcast the latest bridge state to the browser."""
        try:
            await self._send_state_to_browser()
        except Exception:
            logging.exception("Failed to broadcast bridge state")

    async def _send_state_to_browser(self) -> None:
        """Send the latest bridge state to the browser."""
        message = await self.build_bridge_state()
        await self.send_browser_message(message)

    async def _expire_reserved_call(self, call_sid: str) -> None:
        """Release the bridge if Twilio never opens the reserved media stream."""
        await asyncio.sleep(CALL_RESERVATION_TIMEOUT_SECS)

        async with self._lock:
            if self._active_call is None:
                return

            if self._active_call.call_sid != call_sid:
                return

            if self._active_call.twilio_websocket is not None:
                return

            logging.info("Releasing stale reserved call %s after timeout", call_sid)
            self._active_call = None

        await self._broadcast_state()


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def load_settings() -> BridgeSettings:
    """Load environment configuration for the bridge server."""
    load_dotenv()

    return BridgeSettings(
        port=int(os.getenv("PORT", str(DEFAULT_PORT))),
        public_url=os.getenv("PUBLIC_URL", "").rstrip("/"),
        twilio_account_sid=os.getenv("TWILIO_ACCOUNT_SID", ""),
        twilio_auth_token=os.getenv("TWILIO_AUTH_TOKEN", ""),
    )


def build_connect_twiml(stream_url: str) -> str:
    """Build the TwiML that connects the call to the media stream."""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        f"<Say>{TWILIO_CONNECTING_MESSAGE}</Say>"
        "<Connect>"
        f'<Stream url="{stream_url}" />'
        "</Connect>"
        "</Response>"
    )


def build_reject_twiml(message: str) -> str:
    """Build the TwiML used to reject the call."""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        f"<Say>{message}</Say>"
        "<Hangup/>"
        "</Response>"
    )


def build_info_twiml(message: str) -> str:
    """Build a simple TwiML response for manual GET checks."""
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        f"<Say>{message}</Say>"
        "</Response>"
    )


def parse_twilio_start_message(message: dict[str, Any]) -> tuple[str, str]:
    """Extract stream metadata from the Twilio start message."""
    start = message.get("start", {})
    call_sid = str(start.get("callSid", ""))
    stream_sid = str(start.get("streamSid", ""))

    if not call_sid or not stream_sid:
        raise ValueError("Twilio start message is missing callSid or streamSid")

    return call_sid, stream_sid


async def parse_form_body(request: Request) -> dict[str, str]:
    """Parse an x-www-form-urlencoded request body without python-multipart."""
    raw_body = await request.body()
    decoded_body = raw_body.decode("utf-8")
    parsed_body = parse_qs(decoded_body, keep_blank_values=True)

    return {
        key: values[0] if values else ""
        for key, values in parsed_body.items()
    }


# ============================================================================
# APP SETUP
# ============================================================================

settings = load_settings()
bridge_service = BridgeService(settings)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("twilio_browser_bridge")

app = FastAPI(title="Twilio Browser Bridge")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ============================================================================
# MAIN HANDLERS
# ============================================================================

@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    """Serve the browser control page."""
    html_path = STATIC_DIR / "index.html"
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


@app.get("/health")
async def health() -> JSONResponse:
    """Return a basic health response."""
    state = await bridge_service.build_bridge_state()
    return JSONResponse({"status": "ok", "bridge": state["call"]})


@app.api_route("/twilio/voice", methods=["GET", "POST"])
async def twilio_voice(request: Request) -> Response:
    """Handle incoming Twilio calls and connect them to the bridge."""
    if request.method == "GET":
        return Response(
            content=build_info_twiml("Twilio browser bridge webhook is online."),
            media_type="text/xml",
        )

    if not settings.public_url:
        raise RuntimeError("PUBLIC_URL is required for incoming Twilio calls")

    form = await parse_form_body(request)
    call_sid = form.get("CallSid", "")
    from_number = form.get("From", "unknown")

    if not call_sid:
        raise RuntimeError("Twilio voice webhook did not include CallSid")

    call_reserved = await bridge_service.reserve_incoming_call(call_sid, from_number)
    if not call_reserved:
        logger.info("Rejecting incoming call %s because the bridge is busy", call_sid)
        return Response(
            content=build_reject_twiml(TWILIO_BUSY_MESSAGE),
            media_type="text/xml",
        )

    stream_url = settings.public_url.replace("https://", "wss://").replace("http://", "ws://")
    twiml = build_connect_twiml(f"{stream_url}/twilio-stream")
    logger.info("Accepted incoming call %s from %s", call_sid, from_number)
    return Response(content=twiml, media_type="text/xml")


@app.websocket("/twilio-stream")
async def twilio_stream(websocket: WebSocket) -> None:
    """Accept the Twilio media stream and relay audio to the browser."""
    await websocket.accept()
    call_sid = ""

    try:
        while True:
            raw_message = await websocket.receive_text()
            message = json.loads(raw_message)
            event_type = str(message.get("event", ""))

            if event_type == "connected":
                logger.info("Twilio stream connected")
                continue

            if event_type == "start":
                call_sid, stream_sid = parse_twilio_start_message(message)
                await bridge_service.attach_twilio_stream(websocket, call_sid, stream_sid)
                logger.info("Twilio stream started for call %s", call_sid)
                continue

            if event_type == "media":
                payload = str(message.get("media", {}).get("payload", ""))
                if not payload:
                    raise RuntimeError("Twilio media event is missing payload")

                await bridge_service.forward_twilio_audio_to_browser(payload)
                continue

            if event_type == "stop":
                stop_call_sid = str(message.get("stop", {}).get("callSid", call_sid))
                logger.info("Twilio stream stopped for call %s", stop_call_sid)
                await bridge_service.clear_call_if_match(stop_call_sid)
                return

            logger.info("Ignoring Twilio event type %s", event_type)

    except WebSocketDisconnect:
        logger.info("Twilio WebSocket disconnected for call %s", call_sid or "unknown")
        if call_sid:
            await bridge_service.clear_call_if_match(call_sid)
    except Exception:
        logger.exception("Twilio stream failed for call %s", call_sid or "unknown")
        if call_sid:
            await bridge_service.clear_call_if_match(call_sid)
        try:
            await websocket.close(code=1011, reason="bridge_error")
        except Exception:
            logger.exception("Failed to close broken Twilio WebSocket")


@app.websocket("/browser-ws")
async def browser_ws(websocket: WebSocket) -> None:
    """Handle browser control messages and browser audio upload."""
    await websocket.accept()

    try:
        try:
            await bridge_service.register_browser(websocket)
        except Exception:
            await websocket.send_text(
                json.dumps(
                    {
                        "type": "error",
                        "code": "BROWSER_ALREADY_CONNECTED",
                        "message": "Another browser is already connected to this bridge.",
                    }
                )
            )
            await websocket.close(code=1008, reason="browser_already_connected")
            return

        while True:
            message = await websocket.receive()

            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect()

            if "bytes" in message and message["bytes"] is not None:
                await bridge_service.forward_browser_audio_to_twilio(message["bytes"])
                continue

            text_data = message.get("text")
            if text_data is None:
                continue

            payload = json.loads(text_data)
            message_type = str(payload.get("type", ""))

            if message_type == "pickup":
                await bridge_service.pickup_call()
                continue

            if message_type == "hangup":
                await bridge_service.end_active_call("browser_requested_hangup")
                continue

            if message_type == "ping":
                await bridge_service.send_browser_message({"type": "pong"})
                continue

            raise RuntimeError(f"Unsupported browser message type: {message_type}")

    except WebSocketDisconnect:
        logger.info("Browser WebSocket disconnected")
    except Exception:
        logger.exception("Browser WebSocket failed")
        try:
            await bridge_service.send_browser_message(
                {
                    "type": "error",
                    "code": "BRIDGE_ERROR",
                    "message": SAFE_BROWSER_ERROR_MESSAGE,
                }
            )
        except Exception:
            logger.exception("Failed to send browser error message")
    finally:
        await bridge_service.unregister_browser(websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "bridge_server:app",
        host="0.0.0.0",
        port=settings.port,
        reload=False,
    )
