"""
Helpers for call progress beeps and the handoff to real assistant audio.

- TwilioProgressBeepPlayer sends direct Twilio media events as soon as the
  stream SID is known, before the Pipecat pipeline is ready.
- FirstAssistantAudioNotifierProcessor fires exactly once on the first actual
  outbound assistant audio frame, which covers both normal TTS and tool
  narration audio.
"""

from __future__ import annotations

import asyncio
import audioop
import base64
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import numpy as np
from pipecat.frames.frames import Frame, TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


logger = logging.getLogger(__name__)

INT16_MAX = 32767
FRAME_DURATION_MS = 20
TWILIO_SAMPLE_RATE = 8000
TWILIO_FRAME_BYTES = TWILIO_SAMPLE_RATE * FRAME_DURATION_MS // 1000
TONE_AMPLITUDE = 0.12
TONE_FADE_MS = 8
RINGBACK_ON_SECS = 2.0
RINGBACK_OFF_SECS = 4.0
RINGBACK_FREQUENCIES = (440.0, 480.0)


@dataclass(frozen=True)
class ToneSegment:
    """One segment in the repeating progress beep pattern."""

    audio: bytes | None
    duration_secs: float


def _generate_dual_tone(
    sample_rate: int,
    duration_secs: float,
    frequencies_hz: tuple[float, float],
    amplitude: float = TONE_AMPLITUDE,
) -> bytes:
    """Generate a short dual-tone PCM buffer with a fade to avoid clicks."""
    num_samples = max(1, int(sample_rate * duration_secs))
    t = np.arange(num_samples, dtype=np.float32) / sample_rate

    tone = np.zeros(num_samples, dtype=np.float32)
    for freq in frequencies_hz:
        tone += np.sin(2 * np.pi * freq * t)
    tone = (tone / len(frequencies_hz)) * amplitude

    fade_samples = min(int(sample_rate * TONE_FADE_MS / 1000), num_samples // 2)
    if fade_samples > 0:
        fade = np.linspace(0.0, 1.0, fade_samples, dtype=np.float32)
        tone[:fade_samples] *= fade
        tone[-fade_samples:] *= fade[::-1]

    pcm = np.clip(tone * INT16_MAX, -INT16_MAX, INT16_MAX).astype(np.int16)
    return pcm.tobytes()


def _encode_pcm_to_mulaw(pcm_bytes: bytes) -> bytes:
    """Encode mono 16-bit PCM to Twilio's 8 kHz mu-law wire format."""
    return audioop.lin2ulaw(pcm_bytes, 2)


def _iter_mulaw_frames(audio_bytes: bytes) -> tuple[bytes, ...]:
    """Split mu-law audio into 20 ms Twilio media chunks."""
    return tuple(
        audio_bytes[offset : offset + TWILIO_FRAME_BYTES]
        for offset in range(0, len(audio_bytes), TWILIO_FRAME_BYTES)
        if audio_bytes[offset : offset + TWILIO_FRAME_BYTES]
    )


class TwilioProgressBeepPlayer:
    """Send a repeating progress beep directly over the Twilio websocket."""

    def __init__(self, websocket: Any, stream_sid: str) -> None:
        self._websocket = websocket
        self._stream_sid = stream_sid
        self._tone_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self._clear_sent = False
        self._segments = (
            ToneSegment(
                audio=_encode_pcm_to_mulaw(
                    _generate_dual_tone(
                        TWILIO_SAMPLE_RATE,
                        duration_secs=RINGBACK_ON_SECS,
                        frequencies_hz=RINGBACK_FREQUENCIES,
                    )
                ),
                duration_secs=RINGBACK_ON_SECS,
            ),
            ToneSegment(audio=None, duration_secs=RINGBACK_OFF_SECS),
        )

    async def start(self) -> None:
        """Start the repeating progress beep loop."""
        async with self._lock:
            if self._tone_task is not None:
                return
            self._tone_task = asyncio.create_task(self._run_loop())
            logger.info("[twilio_progress_beep] beep_started stream_sid=%s", self._stream_sid)

    async def stop(self, reason: str, *, clear_twilio_buffer: bool = False) -> None:
        """Stop the beep loop and optionally flush Twilio's buffered audio."""
        async with self._lock:
            task = self._tone_task
            self._tone_task = None
            should_clear = clear_twilio_buffer and not self._clear_sent
            if should_clear:
                self._clear_sent = True

        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            logger.info(
                "[twilio_progress_beep] beep_stopped stream_sid=%s reason=%s",
                self._stream_sid,
                reason,
            )

        if should_clear:
            try:
                await self._send_event({"event": "clear", "streamSid": self._stream_sid})
            except Exception as exc:
                logger.warning(
                    "[twilio_progress_beep] clear_failed stream_sid=%s reason=%s error=%s",
                    self._stream_sid,
                    reason,
                    exc,
                )

    async def _run_loop(self) -> None:
        """Continuously enqueue Twilio media events until cancelled."""
        try:
            while True:
                for segment in self._segments:
                    if segment.audio is None:
                        await asyncio.sleep(segment.duration_secs)
                        continue

                    for chunk in _iter_mulaw_frames(segment.audio):
                        await self._send_media(chunk)
                        await asyncio.sleep(FRAME_DURATION_MS / 1000)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning(
                "[twilio_progress_beep] beep_stopped stream_sid=%s reason=send_failed error=%s",
                self._stream_sid,
                exc,
            )
        finally:
            async with self._lock:
                current_task = asyncio.current_task()
                if current_task is self._tone_task:
                    self._tone_task = None

    async def _send_media(self, payload: bytes) -> None:
        """Send one Twilio media event with pre-encoded mu-law audio."""
        await self._send_event(
            {
                "event": "media",
                "streamSid": self._stream_sid,
                "media": {"payload": base64.b64encode(payload).decode("utf-8")},
            }
        )

    async def _send_event(self, event: dict[str, Any]) -> None:
        """Send a JSON Twilio media stream event to the websocket."""
        await self._websocket.send_text(json.dumps(event))


class FirstAssistantAudioNotifierProcessor(FrameProcessor):
    """Invoke a callback on the first real outbound assistant audio frame."""

    def __init__(
        self,
        on_first_audio: Callable[[], Awaitable[None]] | None = None,
    ) -> None:
        super().__init__()
        self._on_first_audio = on_first_audio
        self._notified = False

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Call the callback once, then forward the frame unchanged."""
        await super().process_frame(frame, direction)

        if (
            not self._notified
            and direction is FrameDirection.DOWNSTREAM
            and isinstance(frame, TTSAudioRawFrame)
            and frame.audio
        ):
            self._notified = True
            if self._on_first_audio is not None:
                await self._on_first_audio()

        await self.push_frame(frame, direction)
