"""Tests for tracked service behavior."""

from __future__ import annotations

import pytest

from pipecat.frames.frames import ErrorFrame, TTSSpeakFrame
from pipecat.processors.frame_processor import FrameDirection

from src.tracked_services import TrackedOpenAILLMService, UsageTracker


@pytest.mark.asyncio
async def test_llm_error_pushes_audible_fallback_before_error_frame(monkeypatch) -> None:
    """LLM provider errors should produce speech before propagating upstream."""
    service = TrackedOpenAILLMService(
        usage_tracker=UsageTracker(),
        error_fallback_message="Service is unavailable.",
        api_key="test-key",
        model="test-model",
        base_url="https://example.invalid",
    )
    pushed_frames = []

    async def fake_push_frame(frame, direction=FrameDirection.DOWNSTREAM):
        pushed_frames.append((frame, direction))

    monkeypatch.setattr(service, "push_frame", fake_push_frame)

    await service.push_error_frame(
        ErrorFrame(error="provider rejected request", processor=service)
    )

    assert len(pushed_frames) == 2
    fallback_frame, fallback_direction = pushed_frames[0]
    error_frame, error_direction = pushed_frames[1]

    assert isinstance(fallback_frame, TTSSpeakFrame)
    assert fallback_frame.text == "Service is unavailable."
    assert fallback_frame.append_to_context is False
    assert fallback_direction == FrameDirection.DOWNSTREAM

    assert isinstance(error_frame, ErrorFrame)
    assert error_frame.error == "provider rejected request"
    assert error_direction == FrameDirection.UPSTREAM
