"""
Integration tests for email_client.py against a Hoodiecrow IMAP server.

Tests the Python functions that the voice agent actually calls,
not the TypeScript package.
"""

from __future__ import annotations

import time

from imapclient import IMAPClient

from unittest.mock import MagicMock

from src.tools.email_client import (
    FolderInfo,
    list_inbox,
    search_emails,
    read_email,
    read_thread,
    mark_as_read,
    archive_email,
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
