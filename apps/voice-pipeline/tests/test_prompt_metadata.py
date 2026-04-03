"""
Unit tests for session metadata rendering in build_system_prompt.

Verifies that the "Session context" section is included when SessionMetadata
is provided and omitted when it is not.
"""

from __future__ import annotations

from src.prompt import build_system_prompt
from src.session import SessionMetadata


# --------------------------------------------------------------------------
# build_system_prompt with session metadata
# --------------------------------------------------------------------------

class TestBuildSystemPromptMetadata:
    """Unit tests for the session metadata section in the system prompt."""

    def test_includes_metadata_section_when_metadata_provided(self) -> None:
        """When SessionMetadata is passed, the prompt contains a Session context block."""
        metadata = SessionMetadata(
            current_datetime="2025-01-15T10:30:00+00:00",
            user_email="alice@example.com",
            last_call_datetime="2025-01-14T18:00:00+00:00",
        )

        prompt = build_system_prompt(
            memory_entries=[],
            tool_approval_config={},
            session_metadata=metadata,
        )

        assert "Session context" in prompt
        assert "2025-01-15T10:30:00+00:00" in prompt
        assert "alice@example.com" in prompt
        assert "2025-01-14T18:00:00+00:00" in prompt

    def test_includes_first_call_when_last_call_is_none(self) -> None:
        """When last_call_datetime is None, the prompt shows 'First call'."""
        metadata = SessionMetadata(
            current_datetime="2025-01-15T10:30:00+00:00",
            user_email="alice@example.com",
            last_call_datetime=None,
        )

        prompt = build_system_prompt(
            memory_entries=[],
            tool_approval_config={},
            session_metadata=metadata,
        )

        assert "Session context" in prompt
        assert "First call" in prompt

    def test_omits_metadata_section_when_no_metadata(self) -> None:
        """When session_metadata is None, no Session context section appears."""
        prompt = build_system_prompt(
            memory_entries=[],
            tool_approval_config={},
            session_metadata=None,
        )

        assert "Session context" not in prompt
