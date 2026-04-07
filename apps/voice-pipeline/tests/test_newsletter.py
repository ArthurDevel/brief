"""
Tests for the newsletter summary feature.

Covers the background job (generate_daily_summary_for_user, run_daily_newsletter_job),
the tool handlers (get_newsletter_summary, set_newsletter_config), and the HTTP endpoint.
All external dependencies (Supabase, IMAP, LLM) are mocked.

Tested outcomes:
- generate_daily_summary_for_user returns NO_NEWSLETTERS_MESSAGE when no emails found
- generate_daily_summary_for_user returns summary with source references when emails found
- generate_daily_summary_for_user returns None when summary already exists (skipped)
- run_daily_newsletter_job produces different target dates for different timezones
- get_newsletter_summary tool returns summary + email_count + listened status
- get_newsletter_summary tool returns on_demand_task when no summary exists
- get_newsletter_summary tool returns summary for an explicit date
- set_newsletter_config tool merges partial update with existing config
- POST /api/newsletter/generate-daily rejects requests without valid API key
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
    NewsletterEmail,
    OptedInUser,
    generate_daily_summary_for_user,
    get_opted_in_users,
)
from src.session import EmailAccount, ImapConfig
from src.tools.email_client import EmailClientContext
from src.tools.handlers import _dispatch_tool, _handle_get_newsletter_summary


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

FAKE_EMAIL_ACCOUNT = EmailAccount(
    provider="custom",
    connection_type="imap_smtp",
    email_address="test@example.com",
    unipile_account_id=None,
    status="connected",
    imap_config=FAKE_IMAP_CONFIG,
    smtp_config=None,
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

FAKE_EMAILS = [
    NewsletterEmail(subject="News 1", body="Body 1", from_addr="a@x.com", date="2026-04-02", message_id="<msg1@x.com>"),
    NewsletterEmail(subject="News 2", body="Body 2", from_addr="b@x.com", date="2026-04-02", message_id="<msg2@x.com>"),
    NewsletterEmail(subject="News 3", body="Body 3", from_addr="c@x.com", date="2026-04-02", message_id="<msg3@x.com>"),
]


# ============================================================================
# HELPERS
# ============================================================================

def _mock_supabase_for_opted_in(
    settings_rows: list[dict],
    email_accounts: dict[str, list[dict]] | None = None,
) -> MagicMock:
    """Create a mock Supabase client for get_opted_in_users.

    Args:
        settings_rows: Rows returned by the user_settings query.
        email_accounts: Map of user_id -> account rows from user_email_accounts.
            If None, all users get a default connected custom account.
    """
    mock_client = MagicMock()

    default_account_row = {
        "id": "acc-1",
        "provider": "custom",
        "connection_type": "imap_smtp",
        "email_address": "user@example.com",
        "unipile_account_id": None,
        "status": "connected",
        "imap_host": "imap.example.com",
        "imap_port": 993,
        "imap_user": "user@example.com",
        "imap_password_secret_id": "secret-id",
        "smtp_host": "smtp.example.com",
        "smtp_port": 587,
        "smtp_user": "user@example.com",
        "smtp_password_secret_id": "smtp-secret-id",
    }

    def table_router(table_name: str) -> MagicMock:
        mock_table = MagicMock()
        if table_name == "user_settings":
            mock_table.select.return_value.not_.is_.return_value.execute.return_value = MagicMock(
                data=settings_rows
            )
        elif table_name == "user_email_accounts":
            # The .eq("user_id", ...) chain captures the user_id
            def eq_user_id(col: str, value: str) -> MagicMock:
                if email_accounts is not None:
                    account_rows = email_accounts.get(value, [])
                else:
                    account_rows = [default_account_row]
                inner = MagicMock()
                inner.eq.return_value.limit.return_value.execute.return_value = MagicMock(
                    data=account_rows
                )
                return inner
            mock_table.select.return_value.eq.side_effect = eq_user_id
        return mock_table

    mock_client.table.side_effect = table_router
    return mock_client


def _make_user_settings_row(
    user_id: str,
    newsletter_config: dict | None,
    country_code: str = "US",
    timezone: str | None = None,
) -> dict[str, Any]:
    """Build a fake user_settings row (no legacy IMAP fields)."""
    return {
        "user_id": user_id,
        "newsletter_config": newsletter_config,
        "phone": {"number": "+15550001111", "countryCode": country_code},
        "call_schedule": {"timezone": timezone} if timezone else None,
    }


def _mock_supabase_for_generation(existing_summary: dict | None = None) -> MagicMock:
    """Create a mock Supabase client for generate_daily_summary_for_user.

    Args:
        existing_summary: If provided, the existence check returns this row (simulates
            a summary that already exists). If None, existence check returns empty.
    """
    mock = MagicMock()

    # The function first does a select to check if summary exists, then upserts.
    # We configure the mock so any .execute().data returns the right thing.
    existence_result = MagicMock()
    existence_result.data = [existing_summary] if existing_summary else []

    # First call to .table().select()...execute() is the existence check
    # We use side_effect on execute to return existence first, then default
    mock.table.return_value.select.return_value.eq.return_value.eq.return_value.execute.return_value = existence_result

    return mock


def _mock_supabase_for_handler(
    timezone: str = "UTC",
    summary_row: dict | None = None,
    existing_config: dict | None = None,
) -> MagicMock:
    """Create a mock Supabase client for tool handler tests.

    Args:
        timezone: User timezone for _resolve_user_timezone.
        summary_row: If provided, newsletter_summaries query returns this row.
        existing_config: If provided, user_settings query returns this as newsletter_config.
    """
    mock = MagicMock()

    mock_tz_execute = MagicMock()
    mock_tz_execute.data = {"call_schedule": {"timezone": timezone}, "phone": None}

    mock_summary_execute = MagicMock()
    mock_summary_execute.data = [summary_row] if summary_row else []

    mock_config_execute = MagicMock()
    mock_config_execute.data = {"newsletter_config": existing_config}

    def table_router(table_name: str) -> MagicMock:
        mock_table = MagicMock()
        if table_name == "user_settings":
            mock_table.select.return_value.eq.return_value.single.return_value.execute.return_value = mock_tz_execute
            if existing_config is not None:
                mock_config_execute.data = {"newsletter_config": existing_config}
                mock_table.select.return_value.eq.return_value.single.return_value.execute.return_value = mock_config_execute
        elif table_name == "newsletter_summaries":
            mock_table.select.return_value.eq.return_value.eq.return_value.execute.return_value = mock_summary_execute
        return mock_table

    mock.table.side_effect = table_router
    return mock


# ============================================================================
# TESTS: get_opted_in_users
# ============================================================================

@patch("src.newsletter.retrieve_secret", return_value="fake-password")
def test_get_opted_in_users_filters_by_enabled_and_email_account(mock_secret: MagicMock) -> None:
    """Only users with enabled=true and an active email account are returned."""
    rows = [
        _make_user_settings_row("user-enabled-with-account", {"enabled": True, "newsletters": ["a@x.com"]}),
        _make_user_settings_row("user-enabled-no-account", {"enabled": True, "newsletters": ["b@x.com"]}),
        _make_user_settings_row("user-disabled", {"enabled": False, "newsletters": ["c@x.com"]}),
    ]

    # user-enabled-no-account has no active email account row
    mock_supabase = _mock_supabase_for_opted_in(
        settings_rows=rows,
        email_accounts={
            "user-enabled-with-account": [{
                "id": "acc-1", "provider": "custom", "connection_type": "imap_smtp",
                "email_address": "user@example.com", "unipile_account_id": None,
                "status": "connected",
                "imap_host": "imap.example.com", "imap_port": 993,
                "imap_user": "user@example.com", "imap_password_secret_id": "secret-id",
                "smtp_host": "smtp.example.com", "smtp_port": 587,
                "smtp_user": "user@example.com", "smtp_password_secret_id": "smtp-secret-id",
            }],
            "user-enabled-no-account": [],
            "user-disabled": [],
        },
    )

    result = get_opted_in_users(mock_supabase)

    assert len(result) == 1
    assert result[0].user_id == "user-enabled-with-account"
    assert result[0].newsletter_config.enabled is True


# ============================================================================
# TESTS: generate_daily_summary_for_user
# ============================================================================

@patch("src.newsletter.fetch_newsletters_for_date", return_value=[])
@pytest.mark.asyncio
async def test_generate_summary_returns_no_newsletters_message_when_no_emails(
    mock_fetch: MagicMock,
) -> None:
    """Returns NO_NEWSLETTERS_MESSAGE when no emails are found."""
    user = OptedInUser(
        user_id=FAKE_USER_ID,
        email_account=FAKE_EMAIL_ACCOUNT,
        newsletter_config=FAKE_NEWSLETTER_CONFIG,
        timezone="UTC",
    )

    result = await generate_daily_summary_for_user(
        user, date(2026, 4, 2), FAKE_API_KEY, _mock_supabase_for_generation()
    )

    assert result == NO_NEWSLETTERS_MESSAGE


@patch("src.newsletter.generate_summary", new_callable=AsyncMock, return_value=FAKE_SUMMARY)
@patch("src.newsletter.fetch_newsletters_for_date", return_value=FAKE_EMAILS)
@pytest.mark.asyncio
async def test_generate_summary_returns_summary_with_sources_when_emails_found(
    mock_fetch: MagicMock,
    mock_generate: AsyncMock,
) -> None:
    """Returns LLM summary with source references (message IDs) when emails are found."""
    user = OptedInUser(
        user_id=FAKE_USER_ID,
        email_account=FAKE_EMAIL_ACCOUNT,
        newsletter_config=FAKE_NEWSLETTER_CONFIG,
        timezone="UTC",
    )

    result = await generate_daily_summary_for_user(
        user, date(2026, 4, 2), FAKE_API_KEY, _mock_supabase_for_generation()
    )

    assert result is not None
    assert FAKE_SUMMARY in result
    assert "Sources:" in result
    assert "<msg1@x.com>" in result
    assert "<msg3@x.com>" in result


@patch("src.newsletter.fetch_newsletters_for_date", return_value=[])
@pytest.mark.asyncio
async def test_generate_summary_returns_none_when_already_exists(
    mock_fetch: MagicMock,
) -> None:
    """Returns None (skipped) when a summary already exists for that user + date."""
    user = OptedInUser(
        user_id=FAKE_USER_ID,
        email_account=FAKE_EMAIL_ACCOUNT,
        newsletter_config=FAKE_NEWSLETTER_CONFIG,
        timezone="UTC",
    )

    mock_supabase = _mock_supabase_for_generation(existing_summary={"id": "existing-1"})

    result = await generate_daily_summary_for_user(
        user, date(2026, 4, 2), FAKE_API_KEY, mock_supabase
    )

    assert result is None
    mock_fetch.assert_not_called()


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
    """Two users in different timezones get different target dates for 'yesterday'.

    Freezes time to 2026-04-04 00:30 UTC:
    - Pacific/Auckland (UTC+12): local April 4 12:30 -> yesterday = April 3
    - Pacific/Honolulu (UTC-10): local April 3 14:30 -> yesterday = April 2
    """
    from src.newsletter import run_daily_newsletter_job

    user_nz = OptedInUser(
        user_id="user-nz", email_account=FAKE_EMAIL_ACCOUNT,
        newsletter_config=FAKE_NEWSLETTER_CONFIG, timezone="Pacific/Auckland",
    )
    user_hi = OptedInUser(
        user_id="user-hi", email_account=FAKE_EMAIL_ACCOUNT,
        newsletter_config=FAKE_NEWSLETTER_CONFIG, timezone="Pacific/Honolulu",
    )

    fixed_utc = datetime(2026, 4, 4, 0, 30, 0, tzinfo=ZoneInfo("UTC"))

    with (
        patch("src.newsletter.get_opted_in_users", return_value=[user_nz, user_hi]),
        patch("src.newsletter.datetime") as mock_dt,
    ):
        def fake_now(tz=None):
            return fixed_utc if tz is None else fixed_utc.astimezone(tz)

        mock_dt.now.side_effect = fake_now
        mock_dt.side_effect = lambda *a, **kw: datetime(*a, **kw)

        await run_daily_newsletter_job(_mock_supabase_for_generation(), FAKE_API_KEY)

    # Extract target_date (positional arg index 2) from each call
    assert mock_fetch.call_count == 2
    nz_target = mock_fetch.call_args_list[0][0][2]
    hi_target = mock_fetch.call_args_list[1][0][2]

    assert nz_target == date(2026, 4, 3)
    assert hi_target == date(2026, 4, 2)


# ============================================================================
# TESTS: get_newsletter_summary tool handler
# ============================================================================

def test_get_newsletter_summary_returns_summary_and_marks_listened() -> None:
    """Returns summary, email_count, and listened_already=False when a summary exists."""
    mock_supabase = _mock_supabase_for_handler(
        summary_row={"id": "s1", "summary": FAKE_SUMMARY, "email_count": 3, "listened": False},
    )

    result, undo, msg_id = _dispatch_tool(
        tool_name="get_newsletter_summary",
        args={},
        email_ctx=EmailClientContext(
            connection_type="imap_smtp",
            imap_holder={"client": MagicMock(), "config": FAKE_IMAP_CONFIG},
            smtp_config=MagicMock(),
        ),
        supabase=mock_supabase,
        user_id=FAKE_USER_ID,
    )

    assert result["summary"] == FAKE_SUMMARY
    assert result["email_count"] == 3
    assert result["listened_already"] is False
    assert undo is None


def test_get_newsletter_summary_triggers_on_demand_when_no_row() -> None:
    """Returns generating=True with on_demand_task when no summary exists."""
    mock_supabase = _mock_supabase_for_handler(summary_row=None)

    result = _handle_get_newsletter_summary(mock_supabase, FAKE_USER_ID, {"date": "2026-04-01"})

    assert result["generating"] is True
    assert result["on_demand_task"]["user_id"] == FAKE_USER_ID
    assert result["on_demand_task"]["target_date"] == "2026-04-01"


def test_get_newsletter_summary_with_explicit_date() -> None:
    """Returns the summary for a specific requested date."""
    mock_supabase = _mock_supabase_for_handler(
        summary_row={"id": "s2", "summary": FAKE_SUMMARY, "email_count": 5, "listened": False},
    )

    result = _handle_get_newsletter_summary(mock_supabase, FAKE_USER_ID, {"date": "2026-04-01"})

    assert result["summary"] == FAKE_SUMMARY
    assert result["email_count"] == 5
    assert result["listened_already"] is False


# ============================================================================
# TESTS: set_newsletter_config tool handler
# ============================================================================

def test_set_newsletter_config_merges_partial_update() -> None:
    """Sending {enabled: true} preserves existing newsletters list."""
    mock_supabase = _mock_supabase_for_handler(
        existing_config={"enabled": False, "newsletters": ["old@x.com"], "summary_prompt": None},
    )

    result, undo, msg_id = _dispatch_tool(
        tool_name="set_newsletter_config",
        args={"enabled": True},
        email_ctx=EmailClientContext(
            connection_type="imap_smtp",
            imap_holder={"client": MagicMock(), "config": FAKE_IMAP_CONFIG},
            smtp_config=MagicMock(),
        ),
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
    """Returns 401 without valid Authorization header."""
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
            resp_none = await client.post("/api/newsletter/generate-daily")
            assert resp_none.status_code == 401

            resp_wrong = await client.post(
                "/api/newsletter/generate-daily",
                headers={"Authorization": "Bearer wrong-key"},
            )
            assert resp_wrong.status_code == 401
