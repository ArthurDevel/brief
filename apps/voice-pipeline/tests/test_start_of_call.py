"""
Tests for start-of-call logic: system prompt email context and last session lookup.

Covers the email context injection into the system prompt, the Supabase query
for the most recent session end time, and IMAP-based email counting functions.

- build_system_prompt: email_context inclusion/exclusion
- get_last_session_end_time: Supabase query with/without prior sessions
- count_emails_since: IMAP SINCE search against Hoodiecrow
- count_unread_emails: IMAP UNSEEN search against Hoodiecrow
"""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any
from unittest.mock import MagicMock

from imapclient import IMAPClient

from src.prompt import build_system_prompt
from src.session import get_last_session_end_time, _derive_email_provider
from src.tools.email_client import count_emails_since, count_unread_emails


# ============================================================================
# HELPERS
# ============================================================================

class FakeResponse:
    """Mimics a Supabase execute() response with a .data attribute."""

    def __init__(self, data: list[dict[str, Any]]):
        self.data = data


# ============================================================================
# UNIT TESTS -- _derive_email_provider
# ============================================================================

class TestDeriveEmailProvider:
    """Tests that _derive_email_provider maps IMAP hosts to provider types."""

    def test_gmail_host(self) -> None:
        """Returns 'gmail' for imap.gmail.com."""
        assert _derive_email_provider("imap.gmail.com") == "gmail"

    def test_outlook_host(self) -> None:
        """Returns 'outlook' for outlook.office365.com."""
        assert _derive_email_provider("outlook.office365.com") == "outlook"

    def test_custom_host(self) -> None:
        """Returns 'custom' for any other IMAP host."""
        assert _derive_email_provider("mail.example.com") == "custom"


# ============================================================================
# UNIT TESTS -- build_system_prompt email context
# ============================================================================

class TestBuildSystemPromptEmailContext:
    """Tests that build_system_prompt correctly includes or omits email context."""

    def test_includes_email_context_when_provided(self) -> None:
        """The returned prompt contains the email context string when provided."""
        result: str = build_system_prompt(
            memory_entries=[],
            tool_approval_config={},
            email_context="You have 5 new emails since the last call.",
        )

        assert "5 new emails" in result

    def test_omits_email_section_when_none(self) -> None:
        """The returned prompt has no email references when email_context is None."""
        result: str = build_system_prompt(
            memory_entries=[],
            tool_approval_config={},
            email_context=None,
        )

        assert "new emails" not in result
        assert "unread" not in result


# ============================================================================
# UNIT TESTS -- build_system_prompt Gmail provider hint
# ============================================================================

class TestBuildSystemPromptGmailHint:
    """Tests that build_system_prompt includes/excludes the Gmail label hint."""

    def test_includes_gmail_hint_when_gmail(self) -> None:
        """The returned prompt contains the Gmail label hint when provider is 'gmail'."""
        result: str = build_system_prompt(
            memory_entries=[],
            tool_approval_config={},
            email_provider="gmail",
        )

        assert "Gmail label" in result
        assert "All Mail" in result

    def test_omits_gmail_hint_when_outlook(self) -> None:
        """The returned prompt does not contain the Gmail hint when provider is 'outlook'."""
        result: str = build_system_prompt(
            memory_entries=[],
            tool_approval_config={},
            email_provider="outlook",
        )

        assert "Gmail label" not in result

    def test_omits_gmail_hint_when_none(self) -> None:
        """The returned prompt does not contain the Gmail hint when provider is None."""
        result: str = build_system_prompt(
            memory_entries=[],
            tool_approval_config={},
            email_provider=None,
        )

        assert "Gmail label" not in result


# ============================================================================
# UNIT TESTS -- get_last_session_end_time
# ============================================================================

class TestGetLastSessionEndTime:
    """Tests for get_last_session_end_time with mocked Supabase queries."""

    def test_returns_none_when_no_sessions(self) -> None:
        """Returns None when there are no completed sessions for the user."""
        mock_supabase: MagicMock = MagicMock()
        mock_supabase.table.return_value \
            .select.return_value \
            .eq.return_value \
            .not_.is_.return_value \
            .order.return_value \
            .limit.return_value \
            .execute.return_value = FakeResponse(data=[])

        result = get_last_session_end_time("user-1", mock_supabase)

        assert result is None

    def test_returns_datetime_when_session_exists(self) -> None:
        """Returns a datetime matching the ended_at value from the database."""
        mock_supabase: MagicMock = MagicMock()
        mock_supabase.table.return_value \
            .select.return_value \
            .eq.return_value \
            .not_.is_.return_value \
            .order.return_value \
            .limit.return_value \
            .execute.return_value = FakeResponse(
                data=[{"ended_at": "2026-03-20T15:30:00+00:00"}]
            )

        result = get_last_session_end_time("user-1", mock_supabase)

        expected: datetime = datetime(2026, 3, 20, 15, 30, 0, tzinfo=timezone.utc)
        assert isinstance(result, datetime)
        assert result == expected


# ============================================================================
# INTEGRATION TESTS -- count_emails_since
# ============================================================================

class TestCountEmailsSince:
    """Tests for count_emails_since against the Hoodiecrow IMAP server."""

    def test_count_emails_since_returns_correct_count(self, imap_client: IMAPClient) -> None:
        """Counts all 10 seed emails when SINCE date is before them, 0 when after."""
        # All seed emails are dated March 10-13, 2026
        count_before: int = count_emails_since(imap_client, date(2026, 3, 1))
        assert count_before == 10

        count_after: int = count_emails_since(imap_client, date(2026, 3, 20))
        assert count_after == 0


# ============================================================================
# INTEGRATION TESTS -- count_unread_emails
# ============================================================================

class TestCountUnreadEmails:
    """Tests for count_unread_emails against the Hoodiecrow IMAP server."""

    def test_count_unread_emails_returns_all_unseen(self, imap_client: IMAPClient) -> None:
        """All seed emails start as unread, so count should be 10."""
        count: int = count_unread_emails(imap_client)
        assert count == 10
