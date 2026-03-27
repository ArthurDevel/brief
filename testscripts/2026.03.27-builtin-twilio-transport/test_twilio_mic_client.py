"""
Live microphone client that talks to the test pipecat server via Twilio WebSocket protocol.

Captures mic audio, encodes it as mulaw 8kHz (matching Twilio's format), sends it as
Twilio media events, and plays back received mulaw audio through speakers. This lets
you have a real voice conversation with the pipeline.

Usage:
    python test_twilio_mic_client.py [--url ws://localhost:8765/twilio-stream] [--user-id test-user]

Requirements:
    pip install sounddevice websockets
"""

from __future__ import annotations

import argparse
import asyncio
import audioop
import base64
import json
import logging
import signal
import uuid
from collections import deque

import numpy as np
import sounddevice as sd  # type: ignore[import-untyped]
import websockets

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("twilio_mic_client")


# ============================================================================
# CONSTANTS
# ============================================================================

DEFAULT_URL = "ws://localhost:8765/twilio-stream"
DEFAULT_USER_ID = "test-user-123"

# Twilio sends/receives mulaw at 8kHz mono
MULAW_SAMPLE_RATE = 8000
CHANNELS = 1

# 20ms chunks at 8kHz = 160 samples
CHUNK_SAMPLES = 160
CHUNK_DURATION_SEC = CHUNK_SAMPLES / MULAW_SAMPLE_RATE  # 0.02s

# Sounddevice captures 16-bit PCM (int16)
PCM_DTYPE = "int16"


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def pcm16_to_mulaw(pcm_bytes: bytes) -> bytes:
    """Convert 16-bit PCM audio to mulaw.

    Args:
        pcm_bytes: Raw 16-bit signed PCM audio bytes.

    Returns:
        Mulaw-encoded audio bytes.
    """
    return audioop.lin2ulaw(pcm_bytes, 2)


def mulaw_to_pcm16(mulaw_bytes: bytes) -> bytes:
    """Convert mulaw audio to 16-bit PCM.

    Args:
        mulaw_bytes: Mulaw-encoded audio bytes.

    Returns:
        Raw 16-bit signed PCM audio bytes.
    """
    return audioop.ulaw2lin(mulaw_bytes, 2)


def make_connected_message() -> str:
    """Create Twilio 'connected' event."""
    return json.dumps({"event": "connected", "protocol": "Call", "version": "1.0.0"})


def make_start_message(stream_sid: str, call_sid: str, user_id: str) -> str:
    """Create Twilio 'start' event with stream metadata."""
    return json.dumps({
        "event": "start",
        "sequenceNumber": "1",
        "start": {
            "accountSid": "ACtest000000000000000000000000000",
            "streamSid": stream_sid,
            "callSid": call_sid,
            "tracks": ["inbound"],
            "mediaFormat": {"encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1},
            "customParameters": {"userId": user_id},
        },
        "streamSid": stream_sid,
    })


def make_stop_message(stream_sid: str, seq: int) -> str:
    """Create Twilio 'stop' event."""
    return json.dumps({
        "event": "stop",
        "sequenceNumber": str(seq),
        "streamSid": stream_sid,
        "stop": {
            "accountSid": "ACtest000000000000000000000000000",
            "callSid": "CAtest000000000000000000000000000",
        },
    })


# ============================================================================
# MAIN LOGIC
# ============================================================================

async def run_client(url: str, user_id: str) -> None:
    """Run the live mic client.

    Connects to the server, sends the Twilio handshake, then streams mic audio
    as mulaw media events while playing back received audio through speakers.

    Args:
        url: WebSocket URL of the server endpoint.
        user_id: The userId to include in customParameters.
    """
    stream_sid = f"MZ{uuid.uuid4().hex[:30]}"
    call_sid = f"CA{uuid.uuid4().hex[:30]}"
    seq = 0

    # Shared buffer for audio playback (thread-safe via deque)
    playback_buffer: deque[bytes] = deque()

    # Shared buffer for mic capture
    capture_buffer: deque[bytes] = deque()

    logger.info("Connecting to %s", url)

    async with websockets.connect(url) as ws:
        # -- Step 1: Send Twilio handshake
        await ws.send(make_connected_message())
        await ws.send(make_start_message(stream_sid, call_sid, user_id))
        logger.info("Handshake sent (stream_sid=%s)", stream_sid)

        # -- Step 2: Set up sounddevice streams
        # The mic callback runs in a separate thread, so we use deque (thread-safe
        # for append/popleft) to pass audio between the callback and the async loop.

        def mic_callback(indata, frames, time_info, status):
            """Called by sounddevice when mic audio is available."""
            if status:
                logger.warning("Mic status: %s", status)
            # indata is a numpy array of int16 samples
            capture_buffer.append(indata.tobytes())

        def speaker_callback(outdata, frames, time_info, status):
            """Called by sounddevice when the speaker needs audio."""
            if status:
                logger.warning("Speaker status: %s", status)

            bytes_needed = frames * 2  # 2 bytes per int16 sample
            collected = b""

            # Drain playback buffer until we have enough
            while len(collected) < bytes_needed and playback_buffer:
                chunk = playback_buffer.popleft()
                collected += chunk

            if len(collected) >= bytes_needed:
                # Use what we need, put the rest back
                if len(collected) > bytes_needed:
                    playback_buffer.appendleft(collected[bytes_needed:])
                samples = np.frombuffer(collected[:bytes_needed], dtype=np.int16)
            else:
                # Not enough audio -- pad with silence
                padded = collected + b"\x00" * (bytes_needed - len(collected))
                samples = np.frombuffer(padded, dtype=np.int16)

            outdata[:, 0] = samples

        mic_stream = sd.InputStream(
            samplerate=MULAW_SAMPLE_RATE,
            channels=CHANNELS,
            dtype=PCM_DTYPE,
            blocksize=CHUNK_SAMPLES,
            callback=mic_callback,
        )
        speaker_stream = sd.OutputStream(
            samplerate=MULAW_SAMPLE_RATE,
            channels=CHANNELS,
            dtype=PCM_DTYPE,
            blocksize=CHUNK_SAMPLES,
            callback=speaker_callback,
        )

        mic_stream.start()
        speaker_stream.start()
        logger.info("Mic and speaker started. Speak now! Press ctrl+c to stop.")

        # -- Step 3: Set up shutdown signal
        shutdown = asyncio.Event()
        loop = asyncio.get_event_loop()
        loop.add_signal_handler(signal.SIGINT, shutdown.set)

        # -- Step 4: Run send and receive concurrently
        async def send_loop():
            """Read mic audio from capture_buffer, encode as mulaw, send as Twilio media."""
            nonlocal seq
            while not shutdown.is_set():
                if capture_buffer:
                    pcm_bytes = capture_buffer.popleft()
                    mulaw_bytes = pcm16_to_mulaw(pcm_bytes)

                    seq += 1
                    msg = json.dumps({
                        "event": "media",
                        "sequenceNumber": str(seq),
                        "media": {
                            "track": "inbound",
                            "chunk": str(seq),
                            "timestamp": str(seq * 20),
                            "payload": base64.b64encode(mulaw_bytes).decode("ascii"),
                        },
                        "streamSid": stream_sid,
                    })
                    await ws.send(msg)
                else:
                    await asyncio.sleep(0.005)

        async def receive_loop():
            """Receive Twilio media from server, decode mulaw, queue for playback."""
            try:
                async for raw in ws:
                    msg = json.loads(raw)
                    event = msg.get("event", "unknown")

                    if event == "media":
                        payload = msg.get("media", {}).get("payload", "")
                        if payload:
                            mulaw_bytes = base64.b64decode(payload)
                            pcm_bytes = mulaw_to_pcm16(mulaw_bytes)
                            playback_buffer.append(pcm_bytes)
                    elif event == "clear":
                        # Interruption -- clear the playback buffer so old audio stops
                        playback_buffer.clear()
                        logger.info("[recv] clear (interruption)")
                    elif event == "mark":
                        pass  # ignore mark events
                    else:
                        logger.info("[recv] %s", event)
            except websockets.exceptions.ConnectionClosed:
                logger.info("Server closed connection")
                shutdown.set()

        send_task = asyncio.create_task(send_loop())
        recv_task = asyncio.create_task(receive_loop())

        await shutdown.wait()

        # -- Step 5: Cleanup
        logger.info("Shutting down...")
        send_task.cancel()
        recv_task.cancel()

        try:
            await ws.send(make_stop_message(stream_sid, seq + 1))
        except Exception:
            pass

        mic_stream.stop()
        speaker_stream.stop()
        mic_stream.close()
        speaker_stream.close()

        for t in [send_task, recv_task]:
            try:
                await t
            except asyncio.CancelledError:
                pass

    logger.info("Disconnected")


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Live mic client for Twilio WebSocket test server")
    parser.add_argument("--url", default=DEFAULT_URL, help="Server WebSocket URL")
    parser.add_argument("--user-id", default=DEFAULT_USER_ID, help="userId for customParameters")
    args = parser.parse_args()

    asyncio.run(run_client(args.url, args.user_id))
