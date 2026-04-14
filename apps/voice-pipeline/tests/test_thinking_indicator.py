"""
Tests for the transport-level thinking indicator.

Verifies that:
- The synthesized loop is valid PCM16 audio
- The mixer can produce continuous waiting audio without upstream frames
- The cue processor toggles the mixer on delayed responses
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import numpy as np
import pytest  # type: ignore[import-untyped]

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    LLMFullResponseStartFrame,
    MixerEnableFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from src.audio.thinking_indicator import (
    ThinkingCueProcessor,
    ThinkingIndicatorMixer,
    synthesize_thinking_loop,
)


SAMPLE_RATE = 16000


def test_synthesize_thinking_loop_returns_pcm16_audio() -> None:
    """The loop has the expected size and contains non-zero samples."""
    loop = synthesize_thinking_loop(sample_rate=SAMPLE_RATE)

    assert loop.dtype == np.int16
    assert len(loop) == int(SAMPLE_RATE * 2.4)
    assert np.max(np.abs(loop)) > 0


@pytest.mark.asyncio
async def test_mixer_generates_audio_when_enabled() -> None:
    """The mixer produces audible output even when upstream audio is silence."""
    mixer = ThinkingIndicatorMixer(volume=0.12, fade_secs=0.01)
    silence = b"\x00\x00" * 320

    await mixer.start(SAMPLE_RATE)
    await mixer.process_frame(MixerEnableFrame(enable=True))

    mixed = await mixer.mix(silence)
    samples = np.frombuffer(mixed, dtype=np.int16)

    assert np.max(np.abs(samples)) > 0

    await mixer.process_frame(MixerEnableFrame(enable=False))
    for _ in range(4):
        mixed = await mixer.mix(silence)
    assert mixed == silence


@pytest.mark.asyncio
async def test_processor_enables_indicator_after_delay() -> None:
    """A delayed response toggles the transport mixer on."""
    processor = ThinkingCueProcessor(delay_secs=0.01)
    pushed_frames: list[object] = []

    async def mock_push_frame(frame: object, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        pushed_frames.append(frame)

    processor.push_frame = AsyncMock(side_effect=mock_push_frame)

    await processor.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0.03)

    control_frames = [frame for frame in pushed_frames if isinstance(frame, MixerEnableFrame)]
    assert control_frames == [MixerEnableFrame(enable=True)]

    await processor.cleanup()


@pytest.mark.asyncio
async def test_processor_cancels_indicator_when_bot_starts_quickly() -> None:
    """If the bot responds before the delay, the mixer is never enabled."""
    processor = ThinkingCueProcessor(delay_secs=0.03)
    pushed_frames: list[object] = []

    async def mock_push_frame(frame: object, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        pushed_frames.append(frame)

    processor.push_frame = AsyncMock(side_effect=mock_push_frame)

    await processor.process_frame(LLMFullResponseStartFrame(), FrameDirection.DOWNSTREAM)
    await processor.process_frame(BotStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0.05)

    control_frames = [frame for frame in pushed_frames if isinstance(frame, MixerEnableFrame)]
    assert control_frames == []

    await processor.cleanup()
