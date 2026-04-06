"""
Tests for contact_sync.py: IMAP contact extraction and sync logic.

- [integration] extract_contacts_from_imap with Hoodiecrow fixture
- [unit] _parse_envelope_address parsing
- [unit] full_sync cooldown behavior
"""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from imapclient import IMAPClient

from src.tools.contact_sync import (
    ContactRecord,
    SYNC_COOLDOWN_SECONDS,
    extract_contacts_from_imap,
    full_sync,
    _parse_envelope_address,
)
from src.session import EmailAccount, ImapConfig


# --------------------------------------------------------------------------
# [integration] extract_contacts_from_imap
# --------------------------------------------------------------------------

class TestExtractContactsFromImap:
    def test_extracts_from_addresses_from_inbox(self, imap_client: IMAPClient):
        """Scanning INBOX extracts From addresses with correct emails."""
        contacts = extract_contacts_from_imap(imap_client, ["INBOX"], limit=500, since=None)

        emails = {c.email for c in contacts}
        assert "alice@example.com" in emails
        assert "bob@example.com" in emails
        assert "carol@example.com" in emails

    def test_extracts_to_addresses_from_sent(self, imap_client: IMAPClient):
        """Scanning Sent folder extracts To addresses (recipients)."""
        contacts = extract_contacts_from_imap(
            imap_client, ["[Gmail]/Sent Mail"], limit=500, since=None
        )

        emails = {c.email for c in contacts}
        # The sent message (THREAD_MSG_2) is from testuser to alice@example.com
        assert "alice@example.com" in emails

    def test_deduplicates_and_sums_frequency(self, imap_client: IMAPClient):
        """Same contact from multiple emails gets summed frequency."""
        contacts = extract_contacts_from_imap(imap_client, ["INBOX"], limit=500, since=None)

        # alice@example.com appears in multiple INBOX messages (standup, kickoff thread)
        alice = next((c for c in contacts if c.email == "alice@example.com"), None)
        assert alice is not None
        assert alice.frequency >= 2

    def test_extracts_display_names(self, imap_client: IMAPClient):
        """Contacts include display names from ENVELOPE."""
        contacts = extract_contacts_from_imap(imap_client, ["INBOX"], limit=500, since=None)

        alice = next((c for c in contacts if c.email == "alice@example.com"), None)
        assert alice is not None
        assert alice.display_name == "Alice"

    def test_contacts_have_last_seen_at(self, imap_client: IMAPClient):
        """Each contact has a last_seen_at datetime."""
        contacts = extract_contacts_from_imap(imap_client, ["INBOX"], limit=500, since=None)

        for contact in contacts:
            assert isinstance(contact.last_seen_at, datetime)

    def test_respects_limit(self, imap_client: IMAPClient):
        """When limit is 1, only scans the most recent email per folder."""
        contacts = extract_contacts_from_imap(imap_client, ["INBOX"], limit=1, since=None)

        # With limit=1, should only get 1 email's From address
        assert len(contacts) <= 1


# --------------------------------------------------------------------------
# [unit] _parse_envelope_address
# --------------------------------------------------------------------------

class TestParseEnvelopeAddress:
    def test_parses_full_address(self):
        """Extracts display name and email from a complete address tuple."""
        addr = SimpleNamespace(name=b"Alice", route=None, mailbox=b"alice", host=b"example.com")
        result = _parse_envelope_address(addr)

        assert result is not None
        display_name, email = result
        assert display_name == "Alice"
        assert email == "alice@example.com"

    def test_handles_none_name(self):
        """Returns None display_name when name field is None."""
        addr = SimpleNamespace(name=None, route=None, mailbox=b"bob", host=b"example.com")
        result = _parse_envelope_address(addr)

        assert result is not None
        display_name, email = result
        assert display_name is None
        assert email == "bob@example.com"

    def test_handles_empty_name(self):
        """Returns None display_name when name field is empty bytes."""
        addr = SimpleNamespace(name=b"", route=None, mailbox=b"bob", host=b"example.com")
        result = _parse_envelope_address(addr)

        assert result is not None
        display_name, email = result
        assert display_name is None
        assert email == "bob@example.com"

    def test_returns_none_for_missing_mailbox(self):
        """Returns None when mailbox is missing."""
        addr = SimpleNamespace(name=b"Alice", route=None, mailbox=None, host=b"example.com")
        result = _parse_envelope_address(addr)

        assert result is None

    def test_returns_none_for_missing_host(self):
        """Returns None when host is missing."""
        addr = SimpleNamespace(name=b"Alice", route=None, mailbox=b"alice", host=None)
        result = _parse_envelope_address(addr)

        assert result is None

    def test_decodes_utf8_name(self):
        """Handles UTF-8 encoded display names."""
        addr = SimpleNamespace(
            name="Jean-Pierre".encode("utf-8"),
            route=None,
            mailbox=b"jp",
            host=b"example.com",
        )
        result = _parse_envelope_address(addr)

        assert result is not None
        display_name, email = result
        assert display_name == "Jean-Pierre"
        assert email == "jp@example.com"


# --------------------------------------------------------------------------
# [unit] full_sync cooldown behavior
# --------------------------------------------------------------------------

class TestFullSyncCooldown:
    @patch("src.tools.contact_sync.create_imap_connection")
    @patch("src.tools.contact_sync.close_imap_connection")
    @patch("src.tools.contact_sync.resolve_special_use_folder", return_value="Sent")
    @patch("src.tools.contact_sync.extract_contacts_from_imap", return_value=[])
    def test_skips_when_recently_synced(
        self, mock_extract, mock_resolve, mock_close, mock_create
    ):
        """full_sync returns 0 without creating IMAP connection when cooldown is active."""
        supabase = MagicMock()

        # Simulate that the atomic UPDATE returned no rows (cooldown active)
        supabase.table.return_value.update.return_value.eq.return_value.or_.return_value.execute.return_value = MagicMock(
            data=[]
        )

        account = EmailAccount(
            provider="custom", connection_type="imap_smtp", email_address="test@localhost",
            unipile_account_id=None, status="connected", imap_config=None, smtp_config=None,
        )
        result = full_sync(account, "user-123", supabase)

        assert result == 0
        mock_create.assert_not_called()

    @patch("src.tools.contact_sync.create_imap_connection")
    @patch("src.tools.contact_sync.close_imap_connection")
    @patch("src.tools.contact_sync.resolve_special_use_folder", return_value="Sent")
    @patch("src.tools.contact_sync.extract_contacts_from_imap", return_value=[])
    def test_proceeds_when_cooldown_expired(
        self, mock_extract, mock_resolve, mock_close, mock_create
    ):
        """full_sync proceeds with IMAP when cooldown has expired."""
        supabase = MagicMock()

        # Simulate that the atomic UPDATE succeeded (slot claimed)
        supabase.table.return_value.update.return_value.eq.return_value.or_.return_value.execute.return_value = MagicMock(
            data=[{"user_id": "user-123", "contacts_synced_at": "2026-01-01T00:00:00+00:00"}]
        )

        # Mock the upsert call chain
        supabase.table.return_value.upsert.return_value.execute.return_value = MagicMock(data=[])

        mock_client = MagicMock()
        mock_create.return_value = mock_client

        imap_cfg = ImapConfig(host="localhost", port=993, user="test", password="test")
        account = EmailAccount(
            provider="custom", connection_type="imap_smtp", email_address="test@localhost",
            unipile_account_id=None, status="connected", imap_config=imap_cfg, smtp_config=None,
        )
        result = full_sync(account, "user-123", supabase)

        # Should have created an IMAP connection
        mock_create.assert_called_once_with(imap_cfg)
        mock_close.assert_called_once_with(mock_client)

    @patch("src.tools.contact_sync.create_imap_connection")
    @patch("src.tools.contact_sync.close_imap_connection")
    @patch("src.tools.contact_sync.resolve_special_use_folder", return_value="Sent")
    @patch("src.tools.contact_sync.extract_contacts_from_imap", return_value=[])
    def test_proceeds_when_never_synced(
        self, mock_extract, mock_resolve, mock_close, mock_create
    ):
        """full_sync proceeds when contacts_synced_at is null (never synced)."""
        supabase = MagicMock()

        # Simulate that the atomic UPDATE succeeded (null case matched)
        supabase.table.return_value.update.return_value.eq.return_value.or_.return_value.execute.return_value = MagicMock(
            data=[{"user_id": "user-123", "contacts_synced_at": None}]
        )

        mock_client = MagicMock()
        mock_create.return_value = mock_client

        imap_cfg = ImapConfig(host="localhost", port=993, user="test", password="test")
        account = EmailAccount(
            provider="custom", connection_type="imap_smtp", email_address="test@localhost",
            unipile_account_id=None, status="connected", imap_config=imap_cfg, smtp_config=None,
        )
        result = full_sync(account, "user-123", supabase)

        mock_create.assert_called_once_with(imap_cfg)
