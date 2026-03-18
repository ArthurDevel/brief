"""
Unit tests for markdown formatting functions.

Verifies that format_email_summaries, format_email, and format_thread
produce markdown with the expected structure (headers, metadata fields,
separators, snippets). Does not assert exact strings -- just structure.
"""

from __future__ import annotations

from src.tools.email_client import Email, EmailSummary, ThreadMessage
from src.tools.markdown_formatter import (
    format_email,
    format_email_summaries,
    format_thread,
)


# ============================================================================
# TEST DATA
# ============================================================================

SUMMARY_A = EmailSummary(
    id="101",
    from_addr="Alice <alice@example.com>",
    subject="Weekly standup notes",
    snippet="Here are the notes from today's standup meeting.",
    date="2026-03-10T09:00:00Z",
)

SUMMARY_B = EmailSummary(
    id="102",
    from_addr="Bob <bob@example.com>",
    subject="Invoice #1234",
    snippet="Please find attached the invoice for March.",
    date="2026-03-11T14:30:00Z",
)

FULL_EMAIL = Email(
    id="101",
    from_addr="Alice <alice@example.com>",
    to="you@example.com",
    subject="Weekly standup notes",
    body="Here are the notes from today's standup meeting.\n\nWe discussed backend migration.",
    date="2026-03-10T09:00:00Z",
    is_read=False,
)

THREAD_MSG_1 = ThreadMessage(
    id="201",
    from_addr="Alice <alice@example.com>",
    to="you@example.com",
    subject="Project kickoff",
    body="Let's get started on the project.",
    date="2026-03-13T10:00:00Z",
)

THREAD_MSG_2 = ThreadMessage(
    id="202",
    from_addr="you@example.com",
    to="Alice <alice@example.com>",
    subject="Re: Project kickoff",
    body="I can start next Monday.",
    date="2026-03-13T11:30:00Z",
)


# ============================================================================
# TESTS: format_email_summaries
# ============================================================================

class TestFormatEmailSummaries:
    def test_includes_title_and_count(self):
        result = format_email_summaries([SUMMARY_A, SUMMARY_B], "Inbox")
        assert "## Inbox (2 emails)" in result

    def test_includes_id_sender_and_date(self):
        result = format_email_summaries([SUMMARY_A], "Inbox")
        assert "[id:101]" in result
        assert "Alice <alice@example.com>" in result
        assert "2026-03-10T09:00:00Z" in result

    def test_includes_subject_and_snippet(self):
        result = format_email_summaries([SUMMARY_A], "Inbox")
        assert "Weekly standup notes" in result
        assert "> Here are the notes" in result

    def test_handles_empty_list(self):
        result = format_email_summaries([], "Search Results")
        assert "## Search Results (0 emails)" in result

    def test_formats_multiple_emails(self):
        result = format_email_summaries([SUMMARY_A, SUMMARY_B], "Inbox")
        assert "[id:101]" in result
        assert "[id:102]" in result
        assert "Invoice #1234" in result


# ============================================================================
# TESTS: format_email
# ============================================================================

class TestFormatEmail:
    def test_uses_subject_as_h1(self):
        result = format_email(FULL_EMAIL)
        assert "# Weekly standup notes" in result

    def test_includes_all_metadata_fields(self):
        result = format_email(FULL_EMAIL)
        assert "**ID:** 101" in result
        assert "**From:** Alice <alice@example.com>" in result
        assert "**To:** you@example.com" in result
        assert "**Date:** 2026-03-10T09:00:00Z" in result

    def test_shows_unread_status(self):
        result = format_email(FULL_EMAIL)
        assert "**Status:** Unread" in result

    def test_shows_read_status(self):
        read_email = Email(
            id="101",
            from_addr="Alice <alice@example.com>",
            to="you@example.com",
            subject="Weekly standup notes",
            body="body text",
            date="2026-03-10T09:00:00Z",
            is_read=True,
        )
        result = format_email(read_email)
        assert "**Status:** Read" in result

    def test_includes_hr_separator(self):
        result = format_email(FULL_EMAIL)
        assert "---" in result

    def test_includes_full_body(self):
        result = format_email(FULL_EMAIL)
        assert "Here are the notes from today's standup meeting." in result
        assert "We discussed backend migration." in result


# ============================================================================
# TESTS: format_thread
# ============================================================================

class TestFormatThread:
    def test_includes_subject_and_count_in_heading(self):
        result = format_thread([THREAD_MSG_1, THREAD_MSG_2])
        assert "# Thread: Project kickoff (2 messages)" in result

    def test_includes_message_metadata(self):
        result = format_thread([THREAD_MSG_1])
        assert "**From:** Alice <alice@example.com>" in result
        assert "**To:** you@example.com" in result
        assert "**Date:** 2026-03-13T10:00:00Z" in result
        assert "**ID:** 201" in result

    def test_uses_hr_separators(self):
        result = format_thread([THREAD_MSG_1, THREAD_MSG_2])
        # Count lines that are exactly "---"
        separator_lines = [line for line in result.split("\n") if line.strip() == "---"]
        assert len(separator_lines) >= 3

    def test_includes_body_for_each_message(self):
        result = format_thread([THREAD_MSG_1, THREAD_MSG_2])
        assert "Let's get started on the project." in result
        assert "I can start next Monday." in result

    def test_handles_empty_thread(self):
        result = format_thread([])
        assert "0 messages" in result
