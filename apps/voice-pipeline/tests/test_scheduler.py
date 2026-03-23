"""
Tests for the scheduled calling feature.

Covers the scheduler's public functions (get_due_users, initiate_scheduled_call)
and the /twilio/scheduled-call endpoint. All external dependencies (Supabase,
Twilio, usage limits) are mocked.

Responsibilities:
- Verify get_due_users correctly filters users by day, time window, dedup guard,
  usage limit, and timezone
- Verify initiate_scheduled_call claims the slot, calls Twilio, and rolls back on failure
- Verify the /twilio/scheduled-call endpoint validates the API key and returns TwiML
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch, AsyncMock
from zoneinfo import ZoneInfo

import httpx
import pytest

from src.scheduler import DueUser, get_due_users, initiate_scheduled_call
from src.config import Settings


# ============================================================================
# CONSTANTS
# ============================================================================

FAKE_SETTINGS = Settings(
    supabase_url="https://fake.supabase.co",
    supabase_service_role_key="fake-key",
    deepgram_api_key="fake-deepgram",
    openrouter_api_key="fake-openrouter",
    web_app_url="https://fake-web.example.com",
    internal_api_key="test-internal-key",
    port=7860,
    public_url="https://voice.example.com",
    twilio_account_sid="AC_fake_sid",
    twilio_auth_token="fake_auth_token",
    twilio_phone_number="+15551234567",
)


# ============================================================================
# FIXTURES
# ============================================================================

def _make_supabase_row(user_id: str, phone_number: str, schedule: dict) -> dict:
    """Build a fake user_settings row as returned by Supabase."""
    return {
        "user_id": user_id,
        "phone_number": phone_number,
        "call_schedule": schedule,
    }


def _mock_supabase_select(rows: list[dict]) -> MagicMock:
    """Create a mock Supabase client whose table('user_settings').select(...) returns rows.

    The Supabase query chain is: table().select().not_.is_().execute()
    Note: not_ is an attribute (not a method call), so we use .not_.is_() in the chain.
    """
    mock_client = MagicMock()
    mock_execute = MagicMock()
    mock_execute.data = rows

    chain = mock_client.table.return_value.select.return_value.not_.is_.return_value
    chain.execute.return_value = mock_execute
    return mock_client


# ============================================================================
# TESTS: get_due_users
# ============================================================================

@patch("src.scheduler.check_usage_limit", return_value=True)
def test_get_due_users_returns_due_user_and_skips_not_due(mock_usage):
    """get_due_users returns only users whose schedule matches the current time.

    Sets up two users: one scheduled for the current time (due), one scheduled
    for a different time (not due). Asserts only the due user is returned.
    """
    tz = ZoneInfo("UTC")
    now = datetime.now(tz)
    day_key = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][now.weekday()]
    current_time_str = now.strftime("%H:%M")

    # A time that is definitely not now (6 hours offset, wrapped)
    not_now_hour = (now.hour + 6) % 24
    not_now_str = f"{not_now_hour:02d}:00"

    due_row = _make_supabase_row("user-due", "+15550001111", {
        "timezone": "UTC",
        day_key: current_time_str,
    })
    not_due_row = _make_supabase_row("user-not-due", "+15550002222", {
        "timezone": "UTC",
        day_key: not_now_str,
    })

    mock_client = _mock_supabase_select([due_row, not_due_row])
    result = get_due_users(mock_client)

    assert len(result) == 1
    assert result[0].user_id == "user-due"
    assert result[0].phone_number == "+15550001111"


@patch("src.scheduler.check_usage_limit", return_value=True)
def test_get_due_users_skips_already_called_today(mock_usage):
    """get_due_users skips users whose last_call_at is today (dedup guard).

    The user's schedule matches the current time, but last_call_at is set to
    a timestamp from today in their timezone, so they should be filtered out.
    """
    tz = ZoneInfo("UTC")
    now = datetime.now(tz)
    day_key = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][now.weekday()]
    current_time_str = now.strftime("%H:%M")

    # last_call_at is set to 1 minute ago (today)
    last_call = (now - timedelta(minutes=1)).isoformat()

    row = _make_supabase_row("user-already-called", "+15550001111", {
        "timezone": "UTC",
        day_key: current_time_str,
        "last_call_at": last_call,
    })

    mock_client = _mock_supabase_select([row])
    result = get_due_users(mock_client)

    assert len(result) == 0


@patch("src.scheduler.check_usage_limit", return_value=False)
def test_get_due_users_skips_usage_limit_exceeded(mock_usage):
    """get_due_users skips users who have exceeded their monthly usage limit.

    The user's schedule matches and last_call_at is not today, but
    check_usage_limit returns False, so the user should be filtered out.
    """
    tz = ZoneInfo("UTC")
    now = datetime.now(tz)
    day_key = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][now.weekday()]
    current_time_str = now.strftime("%H:%M")

    row = _make_supabase_row("user-over-limit", "+15550001111", {
        "timezone": "UTC",
        day_key: current_time_str,
    })

    mock_client = _mock_supabase_select([row])
    result = get_due_users(mock_client)

    assert len(result) == 0


@patch("src.scheduler.check_usage_limit", return_value=True)
def test_get_due_users_handles_different_timezones(mock_usage):
    """get_due_users respects each user's timezone when determining if they are due.

    Two users are both scheduled for 09:00. The current UTC time is frozen to
    09:02 UTC. The UTC user is due (09:02 local), but the US/Eastern user
    is not (04:02 local != 09:00).
    """
    # Fix "now" to 09:02 UTC on a known day
    fixed_utc = datetime(2026, 3, 25, 9, 2, 0, tzinfo=ZoneInfo("UTC"))  # Wednesday
    day_key = "wednesday"

    utc_row = _make_supabase_row("user-utc", "+15550001111", {
        "timezone": "UTC",
        day_key: "09:00",
    })
    eastern_row = _make_supabase_row("user-eastern", "+15550002222", {
        "timezone": "US/Eastern",
        day_key: "09:00",
    })

    mock_client = _mock_supabase_select([utc_row, eastern_row])

    with patch("src.scheduler.datetime") as mock_dt:
        # datetime.now(tz) should return our fixed time converted to the requested tz
        def fake_now(tz=None):
            if tz is None:
                return fixed_utc
            return fixed_utc.astimezone(tz)

        mock_dt.now.side_effect = fake_now
        mock_dt.fromisoformat = datetime.fromisoformat
        mock_dt.side_effect = lambda *args, **kwargs: datetime(*args, **kwargs)

        result = get_due_users(mock_client)

    assert len(result) == 1
    assert result[0].user_id == "user-utc"


@patch("src.scheduler.check_usage_limit", return_value=True)
def test_get_due_users_returns_empty_when_all_days_null(mock_usage):
    """get_due_users returns empty list when all days in the schedule are null.

    The user has a call_schedule with a timezone set, but every day is null
    (schedule fully disabled). They should never be returned as due.
    """
    row = _make_supabase_row("user-disabled", "+15550001111", {
        "timezone": "UTC",
        "monday": None,
        "tuesday": None,
        "wednesday": None,
        "thursday": None,
        "friday": None,
        "saturday": None,
        "sunday": None,
    })

    mock_client = _mock_supabase_select([row])
    result = get_due_users(mock_client)

    assert len(result) == 0


# ============================================================================
# TESTS: initiate_scheduled_call
# ============================================================================

@patch("src.scheduler.TwilioClient")
def test_initiate_scheduled_call_calls_twilio_and_updates_last_call_at(mock_twilio_cls):
    """initiate_scheduled_call calls Twilio with correct params and updates last_call_at.

    Verifies that:
    1. The current schedule is read from DB
    2. last_call_at is updated (slot claimed)
    3. Twilio calls.create is called with the user's phone, FROM number, and callback URL
    """
    user = DueUser(user_id="user-123", phone_number="+15559998888", timezone="UTC")

    # Mock Supabase: read current schedule, then update
    mock_supabase = MagicMock()

    # .select().eq().single().execute() for reading current schedule
    current_schedule = {"timezone": "UTC", "wednesday": "09:00"}
    mock_single_execute = MagicMock()
    mock_single_execute.data = {"call_schedule": current_schedule}
    (
        mock_supabase.table.return_value
        .select.return_value
        .eq.return_value
        .single.return_value
        .execute
    ).return_value = mock_single_execute

    # .update().eq().execute() for claiming slot
    mock_update_execute = MagicMock()
    (
        mock_supabase.table.return_value
        .update.return_value
        .eq.return_value
        .execute
    ).return_value = mock_update_execute

    # Mock Twilio client
    mock_twilio_instance = MagicMock()
    mock_twilio_cls.return_value = mock_twilio_instance
    mock_call = MagicMock()
    mock_call.sid = "CA_fake_sid"
    mock_twilio_instance.calls.create.return_value = mock_call

    result = initiate_scheduled_call(user, FAKE_SETTINGS, mock_supabase)

    assert result is True

    # Verify Twilio was called with correct params
    mock_twilio_instance.calls.create.assert_called_once()
    call_kwargs = mock_twilio_instance.calls.create.call_args
    assert call_kwargs.kwargs["to"] == "+15559998888"
    assert call_kwargs.kwargs["from_"] == "+15551234567"
    assert "scheduled-call" in call_kwargs.kwargs["url"]
    assert "token=" in call_kwargs.kwargs["url"]
    assert "userId=user-123" in call_kwargs.kwargs["url"]

    # Verify last_call_at was updated (update was called)
    mock_supabase.table.return_value.update.assert_called()
    update_arg = mock_supabase.table.return_value.update.call_args[0][0]
    assert "last_call_at" in update_arg["call_schedule"]


@patch("src.scheduler.TwilioClient")
def test_initiate_scheduled_call_rolls_back_on_twilio_failure(mock_twilio_cls):
    """initiate_scheduled_call rolls back last_call_at if Twilio call creation fails.

    When Twilio raises an exception, the scheduler should reset last_call_at
    to its previous value (None in this case) so the user can be retried.
    """
    user = DueUser(user_id="user-456", phone_number="+15559998888", timezone="UTC")

    mock_supabase = MagicMock()

    # Current schedule has no last_call_at
    current_schedule = {"timezone": "UTC", "wednesday": "09:00"}
    mock_single_execute = MagicMock()
    mock_single_execute.data = {"call_schedule": current_schedule}
    (
        mock_supabase.table.return_value
        .select.return_value
        .eq.return_value
        .single.return_value
        .execute
    ).return_value = mock_single_execute

    mock_update_execute = MagicMock()
    (
        mock_supabase.table.return_value
        .update.return_value
        .eq.return_value
        .execute
    ).return_value = mock_update_execute

    # Twilio raises an exception
    mock_twilio_instance = MagicMock()
    mock_twilio_cls.return_value = mock_twilio_instance
    mock_twilio_instance.calls.create.side_effect = Exception("Twilio API error")

    result = initiate_scheduled_call(user, FAKE_SETTINGS, mock_supabase)

    assert result is False

    # update() should have been called twice: once to claim, once to rollback
    assert mock_supabase.table.return_value.update.call_count == 2

    # The rollback call (second update) should NOT contain last_call_at
    # because the previous value was None
    rollback_arg = mock_supabase.table.return_value.update.call_args_list[1][0][0]
    assert "last_call_at" not in rollback_arg["call_schedule"]


# ============================================================================
# TESTS: /twilio/scheduled-call endpoint
# ============================================================================

@pytest.mark.asyncio
async def test_scheduled_call_endpoint_rejects_invalid_token():
    """/twilio/scheduled-call returns 401 when the API key is missing or wrong.

    Uses httpx.ASGITransport with mocked load_settings and start_scheduler
    to prevent the lifespan from starting the real scheduler.
    """
    mock_settings = FAKE_SETTINGS

    with (
        patch("src.server.load_settings", return_value=mock_settings),
        patch("src.server.start_scheduler", new_callable=AsyncMock, return_value=None),
        patch("src.server.create_service_client", return_value=MagicMock()),
        patch("src.server.session_logger"),
        patch("src.server._fetch_ice_servers", new_callable=AsyncMock, return_value=[]),
        patch("src.server.SmallWebRTCRequestHandler") as mock_handler_cls,
        patch("src.server.shutdown_langfuse_client"),
    ):
        mock_handler = MagicMock()
        mock_handler.close = AsyncMock()
        mock_handler_cls.return_value = mock_handler

        from src.server import app

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            # No token at all
            resp_no_token = await client.post(
                "/twilio/scheduled-call",
                content="",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            assert resp_no_token.status_code == 401

            # Wrong token
            resp_wrong = await client.post(
                "/twilio/scheduled-call?token=wrong-key&userId=user-123",
                content="",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            assert resp_wrong.status_code == 401


@pytest.mark.asyncio
async def test_scheduled_call_endpoint_returns_valid_twiml():
    """/twilio/scheduled-call returns valid TwiML with <Connect><Stream> for an
    authenticated request.

    Uses httpx.ASGITransport with mocked load_settings and start_scheduler
    to prevent the lifespan from starting the real scheduler.
    """
    mock_settings = FAKE_SETTINGS

    with (
        patch("src.server.load_settings", return_value=mock_settings),
        patch("src.server.start_scheduler", new_callable=AsyncMock, return_value=None),
        patch("src.server.create_service_client", return_value=MagicMock()),
        patch("src.server.session_logger"),
        patch("src.server._fetch_ice_servers", new_callable=AsyncMock, return_value=[]),
        patch("src.server.SmallWebRTCRequestHandler") as mock_handler_cls,
        patch("src.server.shutdown_langfuse_client"),
    ):
        mock_handler = MagicMock()
        mock_handler.close = AsyncMock()
        mock_handler_cls.return_value = mock_handler

        from src.server import app

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                f"/twilio/scheduled-call?token=test-internal-key&userId=user-789",
                content="CallSid=CA123&From=%2B15550001111",
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )

        assert resp.status_code == 200
        body = resp.text

        # Verify it is valid TwiML with the expected structure
        assert "<Response>" in body
        assert "<Connect>" in body
        assert "<Stream url=" in body
        assert "user-789" in body
        # Stream URL should use the public_url, not localhost
        assert "voice.example.com" in body
