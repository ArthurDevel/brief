"""
Tests for Twilio authentication helpers and PIN no-input retry endpoints.

Covers lookup_user_by_phone which queries user_settings using the
phone->>number JSONB path. All Supabase calls are mocked.

Also covers integration tests for the Twilio voice endpoints:
- /twilio/voice returns Gather with timeout and Redirect to /twilio/no-input
- /twilio/no-input re-prompts under max repeats
- /twilio/no-input hangs up at max repeats
- /twilio/verify-pin resets no_input_count on wrong PIN

Responsibilities:
- Verify lookup_user_by_phone returns user_id and pin_locked for a known number
- Verify lookup_user_by_phone returns None for an unknown number
- Verify PIN no-input retry flow via FastAPI endpoints
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from unittest.mock import MagicMock, patch

from starlette.testclient import TestClient

from src.auth.twilio_auth import lookup_user_by_phone
from src.server import app


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


# ============================================================================
# INTEGRATION TESTS: PIN no-input retry endpoints
# ============================================================================

# Override the lifespan so the TestClient does not try to connect to
# external services (Metered, Supabase, etc.) on startup.
@asynccontextmanager
async def _noop_lifespan(app):
    yield

app.router.lifespan_context = _noop_lifespan
_client = TestClient(app)


@patch("src.server.check_usage_limit", return_value=True)
@patch("src.server.lookup_user_by_phone", return_value={"user_id": "user-123", "pin_locked": False})
@patch("src.server.create_service_client")
@patch("src.server.load_settings")
def test_twilio_voice_returns_gather_with_timeout_and_redirect(
    _mock_settings, _mock_supabase, _mock_lookup, _mock_usage
):
    """POST /twilio/voice for a valid caller returns TwiML with timeout on
    Gather and a Redirect to /twilio/no-input (not Goodbye).
    """
    response = _client.post("/twilio/voice", data={"From": "+15550001111"})

    assert response.status_code == 200
    body = response.text
    assert 'timeout="10"' in body
    assert "<Gather" in body
    assert "<Redirect" in body
    assert "/twilio/no-input" in body
    assert "noInputCount=1" in body
    assert "Goodbye" not in body


def test_no_input_endpoint_reprompts_under_max():
    """POST /twilio/no-input with noInputCount below max returns a new Gather
    and a Redirect with incremented noInputCount.
    """
    response = _client.post(
        "/twilio/no-input?userId=user-123&attempt=1&noInputCount=1"
    )

    assert response.status_code == 200
    body = response.text
    assert "<Gather" in body
    assert "<Redirect" in body
    assert "noInputCount=2" in body
    assert "Goodbye" not in body


def test_no_input_endpoint_hangs_up_at_max():
    """POST /twilio/no-input with noInputCount at max returns Goodbye and
    does NOT contain a Redirect.
    """
    response = _client.post(
        "/twilio/no-input?userId=user-123&attempt=1&noInputCount=3"
    )

    assert response.status_code == 200
    body = response.text
    assert "No input received. Goodbye." in body
    assert "<Redirect" not in body


@patch("src.server.verify_pin", return_value=False)
@patch("src.server.create_service_client")
@patch("src.server.load_settings")
def test_wrong_pin_resets_no_input_count(
    _mock_settings, _mock_supabase_factory, _mock_verify_pin
):
    """POST /twilio/verify-pin with wrong digits returns TwiML whose Redirect
    URL contains noInputCount=1, meaning no_input_count was reset to 0.
    """
    # Mock the supabase pin_hash query chain
    mock_supabase = _mock_supabase_factory.return_value
    mock_execute = MagicMock()
    mock_execute.data = {"pin_hash": "$2b$12$fakehashvalue"}
    (
        mock_supabase.table.return_value
        .select.return_value
        .eq.return_value
        .single.return_value
    ).execute.return_value = mock_execute

    response = _client.post(
        "/twilio/verify-pin?userId=user-123&attempt=1",
        data={"Digits": "000000"},
    )

    assert response.status_code == 200
    body = response.text
    assert "<Gather" in body
    assert "noInputCount=1" in body
    assert "<Redirect" in body
