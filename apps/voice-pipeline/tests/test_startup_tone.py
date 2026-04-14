"""
Tests for the shared startup tone processors.

Verifies that:
- the startup tone emits audio frames when started
- assistant audio stops the tone
- caller audio stops the tone through the input monitor
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from pipecat.frames.frames import Frame, TTSAudioRawFrame, UserStartedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection

from src.audio.startup_tone import StartupToneInputMonitorProcessor, StartupToneProcessor


@pytest.mark.asyncio
async def test_startup_tone_emits_audio_frames_after_start_frame() -> None:
    """Starting the tone should wait for StartFrame, then emit TTSAudioRawFrame chunks."""
    processor = StartupToneProcessor(enabled=True, sample_rate=8000, num_channels=1)
    captured_frames: list[Frame] = []

    async def mock_push_frame(
        frame: Frame,
        direction: FrameDirection = FrameDirection.DOWNSTREAM,
    ) -> None:
        captured_frames.append(frame)

    processor.push_frame = AsyncMock(side_effect=mock_push_frame)

    await processor.start()
    await asyncio.sleep(0.03)
    assert captured_frames == []
    assert processor._pending_start is True

    processor._start_frame_seen = True
    await processor.start()
    await asyncio.sleep(0.05)
    await processor.stop("test_done")

    assert any(isinstance(frame, TTSAudioRawFrame) for frame in captured_frames)


@pytest.mark.asyncio
async def test_assistant_audio_stops_startup_tone() -> None:
    """The first assistant audio frame should stop the tone and pass through."""
    processor = StartupToneProcessor(enabled=True, sample_rate=8000, num_channels=1)
    captured_frames: list[Frame] = []

    async def mock_push_frame(
        frame: Frame,
        direction: FrameDirection = FrameDirection.DOWNSTREAM,
    ) -> None:
        captured_frames.append(frame)

    processor.push_frame = AsyncMock(side_effect=mock_push_frame)

    await processor.start()
    processor._start_frame_seen = True
    await processor.start()
    await asyncio.sleep(0.03)

    assistant_frame = TTSAudioRawFrame(audio=b"\x00\x00", sample_rate=8000, num_channels=1)
    await processor.process_frame(assistant_frame, FrameDirection.DOWNSTREAM)
    frames_after_stop = len(captured_frames)
    await asyncio.sleep(0.05)

    assert captured_frames[-1] is assistant_frame
    assert len(captured_frames) == frames_after_stop
    assert processor._tone_task is None


@pytest.mark.asyncio
async def test_input_monitor_stops_tone_on_caller_audio() -> None:
    """Caller speech should stop the shared startup tone before forwarding the frame."""
    startup_tone = StartupToneProcessor(enabled=True, sample_rate=8000, num_channels=1)
    startup_tone.stop = AsyncMock()
    input_monitor = StartupToneInputMonitorProcessor(startup_tone)
    captured_frames: list[Frame] = []

    async def mock_push_frame(
        frame: Frame,
        direction: FrameDirection = FrameDirection.DOWNSTREAM,
    ) -> None:
        captured_frames.append(frame)

    input_monitor.push_frame = AsyncMock(side_effect=mock_push_frame)

    caller_frame = UserStartedSpeakingFrame()
    await input_monitor.process_frame(caller_frame, FrameDirection.DOWNSTREAM)

    startup_tone.stop.assert_awaited_once_with("user_speaking")
    assert captured_frames == [caller_frame]
