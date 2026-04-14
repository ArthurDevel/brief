"""
Transport-level thinking indicator for the voice pipeline.

The cue scheduler lives in the pipeline and toggles a transport audio mixer.
That lets the waiting sound run on the transport's own output clock, which is
stable for both WebRTC and Twilio.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Mapping
from typing import Any

import numpy as np

from pipecat.audio.mixers.base_audio_mixer import BaseAudioMixer
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    EndFrame,
    Frame,
    FunctionCallsStartedFrame,
    LLMFullResponseStartFrame,
    MixerControlFrame,
    MixerEnableFrame,
    MixerUpdateSettingsFrame,
    TTSAudioRawFrame,
    UserStartedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


logger = logging.getLogger(__name__)


THINKING_CUE_DELAY_SECS = 0.18
THINKING_LOOP_DURATION_SECS = 2.4
THINKING_LOOP_VOLUME = 0.12
THINKING_FADE_SECS = 0.06
THINKING_BASE_FREQUENCY_HZ = 208.0
THINKING_SWEEP_DEPTH_HZ = 22.0
THINKING_HARMONIC_RATIO = 1.5
THINKING_AMPLITUDE = 0.18
INT16_MAX = 32767.0


def synthesize_thinking_loop(
    sample_rate: int,
    duration_secs: float = THINKING_LOOP_DURATION_SECS,
) -> np.ndarray:
    """Create one seamless mono PCM16 loop for the transport mixer."""
    if sample_rate <= 0:
        raise ValueError(f"sample_rate must be positive, got {sample_rate}")
    if duration_secs <= 0:
        raise ValueError(f"duration_secs must be positive, got {duration_secs}")

    num_samples = max(1, int(sample_rate * duration_secs))
    t = np.arange(num_samples, dtype=np.float32) / sample_rate
    loop_phase = (2.0 * np.pi * t) / duration_secs

    sweep_phase = THINKING_SWEEP_DEPTH_HZ * duration_secs * (1.0 - np.cos(loop_phase))
    fundamental = np.sin((2.0 * np.pi * THINKING_BASE_FREQUENCY_HZ * t) + sweep_phase)
    harmonic = np.sin(
        (2.0 * np.pi * THINKING_BASE_FREQUENCY_HZ * THINKING_HARMONIC_RATIO * t)
        + (0.55 * sweep_phase)
        + 0.3
    )

    breath = 0.58 + (0.28 * (1.0 - np.cos(loop_phase))) + (0.04 * np.sin(2.0 * loop_phase))
    tone = THINKING_AMPLITUDE * breath * ((0.84 * fundamental) + (0.16 * harmonic))
    tone = np.tanh(1.35 * tone) / 1.35

    return np.clip(tone * INT16_MAX, -INT16_MAX, INT16_MAX).astype(np.int16)


class ThinkingIndicatorMixer(BaseAudioMixer):
    """Mix a seamless waiting loop underneath transport output audio."""

    def __init__(
        self,
        *,
        volume: float = THINKING_LOOP_VOLUME,
        fade_secs: float = THINKING_FADE_SECS,
    ) -> None:
        self._sample_rate = 0
        self._volume = volume
        self._fade_secs = fade_secs
        self._current_gain = 0.0
        self._target_gain = 0.0
        self._active = False
        self._loop = np.zeros(1, dtype=np.int16)
        self._loop_pos = 0

    async def start(self, sample_rate: int) -> None:
        self._sample_rate = sample_rate
        self._loop = synthesize_thinking_loop(sample_rate=sample_rate)
        self._loop_pos = 0
        self._current_gain = 0.0
        self._target_gain = 0.0
        self._active = False

    async def stop(self) -> None:
        self._current_gain = 0.0
        self._target_gain = 0.0
        self._active = False
        self._loop_pos = 0

    async def process_frame(self, frame: MixerControlFrame) -> None:
        if isinstance(frame, MixerEnableFrame):
            if frame.enable:
                self._active = True
                self._target_gain = self._volume
            else:
                self._target_gain = 0.0
        elif isinstance(frame, MixerUpdateSettingsFrame):
            await self._update_settings(frame.settings)

    async def mix(self, audio: bytes) -> bytes:
        if not audio:
            return audio

        if not self._active and self._current_gain <= 1e-4:
            return audio

        audio_np = np.frombuffer(audio, dtype=np.int16).astype(np.float32)
        sound_np = self._take_loop_chunk(len(audio_np)).astype(np.float32)
        gain = self._gain_envelope(len(audio_np))
        mixed_audio = np.clip(audio_np + (sound_np * gain), -32768, 32767).astype(np.int16)

        if self._target_gain <= 1e-4 and self._current_gain <= 1e-4:
            self._active = False

        return mixed_audio.tobytes()

    async def _update_settings(self, settings: Mapping[str, Any]) -> None:
        volume = settings.get("volume")
        if isinstance(volume, (int, float)):
            self._volume = float(max(0.0, min(1.0, volume)))
            if self._target_gain > 0.0:
                self._target_gain = self._volume

    def _take_loop_chunk(self, num_samples: int) -> np.ndarray:
        if num_samples <= 0:
            return np.zeros(0, dtype=np.int16)

        loop_len = len(self._loop)
        if loop_len == 0:
            return np.zeros(num_samples, dtype=np.int16)

        end_pos = self._loop_pos + num_samples
        if end_pos <= loop_len:
            chunk = self._loop[self._loop_pos:end_pos]
            self._loop_pos = 0 if end_pos == loop_len else end_pos
            return chunk

        chunk = np.empty(num_samples, dtype=np.int16)
        written = 0
        while written < num_samples:
            available = loop_len - self._loop_pos
            take = min(available, num_samples - written)
            chunk[written:written + take] = self._loop[self._loop_pos:self._loop_pos + take]
            written += take
            self._loop_pos = (self._loop_pos + take) % loop_len
        return chunk

    def _gain_envelope(self, num_samples: int) -> np.ndarray:
        if num_samples <= 0:
            return np.zeros(0, dtype=np.float32)

        if self._sample_rate <= 0 or self._fade_secs <= 0:
            end_gain = self._target_gain
        else:
            proportion = min(1.0, (num_samples / self._sample_rate) / self._fade_secs)
            end_gain = self._current_gain + ((self._target_gain - self._current_gain) * proportion)

        gain = np.linspace(
            self._current_gain,
            end_gain,
            num_samples,
            endpoint=True,
            dtype=np.float32,
        )
        self._current_gain = float(end_gain)
        return gain


class ThinkingCueProcessor(FrameProcessor):
    """Enable a transport-level waiting loop if the bot takes a moment to answer."""

    def __init__(self, *, delay_secs: float = THINKING_CUE_DELAY_SECS) -> None:
        super().__init__()
        self._delay_secs = delay_secs
        self._cue_task: asyncio.Task[None] | None = None
        self._waiting_for_bot = False
        self._indicator_enabled = False

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, (LLMFullResponseStartFrame, FunctionCallsStartedFrame)):
            self._schedule_cue()
        elif isinstance(frame, (UserStartedSpeakingFrame, BotStartedSpeakingFrame, EndFrame)):
            await self._cancel_cue()
        elif isinstance(frame, TTSAudioRawFrame) and direction is FrameDirection.DOWNSTREAM:
            await self._cancel_cue()

        await self.push_frame(frame, direction)

    async def cleanup(self) -> None:
        await self._cancel_cue()
        await super().cleanup()

    def _schedule_cue(self) -> None:
        if self._indicator_enabled:
            return
        if self._cue_task is not None and not self._cue_task.done():
            return
        self._waiting_for_bot = True
        logger.info("[thinking-cue] Scheduled indicator in %.2fs", self._delay_secs)
        self._cue_task = asyncio.create_task(self._emit_cue_after_delay(), name="thinking_cue")

    async def _cancel_cue(self) -> None:
        self._waiting_for_bot = False
        if self._cue_task is not None:
            if not self._cue_task.done():
                self._cue_task.cancel()
                try:
                    await self._cue_task
                except asyncio.CancelledError:
                    pass
            self._cue_task = None

        if not self._indicator_enabled:
            return

        self._indicator_enabled = False
        logger.info("[thinking-cue] Disabled indicator")
        await self.push_frame(MixerEnableFrame(enable=False), FrameDirection.DOWNSTREAM)

    async def _emit_cue_after_delay(self) -> None:
        try:
            await asyncio.sleep(self._delay_secs)
            if not self._waiting_for_bot or self._indicator_enabled:
                return

            self._indicator_enabled = True
            logger.info("[thinking-cue] Enabled indicator")
            await self.push_frame(MixerEnableFrame(enable=True), FrameDirection.DOWNSTREAM)
        except asyncio.CancelledError:
            raise
        finally:
            self._cue_task = None
