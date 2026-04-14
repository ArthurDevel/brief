"""
Startup tone processors for filling the gap before the assistant speaks.

- StartupToneProcessor: injects a repeating phone-style tone on the output path
- StartupToneInputMonitorProcessor: stops the tone when caller audio arrives
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

import numpy as np
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    CancelFrame,
    Frame,
    StartFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    UserSpeakingFrame,
    UserStartedSpeakingFrame,
    VADUserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


logger = logging.getLogger(__name__)

INT16_MAX = 32767
FRAME_DURATION_MS = 20
TONE_AMPLITUDE = 0.12
TONE_FADE_MS = 8


@dataclass(frozen=True)
class ToneSegment:
    """One segment in the repeating startup tone pattern."""

    audio: bytes | None
    duration_secs: float


def _generate_dual_tone(
    sample_rate: int,
    duration_secs: float,
    frequencies_hz: tuple[float, float],
    amplitude: float = TONE_AMPLITUDE,
    num_channels: int = 1,
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
    if num_channels > 1:
        pcm = np.repeat(pcm[:, None], num_channels, axis=1).reshape(-1)
    return pcm.tobytes()


class StartupToneProcessor(FrameProcessor):
    """Injects a repeating phone-style tone until speech begins."""

    def __init__(
        self,
        *,
        enabled: bool,
        sample_rate: int,
        num_channels: int = 1,
    ) -> None:
        super().__init__()
        self._enabled = enabled
        self._sample_rate = sample_rate
        self._num_channels = num_channels
        self._frame_bytes = sample_rate * num_channels * 2 * FRAME_DURATION_MS // 1000
        self._tone_task: asyncio.Task | None = None
        self._stopped = asyncio.Event()
        self._pending_start = False
        self._start_frame_seen = False
        self._segments = (
            ToneSegment(
                audio=_generate_dual_tone(
                    sample_rate,
                    duration_secs=0.12,
                    frequencies_hz=(480.0, 620.0),
                    num_channels=num_channels,
                ),
                duration_secs=0.12,
            ),
            ToneSegment(audio=None, duration_secs=0.10),
            ToneSegment(
                audio=_generate_dual_tone(
                    sample_rate,
                    duration_secs=0.12,
                    frequencies_hz=(480.0, 620.0),
                    num_channels=num_channels,
                ),
                duration_secs=0.12,
            ),
            ToneSegment(audio=None, duration_secs=1.10),
        )

    async def start(self) -> None:
        """Start the startup tone loop if enabled, or defer until StartFrame arrives."""
        if not self._enabled:
            return

        self._pending_start = True
        if not self._start_frame_seen:
            logger.info("[startup_tone] Startup tone queued; waiting for StartFrame")
            return

        if self._tone_task is not None:
            return

        self._stopped.clear()
        self._pending_start = False
        self._tone_task = asyncio.create_task(self._run_tone_loop())
        logger.info("[startup_tone] Started startup tone")

    async def stop(self, reason: str) -> None:
        """Stop the startup tone loop."""
        task = self._tone_task
        self._pending_start = False
        if task is None:
            return

        self._tone_task = None
        self._stopped.set()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        logger.info("[startup_tone] Stopped startup tone: reason=%s", reason)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Stop the tone when assistant speech begins, then forward the frame."""
        await super().process_frame(frame, direction)

        if isinstance(frame, StartFrame):
            self._start_frame_seen = True
            await self.push_frame(frame, direction)
            if self._pending_start:
                await self.start()
            return
        if isinstance(frame, (TTSAudioRawFrame, TTSStartedFrame, BotStartedSpeakingFrame)):
            await self.stop("assistant_speaking")
        elif isinstance(frame, CancelFrame):
            await self.stop("cancelled")

        await self.push_frame(frame, direction)

    async def _run_tone_loop(self) -> None:
        """Push tone frames on the output path until stopped."""
        try:
            while not self._stopped.is_set():
                for segment in self._segments:
                    if self._stopped.is_set():
                        return

                    if segment.audio is None:
                        await asyncio.sleep(segment.duration_secs)
                        continue

                    for offset in range(0, len(segment.audio), self._frame_bytes):
                        if self._stopped.is_set():
                            return
                        chunk = segment.audio[offset : offset + self._frame_bytes]
                        if not chunk:
                            continue
                        await self.push_frame(
                            TTSAudioRawFrame(
                                audio=chunk,
                                sample_rate=self._sample_rate,
                                num_channels=self._num_channels,
                            ),
                            FrameDirection.DOWNSTREAM,
                        )
                        await asyncio.sleep(FRAME_DURATION_MS / 1000)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[startup_tone] Tone loop failed")


class StartupToneInputMonitorProcessor(FrameProcessor):
    """Stops the startup tone when caller audio arrives."""

    def __init__(self, startup_tone: StartupToneProcessor) -> None:
        super().__init__()
        self._startup_tone = startup_tone

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Watch for caller audio/speaking frames, then forward the frame."""
        await super().process_frame(frame, direction)

        if isinstance(frame, (UserSpeakingFrame, UserStartedSpeakingFrame, VADUserStartedSpeakingFrame)):
            await self._startup_tone.stop("user_speaking")
        elif isinstance(frame, CancelFrame):
            await self._startup_tone.stop("cancelled")

        await self.push_frame(frame, direction)
