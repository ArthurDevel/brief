"""
Strips markdown syntax from LLM text before it reaches the TTS engine.

Intercepts LLMTextFrame in the pipeline and removes markdown formatting
characters so the TTS does not narrate them as literal characters.

Because LLM output arrives as small streaming tokens (often a single character),
regex-based stripping does not work -- a `*` arrives alone, not wrapped around
text. Instead, we strip characters that serve no spoken purpose.

- MarkdownStripperProcessor: Pipecat FrameProcessor placed between LLM and TTS
"""

from __future__ import annotations

import re

from pipecat.frames.frames import Frame, LLMTextFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


# ============================================================================
# CONSTANTS
# ============================================================================

# Characters used for markdown formatting that should never be spoken.
STRIP_CHARS = set("*_~`#>")

# Patterns to clean up residual markdown artifacts after char stripping.
# Applied to each token, so these are simple and don't require full spans.
CLEANUP_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"^\s*[-+]\s+"), ""),         # list markers like "- " or "+ "
    (re.compile(r"^\s*\d+\.\s+"), ""),         # ordered list markers like "1. "
    (re.compile(r"^---+$"), ""),                # horizontal rules
]


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def strip_markdown(text: str) -> str:
    """Remove markdown formatting characters from a text token.

    Strips individual formatting characters (*, _, ~, `, #, >) and cleans
    up list markers and horizontal rules.

    Args:
        text: A text token, potentially containing markdown characters.

    Returns:
        Text with markdown characters removed.
    """
    # Step 1: remove formatting characters
    cleaned = "".join(ch for ch in text if ch not in STRIP_CHARS)

    # Step 2: clean up list markers and rules
    for pattern, replacement in CLEANUP_PATTERNS:
        cleaned = pattern.sub(replacement, cleaned)

    return cleaned


# ============================================================================
# PIPECAT FRAME PROCESSOR
# ============================================================================

class MarkdownStripperProcessor(FrameProcessor):
    """Strips markdown syntax from LLM text frames before they reach TTS.

    Intercepts LLMTextFrame, removes markdown formatting characters, and
    pushes a cleaned frame downstream. All other frame types pass through
    unchanged.
    """

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Process a pipeline frame. Strips markdown from LLM text frames.

        Args:
            frame: The pipeline frame.
            direction: The direction the frame is traveling.
        """
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMTextFrame):
            cleaned = strip_markdown(frame.text)
            if cleaned:
                await self.push_frame(LLMTextFrame(text=cleaned), direction)
        else:
            await self.push_frame(frame, direction)
