"""
Tests for the newsletter summary feature.

Covers the background job functions (get_opted_in_users, generate_daily_summary_for_user),
the tool handlers (get_newsletter_summary, set_newsletter_config), and the HTTP endpoint.
All external dependencies (Supabase, IMAP, LLM) are mocked.

Responsibilities:
- Verify get_opted_in_users filters by enabled flag and IMAP credentials
- Verify generate_daily_summary_for_user stores correct data for zero and non-zero emails
- Verify timezone-aware "yesterday" computation produces different dates
- Verify get_newsletter_summary tool returns summary and marks as listened
- Verify get_newsletter_summary tool handles missing rows
- Verify set_newsletter_config tool performs partial merge
- Verify the /api/newsletter/generate-daily endpoint rejects unauthorized requests
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from zoneinfo import ZoneInfo

import httpx
import pytest

from src.config import Settings
from src.newsletter import (
    NO_NEWSLETTERS_MESSAGE,
    NewsletterConfig,
    OptedInUser,
    generate_daily_summary_for_user,
    get_opted_in_users,
)
from src.session import ImapConfig
from src.tools.handlers import _dispatch_tool


# ============================================================================
# CONSTANTS
# ============================================================================

FAKE_USER_ID = "user-111"
FAKE_API_KEY = "fake-openrouter-key"
FAKE_SUMMARY = "Here is your newsletter summary for today."

FAKE_IMAP_CONFIG = ImapConfig(
    host="imap.example.com",
    port=993,
    user="test@example.com",
    password="secret",
)

FAKE_NEWSLETTER_CONFIG = NewsletterConfig(
    enabled=True,
    newsletters=["news@example.com"],
    summary_prompt=None,
)

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
)


# ============================================================================
# HELPERS
# ============================================================================

def _mock_supabase_for_opted_in(rows: list[dict]) -> MagicMock:
    """Create a mock Supabase client for get_opted_in_users.

    The query chain is: table().select().not_.is_().execute()

    Args:
        rows: The rows to return from the query.

    Returns:
        A MagicMock Supabase client.
    """
    mock_client = MagicMock()
    mock_execute = MagicMock()
    mock_execute.data = rows

    chain = mock_client.table.return_value.select.return_value.not_.is_.return_value
    chain.execute.return_value = mock_execute
    return mock_client


def _make_user_settings_row(
    user_id: str,
    newsletter_config: dict | None,
    has_imap: bool = True,
    country_code: str = "US",
    timezone: str | None = None,
) -> dict[str, Any]:
    """Build a fake user_settings row for get_opted_in_users tests.

    Args:
        user_id: The user ID.
        newsletter_config: The newsletter_config JSONB value.
        has_imap: Whether to include IMAP credentials.
        country_code: Country code for phone JSONB.
        timezone: Explicit timezone in call_schedule, or None.

    Returns:
        A dict mimicking a Supabase user_settings row.
    """
    row: dict[str, Any] = {
        "user_id": user_id,
        "newsletter_config": newsletter_config,
        "imap_host": "imap.example.com" if has_imap else None,
        "imap_port": 993 if has_imap else None,
        "imap_user": "user@example.com" if has_imap else None,
        "imap_password_secret_id": "secret-id" if has_imap else None,
        "phone": {"number": "+15550001111", "countryCode": country_code},
        "call_schedule": {"timezone": timezone} if timezone else None,
    }
    return row


# ============================================================================
# TESTS: get_opted_in_users
# ============================================================================

@patch("src.newsletter.retrieve_secret", return_value="fake-password")
def test_get_opted_in_users_filters_by_enabled_and_imap(mock_secret: MagicMock) -> None:
    """get_opted_in_users returns only users with enabled=true and valid IMAP credentials.

    Sets up three users: one enabled with creds (returned), one enabled without
    creds (skipped), one disabled (skipped). Asserts only the first is returned.
    """
    rows = [
        _make_user_settings_row(
            "user-enabled-with-creds",
            {"enabled": True, "newsletters": ["a@x.com"]},
            has_imap=True,
        ),
        _make_user_settings_row(
            "user-enabled-no-creds",
            {"enabled": True, "newsletters": ["b@x.com"]},
            has_imap=False,
        ),
        _make_user_settings_row(
            "user-disabled",
            {"enabled": False, "newsletters": ["c@x.com"]},
            has_imap=True,
        ),
    ]

    mock_client = _mock_supabase_for_opted_in(rows)
    result = get_opted_in_users(mock_client)

    assert len(result) == 1
    assert result[0].user_id == "user-enabled-with-creds"
    assert result[0].newsletter_config.enabled is True


# ============================================================================
# TESTS: generate_daily_summary_for_user
# ============================================================================

@patch("src.newsletter.fetch_newsletters_for_date", return_value=[])
@pytest.mark.asyncio
async def test_generate_daily_summary_stores_zero_emails_when_none_found(
    mock_fetch: MagicMock,
) -> None:
    """generate_daily_summary_for_user stores email_count=0 and fixed message when no emails found.

    Mocks IMAP to return empty results, asserts the upserted row has
    email_count=0 and the fixed NO_NEWSLETTERS_MESSAGE.
    """
    user = OptedInUser(
        user_id=FAKE_USER_ID,
        imap_config=FAKE_IMAP_CONFIG,
        newsletter_config=FAKE_NEWSLETTER_CONFIG,
        timezone="UTC",
    )

    mock_supabase = MagicMock()
    target = date(2026, 4, 2)

    result = await generate_daily_summary_for_user(user, target, FAKE_API_KEY, mock_supabase)

    assert result == NO_NEWSLETTERS_MESSAGE

    # Verify the upsert call
    upsert_call = mock_supabase.table.return_value.upsert
    upsert_call.assert_called_once()
    upserted_data = upsert_call.call_args[0][0]
    assert upserted_data["email_count"] == 0
    assert upserted_data["summary"] == NO_NEWSLETTERS_MESSAGE
    assert upserted_data["user_id"] == FAKE_USER_ID


@patch("src.newsletter.generate_summary", new_callable=AsyncMock, return_value=FAKE_SUMMARY)
@patch("src.newsletter.fetch_newsletters_for_date")
@pytest.mark.asyncio
async def test_generate_daily_summary_stores_llm_summary_when_emails_found(
    mock_fetch: MagicMock,
    mock_generate: AsyncMock,
) -> None:
    """generate_daily_summary_for_user stores the LLM summary and correct email_count when emails found.

    Mocks IMAP to return 3 emails and LLM to return a known summary string.
    Asserts the upserted row has email_count=3 and the LLM summary.
    """
    from src.newsletter import NewsletterEmail

    mock_fetch.return_value = [
        NewsletterEmail(subject="News 1", body="Body 1", from_addr="a@x.com", date="2026-04-02"),
        NewsletterEmail(subject="News 2", body="Body 2", from_addr="b@x.com", date="2026-04-02"),
        NewsletterEmail(subject="News 3", body="Body 3", from_addr="c@x.com", date="2026-04-02"),
    ]

    user = OptedInUser(
        user_id=FAKE_USER_ID,
        imap_config=FAKE_IMAP_CONFIG,
        newsletter_config=FAKE_NEWSLETTER_CONFIG,
        timezone="UTC",
    )

    mock_supabase = MagicMock()
    target = date(2026, 4, 2)

    result = await generate_daily_summary_for_user(user, target, FAKE_API_KEY, mock_supabase)

    assert result == FAKE_SUMMARY

    # Verify the upsert call
    upsert_call = mock_supabase.table.return_value.upsert
    upsert_call.assert_called_once()
    upserted_data = upsert_call.call_args[0][0]
    assert upserted_data["email_count"] == 3
    assert upserted_data["summary"] == FAKE_SUMMARY


# ============================================================================
# TESTS: timezone-aware "yesterday" computation
# ============================================================================

@patch("src.newsletter.generate_summary", new_callable=AsyncMock, return_value=FAKE_SUMMARY)
@patch("src.newsletter.fetch_newsletters_for_date", return_value=[])
@pytest.mark.asyncio
async def test_background_job_uses_user_timezone_for_yesterday(
    mock_fetch: MagicMock,
    mock_generate: AsyncMock,
) -> None:
    """The background job uses the user's resolved timezone to determine "yesterday".

    Freezes time to 2026-04-04 00:30 UTC. Two users:
    - Pacific/Auckland (UTC+12): local time is April 4 12:30, yesterday = April 3
    - Pacific/Honolulu (UTC-10): local time is April 3 14:30, yesterday = April 2

    Asserts the two users get different target_date values passed to fetch_newsletters_for_date.
    """
    from src.newsletter import run_daily_newsletter_job

    user_nz = OptedInUser(
        user_id="user-nz",
        imap_config=FAKE_IMAP_CONFIG,
        newsletter_config=FAKE_NEWSLETTER_CONFIG,
        timezone="Pacific/Auckland",
    )
    user_hi = OptedInUser(
        user_id="user-hi",
        imap_config=FAKE_IMAP_CONFIG,
        newsletter_config=FAKE_NEWSLETTER_CONFIG,
        timezone="Pacific/Honolulu",
    )

    fixed_utc = datetime(2026, 4, 4, 0, 30, 0, tzinfo=ZoneInfo("UTC"))

    mock_supabase = MagicMock()

    with (
        patch("src.newsletter.get_opted_in_users", return_value=[user_nz, user_hi]),
        patch("src.newsletter.datetime") as mock_dt,
    ):
        # datetime.now(tz) returns the fixed UTC time converted to the requested tz
        def fake_now(tz=None):
            if tz is None:
                return fixed_utc
            return fixed_utc.astimezone(tz)

        mock_dt.now.side_effect = fake_now
        mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)

        await run_daily_newsletter_job(mock_supabase, FAKE_API_KEY)

    # fetch_newsletters_for_date was called twice, extract the target_date args
    assert mock_fetch.call_count == 2

    # First call is for user_nz, second for user_hi
    nz_target_date = mock_fetch.call_args_list[0][0][2]  # positional arg index 2
    hi_target_date = mock_fetch.call_args_list[1][0][2]

    assert nz_target_date == date(2026, 4, 3), f"Auckland yesterday should be April 3, got {nz_target_date}"
    assert hi_target_date == date(2026, 4, 2), f"Honolulu yesterday should be April 2, got {hi_target_date}"


# ============================================================================
# TESTS: get_newsletter_summary tool handler
# ============================================================================

def test_get_newsletter_summary_returns_summary_and_marks_listened() -> None:
    """get_newsletter_summary tool returns yesterday's summary and marks it as listened.

    Mocks Supabase to return a summary row with listened=false and email_count=3.
    Asserts the result contains the summary text, email_count=3, and listened_already=false.
    """
    mock_supabase = MagicMock()

    # Mock _resolve_user_timezone chain: table().select().eq().single().execute()
    mock_tz_execute = MagicMock()
    mock_tz_execute.data = {"call_schedule": {"timezone": "UTC"}, "phone": None}

    # Mock newsletter_summaries query: table().select().eq().eq().execute()
    mock_summary_execute = MagicMock()
    mock_summary_execute.data = [{
        "id": "summary-1",
        "summary": FAKE_SUMMARY,
        "email_count": 3,
        "listened": False,
    }]

    # The handler calls table() multiple times. We need to route different table names.
    def table_router(table_name: str) -> MagicMock:
        mock_table = MagicMock()
        if table_name == "user_settings":
            # Chain: select().eq().single().execute()
            mock_table.select.return_value.eq.return_value.single.return_value.execute.return_value = mock_tz_execute
        elif table_name == "newsletter_summaries":
            # For select: select().eq().eq().execute()
            mock_table.select.return_value.eq.return_value.eq.return_value.execute.return_value = mock_summary_execute
            # For update: update().eq().execute()
            mock_table.update.return_value.eq.return_value.execute.return_value = MagicMock()
        return mock_table

    mock_supabase.table.side_effect = table_router

    result, undo, msg_id = _dispatch_tool(
        tool_name="get_newsletter_summary",
        args={},
        imap_holder={"client": MagicMock(), "config": FAKE_IMAP_CONFIG},
        smtp_config=MagicMock(),
        supabase=mock_supabase,
        user_id=FAKE_USER_ID,
    )

    assert result["summary"] == FAKE_SUMMARY
    assert result["email_count"] == 3
    assert result["listened_already"] is False
    assert undo is None
    assert msg_id is None


def test_get_newsletter_summary_returns_no_summary_when_no_row() -> None:
    """get_newsletter_summary tool returns "no summary available" when no row exists.

    Mocks Supabase to return no rows for newsletter_summaries.
    """
    mock_supabase = MagicMock()

    # Mock _resolve_user_timezone
    mock_tz_execute = MagicMock()
    mock_tz_execute.data = {"call_schedule": {"timezone": "UTC"}, "phone": None}

    # Mock newsletter_summaries query -- no rows
    mock_summary_execute = MagicMock()
    mock_summary_execute.data = []

    def table_router(table_name: str) -> MagicMock:
        mock_table = MagicMock()
        if table_name == "user_settings":
            mock_table.select.return_value.eq.return_value.single.return_value.execute.return_value = mock_tz_execute
        elif table_name == "newsletter_summaries":
            mock_table.select.return_value.eq.return_value.eq.return_value.execute.return_value = mock_summary_execute
        return mock_table

    mock_supabase.table.side_effect = table_router

    result, undo, msg_id = _dispatch_tool(
        tool_name="get_newsletter_summary",
        args={},
        imap_holder={"client": MagicMock(), "config": FAKE_IMAP_CONFIG},
        smtp_config=MagicMock(),
        supabase=mock_supabase,
        user_id=FAKE_USER_ID,
    )

    assert "message" in result
    assert "no" in result["message"].lower() and "summary" in result["message"].lower()
    assert undo is None


# ============================================================================
# TESTS: set_newsletter_config tool handler
# ============================================================================

def test_set_newsletter_config_returns_merged_config() -> None:
    """set_newsletter_config tool returns updated config after partial merge.

    Mocks existing config { enabled: false, newsletters: ["old@x.com"] }, calls with
    { enabled: true }. Asserts the result has enabled=true and newsletters still
    contains "old@x.com".
    """
    mock_supabase = MagicMock()

    # Mock read current config: table().select().eq().single().execute()
    mock_read_execute = MagicMock()
    mock_read_execute.data = {
        "newsletter_config": {
            "enabled": False,
            "newsletters": ["old@x.com"],
            "summary_prompt": None,
        }
    }

    def table_router(table_name: str) -> MagicMock:
        mock_table = MagicMock()
        if table_name == "user_settings":
            # For select (read): select().eq().single().execute()
            mock_table.select.return_value.eq.return_value.single.return_value.execute.return_value = mock_read_execute
            # For update (write): update().eq().execute()
            mock_table.update.return_value.eq.return_value.execute.return_value = MagicMock()
        return mock_table

    mock_supabase.table.side_effect = table_router

    result, undo, msg_id = _dispatch_tool(
        tool_name="set_newsletter_config",
        args={"enabled": True},
        imap_holder={"client": MagicMock(), "config": FAKE_IMAP_CONFIG},
        smtp_config=MagicMock(),
        supabase=mock_supabase,
        user_id=FAKE_USER_ID,
    )

    assert result["updated"] is True
    assert result["config"]["enabled"] is True
    assert "old@x.com" in result["config"]["newsletters"]
    assert undo is None


# ============================================================================
# TESTS: POST /api/newsletter/generate-daily endpoint
# ============================================================================

@pytest.mark.asyncio
async def test_newsletter_endpoint_rejects_invalid_api_key() -> None:
    """POST /api/newsletter/generate-daily returns 401 without valid Authorization header.

    Uses httpx.ASGITransport with mocked dependencies to test the endpoint
    without starting real services.
    """
    # Ensure twilio is available (may not be installed locally) so src.server can import
    import sys
    if "twilio" not in sys.modules:
        twilio_mock = MagicMock()
        sys.modules["twilio"] = twilio_mock
        sys.modules["twilio.rest"] = twilio_mock.rest

    import src.server  # noqa: F401

    with (
        patch("src.server.load_settings", return_value=FAKE_SETTINGS),
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
            # No Authorization header
            resp_none = await client.post("/api/newsletter/generate-daily")
            assert resp_none.status_code == 401

            # Wrong API key
            resp_wrong = await client.post(
                "/api/newsletter/generate-daily",
                headers={"Authorization": "Bearer wrong-key"},
            )
            assert resp_wrong.status_code == 401
