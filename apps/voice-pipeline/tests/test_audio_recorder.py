"""
Tests for the recorder upload utility.

Verifies that:
- upload_recording swallows exceptions and does not raise
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest  # type: ignore[import-untyped]

from src.audio.recorder import upload_recording


# ============================================================================
# TESTS
# ============================================================================

@pytest.mark.asyncio
async def test_upload_recording_swallows_exceptions() -> None:
    """upload_recording swallows exceptions and does not raise.

    Calls upload_recording with a mock Supabase client whose upload raises.
    Verifies no exception propagates.
    """
    mock_supabase = MagicMock()
    mock_supabase.storage.from_.return_value.upload.side_effect = RuntimeError("network error")

    # This should not raise
    await upload_recording("test-session-123", b"fake-wav-data", mock_supabase)
