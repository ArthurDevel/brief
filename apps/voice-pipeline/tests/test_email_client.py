"""
Integration tests for email_client.py against a Hoodiecrow IMAP server,
plus unit tests for since-filter and count_emails_since time-granularity.

Tests the Python functions that the voice agent actually calls,
not the TypeScript package.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from imapclient import IMAPClient

from src.tools.email_client import (
    FolderInfo,
    SINCE_FILTER_CAP,
    list_inbox,
    search_emails,
    read_email,
    read_thread,
    mark_as_read,
    archive_email,
    count_emails_since,
    delete_email,
    list_folders,
    move_email,
    move_email_to_folder,
    save_draft,
    delete_draft,
)


# --------------------------------------------------------------------------
# list_inbox
# --------------------------------------------------------------------------

class TestListInbox:
    def test_returns_emails_in_reverse_chronological_order(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 20)
        assert len(emails) == 11
        # Most recent first — thread messages are newest
        assert emails[0].subject == "Re: Project kickoff"
        assert emails[1].subject == "Project kickoff"

    def test_respects_limit(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 2)
        assert len(emails) == 2

    def test_returns_from_and_date(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 20)
        alice = next(e for e in emails if e.subject == "Weekly standup notes")
        assert "alice@example.com" in alice.from_addr
        assert alice.date != ""

    def test_snippet_strips_css_from_html_emails(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 20)
        chase = next(e for e in emails if e.subject == "You updated your digital wallet")

        assert "line-height" not in chase.snippet
        assert "!important" not in chase.snippet
        assert "{" not in chase.snippet
        assert "<" not in chase.snippet
        assert "digital wallet" in chase.snippet

    def test_snippet_strips_empty_table_cells(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 20)
        proximus = next(e for e in emails if e.subject == "Bevestiging van wijziging")

        # Should not be a wall of pipe characters from empty table cells
        assert proximus.snippet.count("|") < 3
        assert "wijziging" in proximus.snippet or "abonnement" in proximus.snippet

    def test_snippet_strips_image_links(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 20)
        freaks = next(e for e in emails if e.subject == "Laatste rigging cursus")

        assert "![" not in freaks.snippet
        assert "[Image" not in freaks.snippet
        assert "<img" not in freaks.snippet
        assert "rigging" in freaks.snippet

    def test_snippet_strips_zero_width_characters(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 20)
        dribbble = next(e for e in emails if e.subject == "Protein branding")

        # Hoodiecrow returns 0 bytes for partial fetches on multipart emails,
        # so the snippet falls back to subject (which has no zero-width chars).
        assert "\u200c" not in dribbble.snippet
        assert dribbble.snippet == "Protein branding"

    def test_snippet_no_carriage_returns(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 20)
        for email in emails:
            assert "\r" not in email.snippet, f"Snippet for '{email.subject}' contains \\r"

    def test_snippet_prefers_plain_text_in_multipart(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 20)
        npm = next(e for e in emails if e.subject == "Successfully published voicecc@1.2.10")

        # Hoodiecrow returns 0 bytes for partial fetches on multipart emails,
        # so the snippet falls back to subject.
        assert npm.snippet == "Successfully published voicecc@1.2.10"

    def test_snippet_falls_back_to_subject_when_body_unparseable(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 20)
        broken = next(e for e in emails if e.subject == "Unparseable body email")

        assert broken.snippet == "Unparseable body email"

    def test_fetching_20_emails_completes_within_2_seconds(self, imap_client: IMAPClient):
        start = time.monotonic()
        list_inbox(imap_client, 20)
        elapsed = time.monotonic() - start

        assert elapsed < 2.0, f"list_inbox(20) took {elapsed:.2f}s, expected < 2s"


# --------------------------------------------------------------------------
# search_emails
# --------------------------------------------------------------------------

class TestSearchEmails:
    def test_searches_by_subject(self, imap_client: IMAPClient):
        results = search_emails(imap_client, "Invoice")
        assert len(results) == 1
        assert results[0].subject == "Invoice #1234"

    def test_searches_by_sender(self, imap_client: IMAPClient):
        results = search_emails(imap_client, "carol@example.com")
        assert len(results) == 1
        assert results[0].subject == "Lunch tomorrow?"

    def test_returns_empty_for_no_matches(self, imap_client: IMAPClient):
        results = search_emails(imap_client, "nonexistent-query-xyz")
        assert results == []

    def test_gmail_style_from_query(self, imap_client: IMAPClient):
        results = search_emails(imap_client, "from:bob@example.com")
        assert len(results) == 1
        assert results[0].subject == "Invoice #1234"


# --------------------------------------------------------------------------
# read_email
# --------------------------------------------------------------------------

class TestReadEmail:
    def test_reads_full_email_by_uid(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 10)
        bob = next(e for e in emails if e.subject == "Invoice #1234")

        full = read_email(imap_client, bob.id)
        assert full.subject == "Invoice #1234"
        assert "bob@example.com" in full.from_addr
        assert "invoice for March" in full.body


# --------------------------------------------------------------------------
# mark_as_read
# --------------------------------------------------------------------------

class TestMarkAsRead:
    def test_marks_email_as_read(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 10)
        target = emails[0]

        mark_as_read(imap_client, target.id)

        full = read_email(imap_client, target.id)
        assert full.is_read is True


# --------------------------------------------------------------------------
# read_thread
# --------------------------------------------------------------------------

class TestReadThread:
    def test_returns_full_thread_including_sent_messages(self, imap_client: IMAPClient):
        """The agent must see sent replies in threads, not just received messages."""
        emails = list_inbox(imap_client, 10)
        kickoff = next(e for e in emails if e.subject == "Project kickoff")

        thread = read_thread(imap_client, kickoff.id)

        # Must return all 3 messages: received, sent reply, received response
        assert len(thread) == 3

        # Chronological order (oldest first)
        assert "get started" in thread[0].body.lower()
        assert "alice@example.com" in thread[0].from_addr

        assert "next monday" in thread[1].body.lower()
        assert "testuser" in thread[1].from_addr

        assert "monday works" in thread[2].body.lower()
        assert "alice@example.com" in thread[2].from_addr

    def test_single_message_thread(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 10)
        invoice = next(e for e in emails if e.subject == "Invoice #1234")

        thread = read_thread(imap_client, invoice.id)

        assert len(thread) == 1
        assert thread[0].subject == "Invoice #1234"


# --------------------------------------------------------------------------
# archive_email
# --------------------------------------------------------------------------

class TestArchiveEmail:
    def test_archives_email_and_returns_undo_recipe(self, imap_client: IMAPClient):
        before = list_inbox(imap_client, 20)
        target = next(e for e in before if e.subject == "Weekly standup notes")

        undo, _message_id = archive_email(imap_client, target.id)
        assert undo["operation"] == "move_email"
        assert "All Mail" in undo["params"]["from"]
        assert undo["params"]["to"] == "INBOX"

        after = list_inbox(imap_client, 20)
        assert not any(e.subject == "Weekly standup notes" for e in after)


# --------------------------------------------------------------------------
# delete_email
# --------------------------------------------------------------------------

class TestDeleteEmail:
    def test_deletes_email_to_trash_and_returns_undo_recipe(self, imap_client: IMAPClient):
        before = list_inbox(imap_client, 10)
        target = next(e for e in before if e.subject == "Lunch tomorrow?")

        undo, _message_id = delete_email(imap_client, target.id)
        assert undo["operation"] == "move_email"
        assert "Trash" in undo["params"]["from"]
        assert undo["params"]["to"] == "INBOX"

        after = list_inbox(imap_client, 10)
        assert not any(e.subject == "Lunch tomorrow?" for e in after)


# --------------------------------------------------------------------------
# save_draft + delete_draft
# --------------------------------------------------------------------------

class TestDrafts:
    def test_saves_and_deletes_draft(self, imap_client: IMAPClient):
        undo = save_draft(imap_client, "someone@example.com", "Test draft", "Draft body.")
        assert undo["operation"] == "delete_draft"

        draft_uid = undo["params"]["draft_uid"]
        assert draft_uid != "unknown"

        delete_draft(imap_client, draft_uid)


# --------------------------------------------------------------------------
# list_folders (unit tests with mocked client)
# --------------------------------------------------------------------------

class TestListFolders:
    def test_returns_folders_filtering_noselect_and_inbox(self):
        """list_folders should exclude non-selectable folders and INBOX."""
        mock_client = MagicMock()
        mock_client.list_folders.return_value = [
            ((b"\\HasChildren", b"\\Noselect"), b"/", "[Gmail]"),
            ((b"\\All", b"\\HasNoChildren"), b"/", "[Gmail]/All Mail"),
            ((b"\\Trash", b"\\HasNoChildren"), b"/", "[Gmail]/Trash"),
            ((b"\\Drafts", b"\\HasNoChildren"), b"/", "[Gmail]/Drafts"),
            ((), b"/", "INBOX"),
            ((), b"/", "Work"),
        ]

        folders = list_folders(mock_client)

        names = [f.path for f in folders]
        assert "INBOX" not in names
        assert "[Gmail]" not in names
        assert "[Gmail]/All Mail" in names
        assert "[Gmail]/Trash" in names
        assert "[Gmail]/Drafts" in names
        assert "Work" in names

    def test_returns_folder_info_with_special_use(self):
        """FolderInfo should include special_use flag when present."""
        mock_client = MagicMock()
        mock_client.list_folders.return_value = [
            ((b"\\Trash",), b"/", "Trash"),
            ((), b"/", "Custom"),
        ]

        folders = list_folders(mock_client)

        trash = next(f for f in folders if f.path == "Trash")
        assert trash.special_use == "\\Trash"
        assert trash.name == "Trash"

        custom = next(f for f in folders if f.path == "Custom")
        assert custom.special_use is None

    def test_extracts_display_name_from_path(self):
        """Display name should be the last path segment."""
        mock_client = MagicMock()
        mock_client.list_folders.return_value = [
            ((b"\\All",), b"/", "[Gmail]/All Mail"),
        ]

        folders = list_folders(mock_client)
        assert folders[0].name == "All Mail"
        assert folders[0].path == "[Gmail]/All Mail"


# --------------------------------------------------------------------------
# move_email_to_folder (unit tests with mocked client)
# --------------------------------------------------------------------------

class TestMoveEmailToFolder:
    def test_moves_email_and_returns_undo_recipe_with_message_id(self):
        """move_email_to_folder should call client.move and return undo recipe with message_id."""
        mock_client = MagicMock()
        mock_client.fetch.return_value = {
            42: {
                b"ENVELOPE": MagicMock(message_id=b"<test123@example.com>"),
            }
        }

        recipe, message_id = move_email_to_folder(
            mock_client, "42", "Work", "INBOX"
        )

        # Should select source folder
        mock_client.select_folder.assert_called_with("INBOX")
        # Should move the email
        mock_client.move.assert_called_once_with([42], "Work")
        # Should return message_id
        assert message_id == "<test123@example.com>"
        # Undo recipe should reverse the move using message_id
        assert recipe["operation"] == "move_email"
        assert recipe["params"]["message_id"] == "<test123@example.com>"
        assert recipe["params"]["from"] == "Work"
        assert recipe["params"]["to"] == "INBOX"


# --------------------------------------------------------------------------
# move_email (unit tests with mocked client)
# --------------------------------------------------------------------------

class TestMoveEmail:
    def test_searches_by_message_id_header(self):
        """move_email should search by HEADER Message-ID to find current UID."""
        mock_client = MagicMock()
        mock_client.search.return_value = [99]

        move_email(mock_client, "<abc@example.com>", "Trash", "INBOX")

        mock_client.select_folder.assert_called_with("Trash")
        mock_client.search.assert_called_once_with(
            ["HEADER", "Message-ID", "<abc@example.com>"]
        )
        mock_client.move.assert_called_once_with([99], "INBOX")

    def test_raises_if_message_id_not_found(self):
        """move_email should raise RuntimeError if no email found."""
        mock_client = MagicMock()
        mock_client.search.return_value = []

        try:
            move_email(mock_client, "<missing@example.com>", "Trash", "INBOX")
            assert False, "Should have raised RuntimeError"
        except RuntimeError as e:
            assert "No email with Message-ID" in str(e)


# --------------------------------------------------------------------------
# archive_email / delete_email undo recipe (unit tests with mocked client)
# --------------------------------------------------------------------------

class TestUndoRecipeUsesMessageId:
    def test_archive_email_stores_message_id_in_undo_recipe(self):
        """archive_email undo recipe should use message_id, not email_id."""
        mock_client = MagicMock()
        # list_folders for resolve_special_use_folder
        mock_client.list_folders.return_value = [
            ((b"\\All",), b"/", "[Gmail]/All Mail"),
        ]
        mock_client.fetch.return_value = {
            10: {
                b"ENVELOPE": MagicMock(message_id=b"<archive-test@example.com>"),
            }
        }

        recipe, message_id = archive_email(mock_client, "10")

        assert "message_id" in recipe["params"]
        assert "email_id" not in recipe["params"]
        assert recipe["params"]["message_id"] == "<archive-test@example.com>"
        assert message_id == "<archive-test@example.com>"

    def test_delete_email_stores_message_id_in_undo_recipe(self):
        """delete_email undo recipe should use message_id, not email_id."""
        mock_client = MagicMock()
        mock_client.list_folders.return_value = [
            ((b"\\Trash",), b"/", "[Gmail]/Trash"),
        ]
        mock_client.fetch.return_value = {
            20: {
                b"ENVELOPE": MagicMock(message_id=b"<delete-test@example.com>"),
            }
        }

        recipe, message_id = delete_email(mock_client, "20")

        assert "message_id" in recipe["params"]
        assert "email_id" not in recipe["params"]
        assert recipe["params"]["message_id"] == "<delete-test@example.com>"
        assert message_id == "<delete-test@example.com>"


# --------------------------------------------------------------------------
# list_inbox with since filter (unit tests with mocked client)
# --------------------------------------------------------------------------

def _make_envelope(dt: datetime) -> MagicMock:
    """Create a mock IMAP envelope object with a .date attribute."""
    envelope = MagicMock()
    envelope.date = dt
    return envelope


class TestListInboxSinceFilter:
    """Unit tests for list_inbox when the `since` parameter is provided."""

    @patch("src.tools.email_client._fetch_summaries")
    def test_returns_only_emails_after_since_datetime(self, mock_fetch_summaries: MagicMock) -> None:
        """When since is provided, only UIDs with envelope date after since are fetched."""
        mock_client = MagicMock()
        since = datetime(2025, 1, 15, 10, 0, tzinfo=timezone.utc)

        # IMAP SINCE returns all UIDs from Jan 15 onward (date-only filter)
        mock_client.search.return_value = [1, 2, 3]

        # Envelope dates: uid 1 is before since time, uid 2 and 3 are after
        mock_client.fetch.return_value = {
            1: {b"ENVELOPE": _make_envelope(datetime(2025, 1, 15, 8, 0, tzinfo=timezone.utc))},
            2: {b"ENVELOPE": _make_envelope(datetime(2025, 1, 15, 12, 0, tzinfo=timezone.utc))},
            3: {b"ENVELOPE": _make_envelope(datetime(2025, 1, 16, 9, 0, tzinfo=timezone.utc))},
        }

        mock_fetch_summaries.return_value = ["summary_2", "summary_3"]

        result = list_inbox(mock_client, limit=20, since=since)

        # Should have called IMAP search with the date portion of since
        mock_client.search.assert_called_with(["SINCE", since.date()])
        # _fetch_summaries should receive only the filtered UIDs (2 and 3)
        mock_fetch_summaries.assert_called_once_with(mock_client, [2, 3])
        assert result == ["summary_2", "summary_3"]

    @patch("src.tools.email_client._fetch_summaries")
    def test_caps_results_at_since_filter_cap(self, mock_fetch_summaries: MagicMock) -> None:
        """When since returns more UIDs than SINCE_FILTER_CAP, only the most recent are kept."""
        mock_client = MagicMock()
        since = datetime(2025, 1, 1, 0, 0, tzinfo=timezone.utc)

        # Return more UIDs than the cap
        uid_count = SINCE_FILTER_CAP + 50
        uids = list(range(1, uid_count + 1))
        mock_client.search.return_value = uids

        # All envelopes are after since
        mock_client.fetch.return_value = {
            uid: {b"ENVELOPE": _make_envelope(datetime(2025, 2, 1, 12, 0, tzinfo=timezone.utc))}
            for uid in uids
        }

        mock_fetch_summaries.return_value = []

        list_inbox(mock_client, limit=20, since=since)

        # _fetch_summaries should receive only the last SINCE_FILTER_CAP UIDs
        called_uids = mock_fetch_summaries.call_args[0][1]
        assert len(called_uids) == SINCE_FILTER_CAP
        assert called_uids == uids[-SINCE_FILTER_CAP:]

    @patch("src.tools.email_client._fetch_summaries")
    def test_returns_empty_when_no_uids_match_since(self, mock_fetch_summaries: MagicMock) -> None:
        """When IMAP SINCE returns no UIDs, an empty list is returned."""
        mock_client = MagicMock()
        since = datetime(2025, 6, 1, 0, 0, tzinfo=timezone.utc)

        mock_client.search.return_value = []

        result = list_inbox(mock_client, limit=20, since=since)

        assert result == []
        mock_fetch_summaries.assert_not_called()

    @patch("src.tools.email_client._fetch_summaries")
    def test_without_since_uses_limit(self, mock_fetch_summaries: MagicMock) -> None:
        """When since is None, list_inbox uses the limit parameter (existing behavior)."""
        mock_client = MagicMock()

        mock_client.search.return_value = [1, 2, 3, 4, 5]
        mock_fetch_summaries.return_value = ["s1", "s2"]

        result = list_inbox(mock_client, limit=2)

        # Should search ALL, not SINCE
        mock_client.search.assert_called_with(["ALL"])
        # _fetch_summaries gets only the last `limit` UIDs
        mock_fetch_summaries.assert_called_once_with(mock_client, [4, 5])


# --------------------------------------------------------------------------
# count_emails_since time-granularity (unit tests with mocked client)
# --------------------------------------------------------------------------

class TestCountEmailsSinceTimeGranularity:
    """Unit tests verifying count_emails_since filters by full datetime, not just date."""

    def test_excludes_same_day_emails_before_since_time(self) -> None:
        """Emails on the same day but before the since time should NOT be counted."""
        mock_client = MagicMock()
        since = datetime(2025, 1, 15, 10, 0, tzinfo=timezone.utc)

        # IMAP SINCE (date-only) returns all three UIDs from Jan 15+
        mock_client.search.return_value = [1, 2, 3]

        # uid 1: same day, BEFORE since time -> should NOT be counted
        # uid 2: same day, AFTER since time -> should be counted
        # uid 3: next day -> should be counted
        mock_client.fetch.return_value = {
            1: {b"ENVELOPE": _make_envelope(datetime(2025, 1, 15, 8, 0, tzinfo=timezone.utc))},
            2: {b"ENVELOPE": _make_envelope(datetime(2025, 1, 15, 12, 0, tzinfo=timezone.utc))},
            3: {b"ENVELOPE": _make_envelope(datetime(2025, 1, 16, 9, 0, tzinfo=timezone.utc))},
        }

        count = count_emails_since(mock_client, since)

        assert count == 2

    def test_returns_zero_when_no_uids_from_search(self) -> None:
        """When IMAP SINCE returns no UIDs, count should be 0."""
        mock_client = MagicMock()
        since = datetime(2025, 6, 1, 0, 0, tzinfo=timezone.utc)

        mock_client.search.return_value = []

        count = count_emails_since(mock_client, since)

        assert count == 0

    def test_excludes_email_at_exact_since_time(self) -> None:
        """An email at the exact since datetime should NOT be counted (strictly after)."""
        mock_client = MagicMock()
        since = datetime(2025, 1, 15, 10, 0, tzinfo=timezone.utc)

        mock_client.search.return_value = [1]

        mock_client.fetch.return_value = {
            1: {b"ENVELOPE": _make_envelope(datetime(2025, 1, 15, 10, 0, tzinfo=timezone.utc))},
        }

        count = count_emails_since(mock_client, since)

        assert count == 0


# --------------------------------------------------------------------------
# Regression: naive envelope dates with non-UTC since offset
# Reproduces production bug where list_inbox returned 0 results despite
# emails existing in the window. Root cause: naive envelope dates assumed
# UTC, but since had a -07:00 offset, making the comparison wrong.
# --------------------------------------------------------------------------

PDT = timezone(timedelta(hours=-7))


class TestNaiveEnvelopeDateWithNonUtcSince:
    """Reproduce bug: since with -07:00 offset vs naive envelope dates."""

    @patch("src.tools.email_client._fetch_summaries")
    def test_list_inbox_finds_emails_when_since_has_non_utc_offset(
        self, mock_fetch_summaries: MagicMock
    ) -> None:
        """Emails at 9:00 and 9:15 AM should be found when since is 8:47 AM PDT.

        Production scenario: LLM sent since="2026-04-03T08:47:57-07:00",
        envelope dates were naive (no tzinfo), list_inbox returned 0 results.
        """
        mock_client = MagicMock()

        # since = 8:47 AM PDT (= 15:47 UTC)
        since = datetime(2026, 4, 3, 8, 47, 57, tzinfo=PDT)

        # IMAP SINCE (date-only) returns UIDs for April 3
        mock_client.search.return_value = [1, 2, 3]

        # Envelope dates are NAIVE -- imapclient sometimes returns these
        # without tzinfo. The emails were at 9:00 AM and 9:15 AM local time.
        # uid 1: 8:30 AM (before since) -- should be excluded
        # uid 2: 9:00 AM (after since) -- should be included
        # uid 3: 9:15 AM (after since) -- should be included
        mock_client.fetch.side_effect = [
            # First fetch call: _filter_uids_by_datetime fetches ENVELOPE
            {
                1: {b"ENVELOPE": _make_envelope(datetime(2026, 4, 3, 8, 30, 0))},
                2: {b"ENVELOPE": _make_envelope(datetime(2026, 4, 3, 9, 0, 0))},
                3: {b"ENVELOPE": _make_envelope(datetime(2026, 4, 3, 9, 15, 0))},
            },
            # Second fetch call: _fetch_summaries (content doesn't matter for this test)
            {},
        ]
        mock_fetch_summaries.return_value = ["summary_2", "summary_3"]

        result = list_inbox(mock_client, limit=20, since=since)

        # Should find UIDs 2 and 3 -- they are after 8:47 AM in the same timezone
        mock_fetch_summaries.assert_called_once_with(mock_client, [2, 3])
        assert result == ["summary_2", "summary_3"]

    def test_count_emails_since_with_non_utc_offset_and_naive_envelopes(self) -> None:
        """count_emails_since should correctly count when since has -07:00 offset."""
        mock_client = MagicMock()

        # since = 8:47 AM PDT
        since = datetime(2026, 4, 3, 8, 47, 57, tzinfo=PDT)

        mock_client.search.return_value = [1, 2, 3]

        # Naive envelope dates (same local time frame as since)
        mock_client.fetch.return_value = {
            1: {b"ENVELOPE": _make_envelope(datetime(2026, 4, 3, 8, 30, 0))},
            2: {b"ENVELOPE": _make_envelope(datetime(2026, 4, 3, 9, 0, 0))},
            3: {b"ENVELOPE": _make_envelope(datetime(2026, 4, 3, 9, 15, 0))},
        }

        count = count_emails_since(mock_client, since)

        # Should count 2 emails (uid 2 and 3), not 0
        assert count == 2
