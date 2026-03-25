"""
Tests for the MarkdownStripperProcessor.

Verifies that:
- Markdown formatting characters are stripped from text while preserving words
- LLMTextFrame with markdown is cleaned before reaching TTS
- LLMTextFrame that becomes empty after stripping produces no output
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest  # type: ignore[import-untyped]

from pipecat.frames.frames import Frame, LLMTextFrame
from pipecat.processors.frame_processor import FrameDirection

from src.audio.markdown_stripper import strip_markdown, MarkdownStripperProcessor


# ============================================================================
# TESTS: strip_markdown
# ============================================================================

def test_strip_markdown_removes_formatting_and_preserves_words() -> None:
    """Markdown formatting characters are removed, plain words are preserved."""
    assert strip_markdown("**bold**") == "bold"
    assert strip_markdown("*italic*") == "italic"
    assert strip_markdown("***both***") == "both"
    assert strip_markdown("__underline__") == "underline"
    assert strip_markdown("~~struck~~") == "struck"
    assert strip_markdown("`code`") == "code"
    assert strip_markdown("## Heading") == " Heading"
    assert strip_markdown("> quote") == " quote"
    assert strip_markdown("- item") == "item"
    assert strip_markdown("1. item") == "item"
    assert strip_markdown("---") == ""
    assert strip_markdown("*") == ""
    assert strip_markdown("Hello world") == "Hello world"


# ============================================================================
# TESTS: MarkdownStripperProcessor
# ============================================================================

@pytest.mark.asyncio
async def test_processor_strips_markdown_from_llm_text_frame() -> None:
    """LLMTextFrame with markdown is cleaned and pushed downstream."""
    processor = MarkdownStripperProcessor()
    captured_frames: list[Frame] = []

    async def mock_push(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        captured_frames.append(frame)

    processor.push_frame = AsyncMock(side_effect=mock_push)

    await processor.process_frame(LLMTextFrame(text="**hello**"), FrameDirection.DOWNSTREAM)

    assert len(captured_frames) == 1
    assert isinstance(captured_frames[0], LLMTextFrame)
    assert captured_frames[0].text == "hello"


@pytest.mark.asyncio
async def test_processor_drops_empty_frame_after_stripping() -> None:
    """LLMTextFrame that becomes empty after stripping produces no output."""
    processor = MarkdownStripperProcessor()
    captured_frames: list[Frame] = []

    async def mock_push(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        captured_frames.append(frame)

    processor.push_frame = AsyncMock(side_effect=mock_push)

    await processor.process_frame(LLMTextFrame(text="**"), FrameDirection.DOWNSTREAM)

    assert len(captured_frames) == 0
