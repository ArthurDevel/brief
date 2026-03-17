"""
Integration tests for email_client.py against a Hoodiecrow IMAP server.

Tests the Python functions that the voice agent actually calls,
not the TypeScript package.
"""

from __future__ import annotations

from imapclient import IMAPClient

from src.tools.email_client import (
    list_inbox,
    search_emails,
    read_email,
    read_thread,
    mark_as_read,
    archive_email,
    delete_email,
    save_draft,
    delete_draft,
)


# --------------------------------------------------------------------------
# list_inbox
# --------------------------------------------------------------------------

class TestListInbox:
    def test_returns_emails_in_reverse_chronological_order(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 10)
        assert len(emails) == 5
        # Most recent first — thread messages are newest
        assert emails[0].subject == "Re: Project kickoff"
        assert emails[1].subject == "Project kickoff"

    def test_respects_limit(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 2)
        assert len(emails) == 2

    def test_returns_from_and_date(self, imap_client: IMAPClient):
        emails = list_inbox(imap_client, 10)
        alice = next(e for e in emails if e.subject == "Weekly standup notes")
        assert "alice@example.com" in alice.from_addr
        assert alice.date != ""


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
        before = list_inbox(imap_client, 10)
        target = next(e for e in before if e.subject == "Weekly standup notes")

        undo = archive_email(imap_client, target.id)
        assert undo["operation"] == "move_email"
        assert "All Mail" in undo["params"]["from"]
        assert undo["params"]["to"] == "INBOX"

        after = list_inbox(imap_client, 10)
        assert not any(e.subject == "Weekly standup notes" for e in after)


# --------------------------------------------------------------------------
# delete_email
# --------------------------------------------------------------------------

class TestDeleteEmail:
    def test_deletes_email_to_trash_and_returns_undo_recipe(self, imap_client: IMAPClient):
        before = list_inbox(imap_client, 10)
        target = next(e for e in before if e.subject == "Lunch tomorrow?")

        undo = delete_email(imap_client, target.id)
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
