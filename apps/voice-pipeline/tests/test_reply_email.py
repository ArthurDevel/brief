"""
Unit tests for the reply_email tool.

Tests fetch_reply_context, reply_to_email, handle_tool_call queueing,
missing Message-ID error handling, and classification override protection.
Uses mock IMAPClient and mock aiosmtplib (same pattern as test_email_client.py).
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.session import SmtpConfig
from src.tools.classification import classify_action
from src.tools.email_client import (
    ReplyContext,
    fetch_reply_context,
    reply_to_email,
)
from src.tools.handlers import ActionInput, handle_tool_call


# ============================================================================
# CONSTANTS
# ============================================================================

SMTP_CONFIG = SmtpConfig(host="smtp.example.com", port=465, user="me@example.com", password="secret")


# ============================================================================
# fetch_reply_context
# ============================================================================

class TestFetchReplyContext:
    def test_extracts_all_fields_from_envelope_and_headers(self):
        """fetch_reply_context extracts message_id, references, from_addr, to, cc, and subject."""
        mock_client = MagicMock()

        envelope = MagicMock()
        envelope.message_id = b"<orig-123@example.com>"
        envelope.subject = b"Project kickoff"
        envelope.from_ = (MagicMock(mailbox=b"alice", host=b"example.com"),)
        envelope.to = (
            MagicMock(mailbox=b"me", host=b"example.com"),
            MagicMock(mailbox=b"bob", host=b"example.com"),
        )
        envelope.cc = (MagicMock(mailbox=b"carol", host=b"example.com"),)

        raw_headers = (
            b"Message-ID: <orig-123@example.com>\r\n"
            b"References: <ref-1@example.com> <ref-2@example.com>\r\n"
            b"Subject: Project kickoff\r\n"
        )

        mock_client.fetch.return_value = {
            42: {
                b"ENVELOPE": envelope,
                b"RFC822.HEADER": raw_headers,
            }
        }

        ctx = fetch_reply_context(mock_client, "42")

        assert ctx.message_id == "<orig-123@example.com>"
        assert ctx.references == ["<ref-1@example.com>", "<ref-2@example.com>"]
        assert ctx.from_addr == "alice@example.com"
        assert ctx.to == ["me@example.com", "bob@example.com"]
        assert ctx.cc == ["carol@example.com"]
        assert ctx.subject == "Project kickoff"

    def test_raises_when_no_message_id(self):
        """fetch_reply_context raises RuntimeError when Message-ID is missing."""
        mock_client = MagicMock()

        envelope = MagicMock()
        envelope.message_id = None
        envelope.subject = b"No ID email"
        envelope.from_ = (MagicMock(mailbox=b"alice", host=b"example.com"),)
        envelope.to = (MagicMock(mailbox=b"me", host=b"example.com"),)
        envelope.cc = None

        mock_client.fetch.return_value = {
            99: {
                b"ENVELOPE": envelope,
                b"RFC822.HEADER": b"Subject: No ID email\r\n",
            }
        }

        with pytest.raises(RuntimeError, match="no Message-ID"):
            fetch_reply_context(mock_client, "99")


# ============================================================================
# reply_to_email
# ============================================================================

class TestReplyToEmail:
    def _run(self, coro):
        """Helper to run an async coroutine synchronously."""
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()

    @patch("src.tools.email_client.aiosmtplib.send", new_callable=AsyncMock)
    def test_builds_correct_reply_message(self, mock_send: AsyncMock):
        """reply_to_email builds EmailMessage with In-Reply-To, References, Re: subject, correct To."""
        ctx = ReplyContext(
            message_id="<orig@example.com>",
            references=["<ref-1@example.com>"],
            from_addr="alice@example.com",
            to=["me@example.com"],
            cc=[],
            subject="Hello",
        )

        self._run(reply_to_email(SMTP_CONFIG, ctx, "Thanks!", False, "me@example.com"))

        mock_send.assert_called_once()
        msg = mock_send.call_args[0][0]

        assert msg["To"] == "alice@example.com"
        assert msg["Cc"] is None
        assert msg["Subject"] == "Re: Hello"
        assert msg["In-Reply-To"] == "<orig@example.com>"
        assert msg["References"] == "<ref-1@example.com> <orig@example.com>"

    @patch("src.tools.email_client.aiosmtplib.send", new_callable=AsyncMock)
    def test_reply_all_includes_cc_minus_self(self, mock_send: AsyncMock):
        """reply_to_email with reply_all=True CCs all original To/CC minus sender."""
        ctx = ReplyContext(
            message_id="<orig@example.com>",
            references=[],
            from_addr="alice@example.com",
            to=["me@example.com", "bob@example.com"],
            cc=["carol@example.com"],
            subject="Team update",
        )

        self._run(reply_to_email(SMTP_CONFIG, ctx, "Got it.", True, "me@example.com"))

        mock_send.assert_called_once()
        msg = mock_send.call_args[0][0]

        assert msg["To"] == "alice@example.com"
        assert "bob@example.com" in msg["Cc"]
        assert "carol@example.com" in msg["Cc"]
        assert "me@example.com" not in msg["Cc"]

    @patch("src.tools.email_client.aiosmtplib.send", new_callable=AsyncMock)
    def test_does_not_double_prefix_re_subject(self, mock_send: AsyncMock):
        """reply_to_email does not add Re: when subject already starts with it."""
        ctx = ReplyContext(
            message_id="<orig@example.com>",
            references=[],
            from_addr="alice@example.com",
            to=["me@example.com"],
            cc=[],
            subject="Re: Hello",
        )

        self._run(reply_to_email(SMTP_CONFIG, ctx, "Again", False, "me@example.com"))

        msg = mock_send.call_args[0][0]
        assert msg["Subject"] == "Re: Hello"


# ============================================================================
# handle_tool_call queues reply_email as pending
# ============================================================================

class TestHandleToolCallQueuesReplyEmail:
    def test_reply_email_is_queued_as_pending(self):
        """handle_tool_call with tool_name='reply_email' returns status='pending'."""
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.insert.return_value.execute.return_value = MagicMock(
            data=[{"id": "action-123"}]
        )

        action_input = ActionInput(
            user_id="user-1",
            session_id="session-1",
            tool_name="reply_email",
            arguments={"email_id": "42", "body": "Thanks!", "reply_all": False},
        )

        result = handle_tool_call(
            input=action_input,
            user_config={},
            imap_holder={"client": MagicMock(), "config": MagicMock()},
            smtp_config=SMTP_CONFIG,
            supabase=mock_supabase,
        )

        assert result.status == "pending"
        assert result.action_id == "action-123"

        # Verify it was inserted as pending with requires_approval=True
        insert_call = mock_supabase.table.return_value.insert.call_args
        inserted_row = insert_call[0][0]
        assert inserted_row["status"] == "pending"
        assert inserted_row["requires_approval"] is True
        assert inserted_row["tool_name"] == "reply_email"


# ============================================================================
# classify_action override protection
# ============================================================================

class TestClassifyActionReplyEmail:
    def test_user_config_cannot_override_reply_email(self):
        """classify_action('reply_email', ...) always returns 'mutating_queued' even with override."""
        result = classify_action("reply_email", {"reply_email": "mutating_auto"})
        assert result == "mutating_queued"
