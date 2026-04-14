"""
Tests for call progress beep helpers.

Verifies that:
- the Twilio progress beep sends direct media messages
- the Twilio handoff path sends a single clear event
- the first-assistant-audio notifier fires once on real outbound audio
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock

import pytest
from pipecat.frames.frames import Frame, TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection

from src.audio.startup_tone import (
    FirstAssistantAudioNotifierProcessor,
    TwilioProgressBeepPlayer,
)


class FakeWebSocket:
    """Collect websocket messages sent by the Twilio beep player."""

    def __init__(self) -> None:
        self.messages: list[str] = []

    async def send_text(self, text: str) -> None:
        self.messages.append(text)


@pytest.mark.asyncio
async def test_twilio_progress_beep_sends_media_messages() -> None:
    """Starting the Twilio beep should send buffered media events."""
    websocket = FakeWebSocket()
    player = TwilioProgressBeepPlayer(websocket=websocket, stream_sid="MZ123")

    await player.start()
    await asyncio.sleep(0.05)
    await player.stop("test_done")

    decoded = [json.loads(message) for message in websocket.messages]
    assert decoded
    assert all(message["streamSid"] == "MZ123" for message in decoded)
    assert decoded[0]["event"] == "media"


@pytest.mark.asyncio
async def test_twilio_progress_beep_clear_sent_once_on_handoff() -> None:
    """Stopping for assistant audio should flush Twilio's buffered beep audio once."""
    websocket = FakeWebSocket()
    player = TwilioProgressBeepPlayer(websocket=websocket, stream_sid="MZ456")

    await player.start()
    await asyncio.sleep(0.03)
    await player.stop("assistant_audio", clear_twilio_buffer=True)
    await player.stop("session_end", clear_twilio_buffer=True)

    decoded = [json.loads(message) for message in websocket.messages]
    clear_events = [message for message in decoded if message["event"] == "clear"]
    assert len(clear_events) == 1
    assert clear_events[0]["streamSid"] == "MZ456"


@pytest.mark.asyncio
async def test_first_assistant_audio_notifier_fires_once() -> None:
    """Only the first outbound TTSAudioRawFrame should trigger the callback."""
    on_first_audio = AsyncMock()
    processor = FirstAssistantAudioNotifierProcessor(on_first_audio=on_first_audio)
    captured_frames: list[Frame] = []

    async def mock_push_frame(
        frame: Frame,
        direction: FrameDirection = FrameDirection.DOWNSTREAM,
    ) -> None:
        captured_frames.append(frame)

    processor.push_frame = AsyncMock(side_effect=mock_push_frame)

    first_frame = TTSAudioRawFrame(audio=b"\x00\x01", sample_rate=8000, num_channels=1)
    second_frame = TTSAudioRawFrame(audio=b"\x02\x03", sample_rate=8000, num_channels=1)

    await processor.process_frame(first_frame, FrameDirection.DOWNSTREAM)
    await processor.process_frame(second_frame, FrameDirection.DOWNSTREAM)

    on_first_audio.assert_awaited_once()
    assert captured_frames == [first_frame, second_frame]
