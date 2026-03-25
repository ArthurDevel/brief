"""
Tests for Twilio authentication helpers (phone lookup via JSONB column).

Covers lookup_user_by_phone which queries user_settings using the
phone->>number JSONB path. All Supabase calls are mocked.

Responsibilities:
- Verify lookup_user_by_phone returns user_id and pin_locked for a known number
- Verify lookup_user_by_phone returns None for an unknown number
"""

from __future__ import annotations

from unittest.mock import MagicMock

from src.auth.twilio_auth import lookup_user_by_phone


# ============================================================================
# FIXTURES
# ============================================================================

def _mock_supabase_lookup(data: dict | None) -> MagicMock:
    """Create a mock Supabase client for the lookup_user_by_phone query chain.

    Mocks the chain: table().select().eq().maybe_single().execute()

    Args:
        data: The row data to return, or None if no user found.

    Returns:
        A MagicMock configured as a Supabase client.
    """
    mock_client = MagicMock()
    mock_execute = MagicMock()
    mock_execute.data = data

    chain = (
        mock_client.table.return_value
        .select.return_value
        .eq.return_value
        .maybe_single.return_value
    )
    chain.execute.return_value = mock_execute
    return mock_client


# ============================================================================
# TESTS: lookup_user_by_phone
# ============================================================================

def test_lookup_user_by_phone_queries_jsonb_number():
    """lookup_user_by_phone returns user_id and pin_locked for a known number.

    When a user has phone: { "number": "+15550001111", "countryCode": "US" },
    the function queries phone->>number and returns the matching row.
    """
    mock_client = _mock_supabase_lookup({
        "user_id": "user-abc-123",
        "pin_locked": True,
    })

    result = lookup_user_by_phone("+15550001111", mock_client)

    assert result is not None
    assert result["user_id"] == "user-abc-123"
    assert result["pin_locked"] is True

    # Verify the query chain was called with the correct JSONB path
    mock_client.table.assert_called_with("user_settings")
    mock_client.table.return_value.select.assert_called_with("user_id, pin_locked")
    mock_client.table.return_value.select.return_value.eq.assert_called_with(
        "phone->>number", "+15550001111"
    )


def test_lookup_user_by_phone_returns_none_for_unknown():
    """lookup_user_by_phone returns None when no user matches the phone number."""
    mock_client = _mock_supabase_lookup(None)

    result = lookup_user_by_phone("+19999999999", mock_client)

    assert result is None
