"""
End-to-end tests for email_client against real Gmail.

Requires TEST_IMAP_* env vars in .env. Skipped if not set.
Seeds a 2-message thread (received + sent reply), verifies read_thread
returns both, then deletes the seeded emails.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from pathlib import Path

import pytest
from dotenv import load_dotenv
from imapclient import IMAPClient

from src.session import ImapConfig, SmtpConfig
from src.tools.email_client import (
    list_inbox,
    read_thread,
    resolve_special_use_folder,
    send_email,
)

load_dotenv(Path(__file__).parents[1] / ".env")

IMAP_HOST = os.getenv("TEST_IMAP_HOST")
IMAP_PORT = os.getenv("TEST_IMAP_PORT")
IMAP_USER = os.getenv("TEST_IMAP_USER")
IMAP_PASSWORD = os.getenv("TEST_IMAP_PASSWORD")

requires_gmail = pytest.mark.skipif(
    not all([IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASSWORD]),
    reason="TEST_IMAP_* env vars not set",
)

# Unique tag per test run so parallel runs don't collide
RUN_ID = uuid.uuid4().hex[:8]
THREAD_SUBJECT = f"[TEST-{RUN_ID}] Thread test"


def _smtp_config() -> SmtpConfig:
    """Derive SMTP config from the IMAP test credentials (Gmail uses same creds)."""
    assert IMAP_USER and IMAP_PASSWORD
    return SmtpConfig(host="smtp.gmail.com", port=465, user=IMAP_USER, password=IMAP_PASSWORD)


def _wait_for_delivery(client: IMAPClient, subject: str, expected: int, timeout: float = 30) -> list[int]:
    """Poll INBOX until `expected` emails with `subject` appear. Returns UIDs."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        client.select_folder("INBOX")
        uids = client.search(["SUBJECT", subject])
        if len(uids) >= expected:
            return uids
        time.sleep(2)
    raise TimeoutError(f"Only {len(uids)} of {expected} emails with subject '{subject}' arrived within {timeout}s")


def _cleanup(client: IMAPClient, subject: str) -> None:
    """Delete all emails matching subject from INBOX, Sent Mail, and All Mail."""
    for folder_flag in [None, b"\\Sent", b"\\All", b"\\Trash"]:
        try:
            if folder_flag is None:
                folder = "INBOX"
            else:
                folder = resolve_special_use_folder(client, folder_flag)
            client.select_folder(folder)
            uids = client.search(["SUBJECT", subject])
            if uids:
                client.add_flags(uids, [b"\\Deleted"])
                client.expunge(uids)
        except Exception:
            pass


@requires_gmail
class TestReadThreadGmail:
    def test_thread_includes_sent_reply(self, gmail_client: IMAPClient):
        """read_thread must return the user's own sent replies on real Gmail."""
        assert IMAP_USER
        smtp = _smtp_config()

        try:
            # Seed: send an email to self (simulates receiving an email)
            original_subject = THREAD_SUBJECT
            asyncio.run(
                send_email(smtp, IMAP_USER, original_subject, "Original message for thread test.")
            )

            # Wait for it to land in INBOX
            inbox_uids = _wait_for_delivery(gmail_client, original_subject, 1)
            original_uid = inbox_uids[0]

            # Read it to get the Message-ID, then send a reply
            gmail_client.select_folder("INBOX")
            fetch = gmail_client.fetch([original_uid], ["ENVELOPE"])
            envelope = fetch[original_uid][b"ENVELOPE"]
            original_msg_id = envelope.message_id.decode() if envelope.message_id else ""

            # Seed: send a reply to self (simulates us replying)
            reply_subject = f"Re: {original_subject}"
            reply_body = "This is my reply to the thread test."

            # Build reply with proper headers so Gmail threads it
            from email.message import EmailMessage

            reply_msg = EmailMessage()
            reply_msg["From"] = IMAP_USER
            reply_msg["To"] = IMAP_USER
            reply_msg["Subject"] = reply_subject
            reply_msg["In-Reply-To"] = original_msg_id
            reply_msg["References"] = original_msg_id
            reply_msg.set_content(reply_body)

            import aiosmtplib

            asyncio.run(
                aiosmtplib.send(
                    reply_msg,
                    hostname=smtp.host,
                    port=smtp.port,
                    username=smtp.user,
                    password=smtp.password,
                    use_tls=True,
                )
            )

            # Wait for the reply to arrive in INBOX
            _wait_for_delivery(gmail_client, original_subject, 2)

            # Now test read_thread — this is what we're actually testing
            thread = read_thread(gmail_client, str(original_uid))

            # Must return both messages
            assert len(thread) >= 2, (
                f"Expected at least 2 messages in thread, got {len(thread)}: "
                f"{[(m.from_addr, m.subject) for m in thread]}"
            )

            # Must include a message from us (the sent reply)
            senders = [m.from_addr for m in thread]
            assert any(IMAP_USER in s for s in senders), (
                f"Thread should include sent reply from {IMAP_USER}, "
                f"but senders are: {senders}"
            )

            # Chronological order
            dates = [m.date for m in thread]
            assert dates == sorted(dates), "Thread messages should be in chronological order"

        finally:
            # Clean up seeded emails
            _cleanup(gmail_client, THREAD_SUBJECT)


@pytest.fixture()
def gmail_client():
    assert IMAP_HOST and IMAP_PORT and IMAP_USER and IMAP_PASSWORD
    client = IMAPClient(IMAP_HOST, port=int(IMAP_PORT), ssl=True)
    client.login(IMAP_USER, IMAP_PASSWORD)
    yield client
    try:
        client.logout()
    except Exception:
        pass
