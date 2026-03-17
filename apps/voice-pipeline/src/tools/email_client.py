"""
IMAP and SMTP client operations for email management.

Port of packages/email/src/imap-client.ts and smtp-client.ts.

Wraps imapclient for IMAP operations and aiosmtplib for SMTP.
Provides high-level email operations: listing, searching, reading,
marking, archiving, deleting, moving, sending, and draft management.
Includes connection management with auto-reconnect.

- Create and close IMAP connections
- List and search inbox emails
- Read full email content by UID
- Mark emails as read, archive, delete, move
- Send emails via SMTP (async)
- Save, send, and delete drafts
- Auto-reconnect wrapper for connection failures
"""

from __future__ import annotations

import email
import email.policy
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Any, Callable, TypeVar, cast

import aiosmtplib
from imapclient import IMAPClient

from src.session import ImapConfig, SmtpConfig

logger = logging.getLogger(__name__)

T = TypeVar("T")


# ============================================================================
# CONSTANTS
# ============================================================================

SNIPPET_LENGTH = 100


def resolve_special_use_folder(client: IMAPClient, flag: bytes) -> str:
    """Discover an IMAP folder path by its SPECIAL-USE flag (RFC 6154).

    Gmail may use "[Gmail]/...", "[Google Mail]/...", or localized names.
    This resolves the actual path at runtime.

    Args:
        client: Connected IMAPClient.
        flag: The special-use flag to look for (e.g. b'\\All', b'\\Trash').

    Returns:
        The folder path string.

    Raises:
        RuntimeError: If no folder with the given flag is found.
    """
    for flags, _delimiter, name in client.list_folders():
        if flag in flags:
            return name
    raise RuntimeError(f"No mailbox with special-use flag {flag!r} found")


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class EmailSummary:
    """Summary of an email for list/search results."""

    id: str
    from_addr: str
    subject: str
    snippet: str
    date: str


@dataclass
class Email:
    """Full email content."""

    id: str
    from_addr: str
    to: str
    subject: str
    body: str
    date: str
    is_read: bool


@dataclass
class ThreadMessage:
    """A single message within a thread."""

    id: str
    from_addr: str
    to: str
    subject: str
    body: str
    date: str


# ============================================================================
# CONNECTION MANAGEMENT
# ============================================================================

def create_imap_connection(config: ImapConfig) -> IMAPClient:
    """Create and authenticate an IMAPClient connection.

    Args:
        config: IMAP server connection parameters.

    Returns:
        Connected and authenticated IMAPClient instance.

    Raises:
        Exception: If connection or authentication fails.
    """
    client = IMAPClient(config.host, port=config.port, ssl=True)
    client.login(config.user, config.password)
    return client


def close_imap_connection(client: IMAPClient) -> None:
    """Gracefully log out and close an IMAP connection.

    Args:
        client: The IMAPClient to close.
    """
    try:
        client.logout()
    except Exception:
        logger.warning("[email_client] Error during IMAP logout, ignoring")


def with_reconnect(
    client_holder: dict[str, Any],
    config: ImapConfig,
    operation: Callable[[IMAPClient], T],
) -> T:
    """Wrap an IMAP operation with auto-reconnect on connection failure.

    Retries once with a fresh connection if the original fails.
    On second failure, returns a friendly error string instead of crashing.

    Args:
        client_holder: Mutable dict {"client": IMAPClient, "config": ImapConfig}.
            Updated in-place with a fresh client on reconnect.
        config: IMAP config for reconnection.
        operation: Callable that takes an IMAPClient and returns a result.

    Returns:
        The result of the operation.

    Raises:
        RuntimeError: If both the original and reconnect attempts fail.
    """
    try:
        return operation(client_holder["client"])
    except Exception as first_error:
        logger.warning(
            "[email_client] IMAP operation failed, reconnecting: %s", first_error
        )

        try:
            fresh_client = create_imap_connection(config)
            client_holder["client"] = fresh_client
            return operation(fresh_client)
        except Exception as second_error:
            raise RuntimeError(
                f"IMAP operation failed after reconnect: {second_error}"
            ) from second_error


# ============================================================================
# MAIN HANDLERS
# ============================================================================

def list_inbox(client: IMAPClient, limit: int) -> list[EmailSummary]:
    """List recent emails in the inbox.

    Fetches recent emails by sequence number (descending) from INBOX.

    Args:
        client: Connected IMAPClient.
        limit: Maximum number of emails to return.

    Returns:
        List of EmailSummary in reverse chronological order.
    """
    client.select_folder("INBOX", readonly=True)

    # Get all message UIDs, sorted newest first
    all_uids = client.search(["ALL"])  # type: ignore[arg-type]
    if not all_uids:
        return []

    # Take the most recent `limit` UIDs
    recent_uids = all_uids[-limit:]

    # Fetch envelope data for those UIDs
    fetch_data = client.fetch(recent_uids, ["ENVELOPE", "BODY.PEEK[TEXT]<0.2000>"])

    messages: list[EmailSummary] = []
    for uid, data in fetch_data.items():
        envelope: Any = data.get(b"ENVELOPE")
        if not envelope:
            continue

        # Extract body snippet from partial fetch
        body_key = _find_body_key(data)
        raw_body: bytes = data.get(body_key, b"") if body_key else b""  # type: ignore[assignment]
        snippet = _extract_snippet(raw_body)

        messages.append(EmailSummary(
            id=str(uid),
            from_addr=_format_address(envelope.from_),
            subject=_decode_header(envelope.subject),
            snippet=snippet,
            date=_format_date(envelope.date),
        ))

    # Return in reverse chronological order (most recent first)
    messages.reverse()
    return messages


def search_emails(client: IMAPClient, query: str) -> list[EmailSummary]:
    """Search emails by query string on subject and from fields.

    Uses IMAP OR search across subject and from fields.

    Args:
        client: Connected IMAPClient.
        query: Search query to match against emails.

    Returns:
        List of matching EmailSummary in reverse chronological order.
    """
    client.select_folder("INBOX", readonly=True)

    # IMAP OR search on subject + from
    uids = client.search(["OR", "SUBJECT", query, "FROM", query])  # type: ignore[arg-type]
    if not uids:
        return []

    fetch_data = client.fetch(uids, ["ENVELOPE", "BODY.PEEK[TEXT]<0.2000>"])

    messages: list[EmailSummary] = []
    for uid, data in fetch_data.items():
        envelope: Any = data.get(b"ENVELOPE")
        if not envelope:
            continue

        body_key = _find_body_key(data)
        raw_body: bytes = data.get(body_key, b"") if body_key else b""  # type: ignore[assignment]
        snippet = _extract_snippet(raw_body)

        messages.append(EmailSummary(
            id=str(uid),
            from_addr=_format_address(envelope.from_),
            subject=_decode_header(envelope.subject),
            snippet=snippet,
            date=_format_date(envelope.date),
        ))

    # Return in reverse chronological order
    messages.reverse()
    return messages


def read_email(client: IMAPClient, email_id: str) -> Email:
    """Read the full content of an email by UID.

    Args:
        client: Connected IMAPClient.
        email_id: The UID of the email to read.

    Returns:
        Full Email content.

    Raises:
        RuntimeError: If email is not found.
    """
    client.select_folder("INBOX", readonly=True)

    uid = int(email_id)
    fetch_data = client.fetch([uid], ["ENVELOPE", "FLAGS", "RFC822"])

    if uid not in fetch_data:
        raise RuntimeError(f"Email with UID {email_id} not found")

    data = fetch_data[uid]
    envelope: Any = data.get(b"ENVELOPE")
    if not envelope:
        raise RuntimeError(f"Email with UID {email_id} has no envelope data")

    flags: tuple = data.get(b"FLAGS", ())  # type: ignore[assignment]
    raw_source: bytes = data.get(b"RFC822", b"")  # type: ignore[assignment]
    body = _extract_body(raw_source)

    return Email(
        id=str(uid),
        from_addr=_format_address(envelope.from_),
        to=_format_address(envelope.to),
        subject=_decode_header(envelope.subject),
        body=body,
        date=_format_date(envelope.date),
        is_read=b"\\Seen" in flags,
    )


def read_thread(client: IMAPClient, email_id: str) -> list[ThreadMessage]:
    """Read all messages in a thread.

    On Gmail, uses X-GM-THRID (native thread ID) to find all messages
    in the thread reliably. On non-Gmail servers, falls back to
    Message-ID / References header search.

    Searches [Gmail]/All Mail to include both sent and received messages.

    Args:
        client: Connected IMAPClient.
        email_id: The UID of any email in the thread (from INBOX).

    Returns:
        List of ThreadMessage in chronological order (oldest first).

    Raises:
        RuntimeError: If the email or thread messages are not found.
    """
    uid = int(email_id)
    has_gmail_ext = client.has_capability(b"X-GM-EXT-1")

    # Step 1: Get the thread identifier from the target email in INBOX
    client.select_folder("INBOX", readonly=True)

    if has_gmail_ext:
        # Gmail: fetch the native thread ID
        fetch_data = client.fetch([uid], ["X-GM-THRID", "ENVELOPE"])
        if uid not in fetch_data:
            raise RuntimeError(f"Email with UID {email_id} not found")
        thread_id = fetch_data[uid].get(b"X-GM-THRID")
        if not thread_id:
            raise RuntimeError(f"Email with UID {email_id} has no X-GM-THRID")
    else:
        # Non-Gmail: collect Message-IDs from headers
        fetch_data = client.fetch([uid], ["ENVELOPE", "RFC822.HEADER"])
        if uid not in fetch_data:
            raise RuntimeError(f"Email with UID {email_id} not found")
        data = fetch_data[uid]
        envelope: Any = data.get(b"ENVELOPE")
        if not envelope:
            raise RuntimeError(f"Email with UID {email_id} has no envelope data")
        raw_headers: bytes = data.get(b"RFC822.HEADER", b"")  # type: ignore[assignment]
        message_id = _decode_bytes(envelope.message_id) if envelope.message_id else None
        references = _extract_references(raw_headers)
        thread_ids: set[str] = set()
        if message_id:
            thread_ids.add(message_id)
        thread_ids.update(references)

    # Step 2: Search All Mail for all thread messages
    all_mail_folder = resolve_special_use_folder(client, b"\\All")
    client.select_folder(all_mail_folder, readonly=True)
    matched_uids: set[int] = set()

    if has_gmail_ext:
        # Gmail: single search by thread ID
        matched_uids.update(client.search([b"X-GM-THRID", str(thread_id)]))  # type: ignore[arg-type]
    else:
        # Non-Gmail: search by Message-ID, References, and In-Reply-To
        for mid in thread_ids:
            by_id = client.search(["HEADER", "Message-ID", mid])  # type: ignore[arg-type]
            matched_uids.update(by_id)
            by_ref = client.search(["HEADER", "References", mid])  # type: ignore[arg-type]
            matched_uids.update(by_ref)
            by_reply = client.search(["HEADER", "In-Reply-To", mid])  # type: ignore[arg-type]
            matched_uids.update(by_reply)

    if not matched_uids:
        raise RuntimeError(f"No thread messages found for email {email_id}")

    logger.debug(
        "[email_client] read_thread: gmail=%s, matched %d messages",
        has_gmail_ext, len(matched_uids),
    )

    # Fetch the matched messages
    fetch_data = client.fetch(list(matched_uids), ["ENVELOPE", "RFC822"])
    results: list[ThreadMessage] = []

    for msg_uid, msg_data in fetch_data.items():
        msg_envelope: Any = msg_data.get(b"ENVELOPE")
        if not msg_envelope:
            continue

        raw_source: bytes = msg_data.get(b"RFC822", b"")  # type: ignore[assignment]
        body = _extract_body(raw_source)

        results.append(ThreadMessage(
            id=str(msg_uid),
            from_addr=_format_address(msg_envelope.from_),
            to=_format_address(msg_envelope.to),
            subject=_decode_header(msg_envelope.subject),
            body=body,
            date=_format_date(msg_envelope.date),
        ))

    # Sort chronologically (oldest first)
    results.sort(key=lambda m: m.date)
    return results


def mark_as_read(client: IMAPClient, email_id: str) -> None:
    """Mark an email as read by setting the Seen flag.

    Args:
        client: Connected IMAPClient.
        email_id: The UID of the email to mark.
    """
    client.select_folder("INBOX")
    client.add_flags([int(email_id)], [b"\\Seen"])


def archive_email(
    client: IMAPClient, email_id: str, source_folder: str = "INBOX"
) -> dict:
    """Archive an email by moving it to All Mail.

    Args:
        client: Connected IMAPClient.
        email_id: The UID of the email to archive.
        source_folder: The folder the email is currently in.

    Returns:
        UndoRecipe dict to reverse the archive operation.
    """
    archive_folder = resolve_special_use_folder(client, b"\\All")
    client.select_folder(source_folder)
    client.move([int(email_id)], archive_folder)

    return {
        "operation": "move_email",
        "params": {
            "email_id": email_id,
            "from": archive_folder,
            "to": source_folder,
        },
    }


def delete_email(
    client: IMAPClient, email_id: str, source_folder: str = "INBOX"
) -> dict:
    """Delete an email by moving it to Trash.

    Args:
        client: Connected IMAPClient.
        email_id: The UID of the email to delete.
        source_folder: The folder the email is currently in.

    Returns:
        UndoRecipe dict to reverse the delete operation.
    """
    trash_folder = resolve_special_use_folder(client, b"\\Trash")
    client.select_folder(source_folder)
    client.move([int(email_id)], trash_folder)

    return {
        "operation": "move_email",
        "params": {
            "email_id": email_id,
            "from": trash_folder,
            "to": source_folder,
        },
    }


def move_email(
    client: IMAPClient, email_id: str, from_folder: str, to_folder: str
) -> None:
    """Move an email between IMAP folders. Used by undo to reverse archive/delete.

    Args:
        client: Connected IMAPClient.
        email_id: The UID of the email to move.
        from_folder: Source folder.
        to_folder: Destination folder.
    """
    client.select_folder(from_folder)
    client.move([int(email_id)], to_folder)


async def send_email(config: SmtpConfig, to: str, subject: str, body: str) -> None:
    """Send an email via aiosmtplib SMTP.

    Args:
        config: SMTP server connection parameters.
        to: Recipient email address.
        subject: Email subject line.
        body: Email body text.

    Raises:
        Exception: If SMTP send fails.
    """
    msg = EmailMessage()
    msg["From"] = config.user
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)

    await aiosmtplib.send(
        msg,
        hostname=config.host,
        port=config.port,
        username=config.user,
        password=config.password,
        use_tls=config.port == 465,
        start_tls=config.port == 587,
    )


def send_draft(client: IMAPClient, config: SmtpConfig, draft_uid: str) -> None:
    """Fetch a draft from IMAP Drafts, extract to/subject/body, send via SMTP, delete draft.

    Note: This function is synchronous for IMAP parts. The SMTP send is handled
    via aiosmtplib in a separate call. The caller should wrap in asyncio.to_thread().

    Args:
        client: Connected IMAPClient.
        config: SMTP configuration for sending.
        draft_uid: UID of the draft in the Drafts folder.

    Raises:
        RuntimeError: If draft is not found or has missing fields.
    """
    raise NotImplementedError(
        "send_draft: requires fetching draft from IMAP Drafts by UID, "
        "extracting to/subject/body, sending via SMTP, then deleting the draft. "
        "Will be wired up when the pipeline integrates async SMTP sending."
    )


def save_draft(client: IMAPClient, to: str, subject: str, body: str) -> dict:
    """Save an email draft by appending to the Drafts folder via IMAP.

    Args:
        client: Connected IMAPClient.
        to: Recipient email address.
        subject: Email subject line.
        body: Email body text.

    Returns:
        UndoRecipe dict to delete the created draft.
    """
    raw_message = _build_raw_message(to, subject, body)

    # APPEND to Drafts with Draft and Seen flags
    drafts_folder = resolve_special_use_folder(client, b"\\Drafts")
    client.select_folder(drafts_folder)
    result = client.append(
        drafts_folder,
        raw_message.encode("utf-8"),
        flags=[b"\\Draft", b"\\Seen"],
        msg_time=datetime.now(timezone.utc),
    )

    # imapclient.append() returns the raw IMAP response bytes.
    # Gmail supports UIDPLUS, so the response is: b'[APPENDUID <validity> <uid>] ...'
    draft_uid = _parse_append_uid(result)
    if not draft_uid:
        raise RuntimeError(f"Failed to parse draft UID from APPEND response: {result!r}")

    return {
        "operation": "delete_draft",
        "params": {"draft_uid": draft_uid},
    }


def delete_draft(client: IMAPClient, draft_uid: str) -> None:
    """Delete a draft by UID from the Drafts folder.

    Args:
        client: Connected IMAPClient.
        draft_uid: The UID of the draft to delete.
    """
    drafts_folder = resolve_special_use_folder(client, b"\\Drafts")
    client.select_folder(drafts_folder)
    uid = int(draft_uid)
    client.add_flags([uid], [b"\\Deleted"])
    client.expunge([uid])


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _parse_append_uid(result: object) -> str | None:
    """Parse the UID from an IMAP APPEND response.

    If UIDPLUS is supported, the response contains [APPENDUID <validity> <uid>].
    Otherwise returns None.
    """
    import re

    if result is None:
        return None
    text = result.decode("utf-8", errors="replace") if isinstance(result, bytes) else str(result)
    match = re.search(r"\[APPENDUID\s+\d+\s+(\d+)\]", text)
    return match.group(1) if match else None

def _format_address(addresses: tuple | None) -> str:
    """Format an IMAP envelope address tuple into a readable string.

    Args:
        addresses: Tuple of address objects from ENVELOPE, or None.

    Returns:
        Formatted string like "John Doe <john@example.com>".
    """
    if not addresses:
        return "(unknown)"

    addr = addresses[0]
    # imapclient envelope addresses are (name, route, mailbox, host)
    name = _decode_bytes(addr.name) if addr.name else None
    mailbox = _decode_bytes(addr.mailbox) if addr.mailbox else ""
    host = _decode_bytes(addr.host) if addr.host else ""
    email_addr = f"{mailbox}@{host}" if mailbox and host else ""

    if name:
        return f"{name} <{email_addr}>"
    return email_addr or "(unknown)"


def _decode_bytes(value: bytes | str | None) -> str:
    """Decode bytes to string, handling None.

    Args:
        value: Bytes, string, or None.

    Returns:
        Decoded string.
    """
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _decode_header(value: bytes | str | None) -> str:
    """Decode an email header value.

    Args:
        value: Raw header bytes, string, or None.

    Returns:
        Decoded header string.
    """
    if value is None:
        return "(no subject)"
    decoded = _decode_bytes(value)
    return decoded if decoded else "(no subject)"


def _format_date(dt: datetime | None) -> str:
    """Format a datetime to ISO 8601 string.

    Args:
        dt: Datetime object or None.

    Returns:
        ISO 8601 date string.
    """
    if dt is None:
        return ""
    return dt.isoformat()


def _find_body_key(data: dict) -> bytes | None:
    """Find the BODY.PEEK[TEXT] key in fetch response data.

    The key format varies, so we search for any key containing BODY and TEXT.

    Args:
        data: Fetch response data dict.

    Returns:
        The matching key, or None.
    """
    for key in data:
        if isinstance(key, bytes) and b"BODY" in key and b"TEXT" in key:
            return key
    return None


def _extract_snippet(raw_body: bytes | str) -> str:
    """Extract a plain-text snippet from raw email body content.

    Args:
        raw_body: Raw body bytes or string.

    Returns:
        Short snippet of the email body.
    """
    text = _decode_bytes(raw_body) if isinstance(raw_body, bytes) else raw_body
    if not text:
        return ""
    # Clean up whitespace and truncate
    cleaned = " ".join(text.split())
    return cleaned[:SNIPPET_LENGTH].strip()


def _extract_references(raw_headers: bytes | str) -> list[str]:
    """Extract Message-IDs from References and In-Reply-To headers.

    Args:
        raw_headers: Raw email headers as bytes or string.

    Returns:
        List of unique Message-ID strings (with angle brackets).
    """
    import re

    header_text = _decode_bytes(raw_headers) if isinstance(raw_headers, bytes) else raw_headers
    if not header_text:
        return []

    ids: list[str] = []
    for header_name in ("References", "In-Reply-To"):
        pattern = rf"^{header_name}:\s*(.+(?:\r?\n[ \t]+.+)*)"
        match = re.search(pattern, header_text, re.MULTILINE | re.IGNORECASE)
        if match:
            ids.extend(re.findall(r"<[^>]+>", match.group(1)))

    return list(dict.fromkeys(ids))  # deduplicate preserving order


def _extract_body(raw_source: bytes | str) -> str:
    """Extract the plain-text body from a raw RFC822 email source.

    Uses Python's email parser for proper MIME handling.

    Args:
        raw_source: Raw email source bytes or string.

    Returns:
        Plain text body content.
    """
    if not raw_source:
        return ""

    source_bytes = raw_source if isinstance(raw_source, bytes) else raw_source.encode("utf-8")
    msg = email.message_from_bytes(source_bytes, policy=email.policy.default)

    # Try to get plain text body
    body = msg.get_body(preferencelist=("plain",))
    if body:
        content = body.get_content()
        return content.strip() if isinstance(content, str) else ""

    # Fallback: just get the payload as string
    payload = msg.get_payload(decode=True)
    if isinstance(payload, bytes):
        return payload.decode("utf-8", errors="replace").strip()

    return ""


def _build_raw_message(to: str, subject: str, body: str) -> str:
    """Build a raw RFC 2822 email message from parameters.

    Args:
        to: Recipient email address.
        subject: Email subject line.
        body: Email body text.

    Returns:
        Raw email string suitable for IMAP APPEND.
    """
    date = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")

    return "\r\n".join([
        f"To: {to}",
        f"Subject: {subject}",
        f"Date: {date}",
        "Content-Type: text/plain; charset=utf-8",
        "MIME-Version: 1.0",
        "",
        body,
    ])
