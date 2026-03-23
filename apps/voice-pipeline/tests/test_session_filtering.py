"""
Unit tests for session-aware inbox filtering in the tool handler.

Verifies that list_inbox results are filtered based on pending/approved
actions in the current session, and that queued send_email actions appear
as a "Queued Outgoing" section.

- Pending delete/archive actions hide emails from list_inbox results
- Queued send_email actions are appended as "Queued Outgoing"
- Actions from other sessions do not affect the current session's view
- No pending actions returns full results unchanged
- Overfetch: when pending actions exist, IMAP is asked for limit + N emails
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import pytest  # type: ignore[import-untyped]

from src.session import ImapConfig, SmtpConfig
from src.tools.email_client import EmailSummary
from src.tools.handlers import ActionInput, handle_tool_call


# ============================================================================
# CONSTANTS
# ============================================================================

FAKE_IMAP_CONFIG = ImapConfig(host="127.0.0.1", port=993, user="test", password="test")
FAKE_SMTP_CONFIG = SmtpConfig(host="localhost", port=587, user="test", password="test")

SEED_EMAILS = [
    EmailSummary(id="1", from_addr="alice@example.com", subject="Weekly standup notes", snippet="Here are the notes...", date="2026-03-10"),
    EmailSummary(id="2", from_addr="bob@example.com", subject="Invoice #1234", snippet="Please find attached...", date="2026-03-11"),
    EmailSummary(id="3", from_addr="carol@example.com", subject="Lunch plans", snippet="Are you free for lunch...", date="2026-03-12"),
]


# ============================================================================
# HELPERS
# ============================================================================

class FakeSupabaseResponse:
    """Mimics a Supabase execute() response with a .data attribute."""

    def __init__(self, data: list[dict[str, Any]]):
        self.data = data


class FakeQueryBuilder:
    """Chainable fake for supabase.table().select().eq().in_().execute().

    Accumulates filters and applies them on execute().
    """

    def __init__(self, rows: list[dict[str, Any]]):
        self._rows = rows
        self._filters: list[tuple[str, str, Any]] = []

    def select(self, _cols: str) -> "FakeQueryBuilder":
        return self

    def eq(self, col: str, value: Any) -> "FakeQueryBuilder":
        self._filters.append(("eq", col, value))
        return self

    def in_(self, col: str, values: list[Any]) -> "FakeQueryBuilder":
        self._filters.append(("in", col, values))
        return self

    def single(self) -> "FakeQueryBuilder":
        return self

    def execute(self) -> FakeSupabaseResponse:
        """Apply all accumulated filters and return matching rows."""
        result = self._rows
        for filter_type, col, value in self._filters:
            if filter_type == "eq":
                result = [r for r in result if r.get(col) == value]
            elif filter_type == "in":
                result = [r for r in result if r.get(col) in value]
        return FakeSupabaseResponse(result)


class FakeInsertBuilder:
    """Fake for supabase.table().insert().execute()."""

    def __init__(self, rows: list[dict[str, Any]], new_row: dict[str, Any]):
        rows.append({**new_row, "id": f"gen-{len(rows)}"})
        self._inserted = rows[-1]

    def execute(self) -> FakeSupabaseResponse:
        return FakeSupabaseResponse([self._inserted])


def create_fake_supabase(action_rows: list[dict[str, Any]]) -> MagicMock:
    """Create a fake Supabase client backed by the given action rows.

    Supports .table("actions").select().eq().in_().execute() for reads
    and .table("actions").insert().execute() for writes.

    Args:
        action_rows: List of action row dicts to seed.

    Returns:
        A MagicMock that behaves like a Supabase Client for the queries used.
    """
    rows = list(action_rows)

    mock = MagicMock()

    def table(name: str):
        t = MagicMock()
        t.select = lambda cols: FakeQueryBuilder(rows).select(cols)
        t.insert = lambda row: FakeInsertBuilder(rows, row)
        return t

    mock.table = table
    return mock


def _call_list_inbox(
    session_id: str,
    action_rows: list[dict[str, Any]],
    *,
    all_emails: list[EmailSummary] | None = None,
    limit: int = 10,
) -> str:
    """Call handle_tool_call with list_inbox and return the markdown result.

    Mocks email_client.with_reconnect so it executes the operation lambda,
    and mocks email_client.list_inbox to return the N most recent emails
    from the given list (simulating real IMAP behavior where only the last
    N emails are returned).

    Args:
        session_id: The session ID for the tool call.
        action_rows: Action rows to seed in the fake Supabase.
        all_emails: The full inbox to draw from. Defaults to SEED_EMAILS.
        limit: The limit argument passed to list_inbox.

    Returns:
        The markdown string from the result.
    """
    inbox = all_emails if all_emails is not None else list(SEED_EMAILS)
    supabase = create_fake_supabase(action_rows)
    imap_holder = {"client": MagicMock(), "config": FAKE_IMAP_CONFIG}

    with patch("src.tools.handlers.email_client.with_reconnect") as mock_wr, \
         patch("src.tools.email_client.list_inbox") as mock_list_inbox:
        # with_reconnect executes the operation lambda with the IMAP client
        mock_wr.side_effect = lambda holder, config, op: op(holder["client"])
        # list_inbox returns the N most recent emails, like real IMAP
        mock_list_inbox.side_effect = lambda _client, lim: inbox[-lim:]

        result = handle_tool_call(
            input=ActionInput(
                user_id="user-1",
                session_id=session_id,
                tool_name="list_inbox",
                arguments={"limit": limit},
            ),
            user_config={},
            imap_holder=imap_holder,
            smtp_config=FAKE_SMTP_CONFIG,
            supabase=supabase,
        )

    assert result.result is not None, "Expected a result dict from handle_tool_call"
    return result.result["markdown"]


# ============================================================================
# TESTS
# ============================================================================

class TestSessionAwareInboxFiltering:
    """Tests for session-aware filtering of list_inbox results."""

    def test_excludes_pending_delete_and_archive(self):
        """list_inbox excludes emails with pending delete_email or archive_email actions."""
        action_rows = [
            {
                "session_id": "session-1",
                "tool_name": "delete_email",
                "arguments": {"email_id": "1"},
                "status": "pending",
            },
            {
                "session_id": "session-1",
                "tool_name": "archive_email",
                "arguments": {"email_id": "2"},
                "status": "pending",
            },
        ]

        markdown = _call_list_inbox("session-1", action_rows)

        assert "Weekly standup notes" not in markdown
        assert "Invoice #1234" not in markdown
        assert "Lunch plans" in markdown

    def test_appends_queued_send_email(self):
        """list_inbox appends queued send_email actions as a Queued Outgoing section."""
        action_rows = [
            {
                "session_id": "session-1",
                "tool_name": "send_email",
                "arguments": {"to": "dave@example.com", "subject": "Follow-up", "body": "Hi Dave"},
                "status": "pending",
            },
        ]

        markdown = _call_list_inbox("session-1", action_rows)

        assert "Queued Outgoing" in markdown
        assert "dave@example.com" in markdown
        assert "Follow-up" in markdown

    def test_does_not_filter_different_session(self):
        """list_inbox does NOT filter emails from a different session."""
        action_rows = [
            {
                "session_id": "session-OTHER",
                "tool_name": "delete_email",
                "arguments": {"email_id": "1"},
                "status": "pending",
            },
        ]

        markdown = _call_list_inbox("session-1", action_rows)

        assert "Weekly standup notes" in markdown
        assert "Invoice #1234" in markdown
        assert "Lunch plans" in markdown

    def test_no_pending_actions_returns_full_results(self):
        """list_inbox with no pending actions returns full results unchanged."""
        markdown = _call_list_inbox("session-1", [])

        assert "Weekly standup notes" in markdown
        assert "Invoice #1234" in markdown
        assert "Lunch plans" in markdown
        assert "Queued Outgoing" not in markdown

    def test_overfetch_backfills_when_all_recent_emails_are_pending(self):
        """list_inbox with limit=3 where all 3 newest have pending deletes returns the 3 older emails.

        This test would FAIL without overfetch: list_inbox(limit=3) would return
        only the 3 newest emails, all pending, resulting in 0 after filtering.
        With overfetch: list_inbox(limit=6) returns all 6, filters 3, returns 3.
        """
        # 6 emails ordered oldest to newest (IMAP returns last N)
        all_emails = [
            EmailSummary(id="1", from_addr="alice@example.com", subject="Older email 1", snippet="...", date="2026-03-10"),
            EmailSummary(id="2", from_addr="bob@example.com", subject="Older email 2", snippet="...", date="2026-03-11"),
            EmailSummary(id="3", from_addr="carol@example.com", subject="Older email 3", snippet="...", date="2026-03-12"),
            EmailSummary(id="4", from_addr="dave@example.com", subject="Newest email 4", snippet="...", date="2026-03-13"),
            EmailSummary(id="5", from_addr="eve@example.com", subject="Newest email 5", snippet="...", date="2026-03-14"),
            EmailSummary(id="6", from_addr="frank@example.com", subject="Newest email 6", snippet="...", date="2026-03-15"),
        ]

        # Pending deletes for the 3 newest
        action_rows = [
            {"session_id": "session-1", "tool_name": "delete_email", "arguments": {"email_id": "4"}, "status": "pending"},
            {"session_id": "session-1", "tool_name": "delete_email", "arguments": {"email_id": "5"}, "status": "pending"},
            {"session_id": "session-1", "tool_name": "delete_email", "arguments": {"email_id": "6"}, "status": "pending"},
        ]

        markdown = _call_list_inbox(
            "session-1",
            action_rows,
            all_emails=all_emails,
            limit=3,
        )

        # The 3 older emails should be present
        assert "Older email 1" in markdown
        assert "Older email 2" in markdown
        assert "Older email 3" in markdown

        # The 3 newest (pending) should be filtered out
        assert "Newest email 4" not in markdown
        assert "Newest email 5" not in markdown
        assert "Newest email 6" not in markdown
