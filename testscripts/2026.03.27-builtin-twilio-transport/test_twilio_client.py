"""
Simulated Twilio WebSocket client for local testing.

Connects to the test server's /twilio-stream endpoint and sends the same
message sequence that Twilio's media stream would send: "connected" event,
"start" event (with streamSid and customParameters), then optionally
"media" events with silence. Logs any messages received from the server.

Usage:
    python test_twilio_client.py [--url ws://localhost:8765/twilio-stream] [--user-id test-user]
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import signal
import uuid

import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("test_twilio_client")


# ============================================================================
# CONSTANTS
# ============================================================================

DEFAULT_URL = "ws://localhost:8765/twilio-stream"
DEFAULT_USER_ID = "test-user-123"

# 20ms of silence at 8kHz mulaw = 160 bytes of 0xFF (mulaw silence value)
SILENCE_MULAW_20MS = b"\xff" * 160

# How often to send media packets (simulating Twilio's 20ms cadence)
MEDIA_INTERVAL_SEC = 0.02

# Sequence number tracker for media events
_media_sequence = 0


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def make_connected_message() -> str:
    """Create a Twilio "connected" event message.

    Returns:
        JSON string of the connected event.
    """
    return json.dumps({
        "event": "connected",
        "protocol": "Call",
        "version": "1.0.0",
    })


def make_start_message(stream_sid: str, call_sid: str, user_id: str) -> str:
    """Create a Twilio "start" event message with stream metadata.

    Args:
        stream_sid: The unique stream identifier.
        call_sid: The unique call identifier.
        user_id: The userId to pass in customParameters.

    Returns:
        JSON string of the start event.
    """
    return json.dumps({
        "event": "start",
        "sequenceNumber": "1",
        "start": {
            "accountSid": "ACtest000000000000000000000000000",
            "streamSid": stream_sid,
            "callSid": call_sid,
            "tracks": ["inbound"],
            "mediaFormat": {
                "encoding": "audio/x-mulaw",
                "sampleRate": 8000,
                "channels": 1,
            },
            "customParameters": {
                "userId": user_id,
            },
        },
        "streamSid": stream_sid,
    })


def make_media_message(stream_sid: str, payload: bytes) -> str:
    """Create a Twilio "media" event with base64-encoded audio.

    Args:
        stream_sid: The stream identifier.
        payload: Raw mulaw audio bytes.

    Returns:
        JSON string of the media event.
    """
    global _media_sequence
    _media_sequence += 1

    return json.dumps({
        "event": "media",
        "sequenceNumber": str(_media_sequence + 1),
        "media": {
            "track": "inbound",
            "chunk": str(_media_sequence),
            "timestamp": str(_media_sequence * 20),
            "payload": base64.b64encode(payload).decode("ascii"),
        },
        "streamSid": stream_sid,
    })


def make_stop_message(stream_sid: str) -> str:
    """Create a Twilio "stop" event message.

    Args:
        stream_sid: The stream identifier.

    Returns:
        JSON string of the stop event.
    """
    return json.dumps({
        "event": "stop",
        "sequenceNumber": str(_media_sequence + 2),
        "streamSid": stream_sid,
        "stop": {
            "accountSid": "ACtest000000000000000000000000000",
            "callSid": "CAtest000000000000000000000000000",
        },
    })


# ============================================================================
# MAIN LOGIC
# ============================================================================

async def receive_loop(ws) -> None:
    """Listen for messages from the server and log them.

    Args:
        ws: The WebSocket connection.
    """
    try:
        async for raw in ws:
            message = json.loads(raw)
            event = message.get("event", "unknown")

            if event == "media":
                payload = message.get("media", {}).get("payload", "")
                audio_bytes = base64.b64decode(payload) if payload else b""
                logger.info("[recv] media: %d bytes of audio", len(audio_bytes))
            elif event == "clear":
                logger.info("[recv] clear event (interruption)")
            else:
                logger.info("[recv] %s: %s", event, json.dumps(message)[:200])
    except websockets.exceptions.ConnectionClosed:
        logger.info("[recv] Connection closed by server")
    except Exception as exc:
        logger.error("[recv] Error: %s", exc)


async def send_media_loop(ws, stream_sid: str, stop_event: asyncio.Event) -> None:
    """Send silence media packets at Twilio's 20ms cadence.

    Args:
        ws: The WebSocket connection.
        stream_sid: The stream identifier.
        stop_event: Event to signal when to stop sending.
    """
    logger.info("[send] Starting media stream (silence)")
    try:
        while not stop_event.is_set():
            msg = make_media_message(stream_sid, SILENCE_MULAW_20MS)
            await ws.send(msg)
            await asyncio.sleep(MEDIA_INTERVAL_SEC)
    except websockets.exceptions.ConnectionClosed:
        logger.info("[send] Connection closed")
    except Exception as exc:
        logger.error("[send] Error: %s", exc)


async def run_client(url: str, user_id: str) -> None:
    """Run the simulated Twilio client.

    Connects to the server, sends the Twilio handshake (connected + start),
    then streams silence media packets while listening for server responses.
    Sends a "stop" event on ctrl+c.

    Args:
        url: WebSocket URL of the server endpoint.
        user_id: The userId to include in customParameters.
    """
    stream_sid = f"MZ{uuid.uuid4().hex[:30]}"
    call_sid = f"CA{uuid.uuid4().hex[:30]}"

    logger.info("Connecting to %s", url)
    logger.info("stream_sid=%s, call_sid=%s, user_id=%s", stream_sid, call_sid, user_id)

    async with websockets.connect(url) as ws:
        # Send the Twilio handshake sequence
        logger.info("[send] connected event")
        await ws.send(make_connected_message())

        logger.info("[send] start event")
        await ws.send(make_start_message(stream_sid, call_sid, user_id))

        # Start receive and send loops
        stop_event = asyncio.Event()
        recv_task = asyncio.create_task(receive_loop(ws))
        send_task = asyncio.create_task(send_media_loop(ws, stream_sid, stop_event))

        # Wait for ctrl+c
        loop = asyncio.get_event_loop()
        shutdown = asyncio.Event()
        loop.add_signal_handler(signal.SIGINT, shutdown.set)

        logger.info("Running. Press ctrl+c to stop.")
        await shutdown.wait()

        # Send stop event before closing
        logger.info("[send] stop event")
        stop_event.set()
        try:
            await ws.send(make_stop_message(stream_sid))
        except Exception:
            pass

        send_task.cancel()
        recv_task.cancel()

        try:
            await send_task
        except asyncio.CancelledError:
            pass
        try:
            await recv_task
        except asyncio.CancelledError:
            pass

    logger.info("Client disconnected")


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Simulated Twilio WebSocket client")
    parser.add_argument("--url", default=DEFAULT_URL, help="Server WebSocket URL")
    parser.add_argument("--user-id", default=DEFAULT_USER_ID, help="userId for customParameters")
    args = parser.parse_args()

    asyncio.run(run_client(args.url, args.user_id))
