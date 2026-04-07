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
- Save and delete drafts
- Auto-reconnect wrapper for connection failures
"""

from __future__ import annotations

import email
import email.policy
import logging
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from email.message import EmailMessage
from typing import Any, Callable, TypeVar, cast

import aiosmtplib
from imapclient import IMAPClient
from markdownify import markdownify

from src.session import EmailAccount, ImapConfig, SmtpConfig
from src.tools.query_translator import translate_query

logger = logging.getLogger(__name__)

T = TypeVar("T")


# ============================================================================
# CONSTANTS
# ============================================================================

SNIPPET_LENGTH = 100
PARTIAL_FETCH_BYTES = 8192
SINCE_FILTER_CAP = 100


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
class ReplyContext:
    """Context needed to build a properly threaded reply to an email.

    Attributes:
        message_id: Message-ID of the original email.
        references: Message-IDs from the References header.
        from_addr: Original sender address.
        to: Original To recipients.
        cc: Original CC recipients.
        subject: Original subject line.
    """

    message_id: str
    references: list[str]
    from_addr: str
    to: list[str]
    cc: list[str]
    subject: str


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


@dataclass
class FolderInfo:
    """Info about an IMAP folder."""

    path: str
    name: str
    special_use: str | None


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


@dataclass
class EmailClientContext:
    """Provider-aware email client context.

    For custom (imap_smtp) accounts, wraps the IMAP client holder and SMTP config.
    For Unipile accounts, holds the account_id for API calls.

    Attributes:
        connection_type: "unipile" or "imap_smtp".
        imap_holder: Mutable IMAP client holder (only for imap_smtp).
        smtp_config: SMTP config (only for imap_smtp).
        unipile_account_id: Unipile account ID (only for unipile).
    """

    connection_type: str  # "unipile" | "imap_smtp"
    imap_holder: dict[str, Any] | None = None
    smtp_config: SmtpConfig | None = None
    unipile_account_id: str | None = None


def create_email_client_context(
    account: EmailAccount,
    imap_holder: dict[str, Any] | None = None,
) -> EmailClientContext:
    """Create a provider-aware email client context from an EmailAccount.

    For custom accounts, the caller must provide the imap_holder with a live
    IMAP connection. For Unipile accounts, only the account_id is needed.

    Args:
        account: The user's active email account.
        imap_holder: Mutable dict {"client": IMAPClient, "config": ImapConfig}.
            Required for imap_smtp accounts, ignored for unipile.

    Returns:
        EmailClientContext ready for use by tool handlers.

    Raises:
        RuntimeError: If a custom account is missing the imap_holder.
    """
    if account.connection_type == "imap_smtp":
        if imap_holder is None:
            raise RuntimeError("imap_holder is required for imap_smtp accounts")
        return EmailClientContext(
            connection_type="imap_smtp",
            imap_holder=imap_holder,
            smtp_config=account.smtp_config,
        )

    # Unipile account
    if not account.unipile_account_id:
        raise RuntimeError("unipile_account_id is required for unipile accounts")
    return EmailClientContext(
        connection_type="unipile",
        unipile_account_id=account.unipile_account_id,
    )


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

def list_inbox(
    client: IMAPClient,
    limit: int,
    since: datetime | None = None,
) -> list[EmailSummary]:
    """List recent emails in the inbox.

    Uses BODYSTRUCTURE to identify the text/plain part, then fetches
    only that part for the snippet. Avoids downloading full email bodies.

    When `since` is provided, returns only emails received after that datetime.
    The `limit` parameter is ignored in this case; results are capped at
    SINCE_FILTER_CAP internally.

    Args:
        client: Connected IMAPClient.
        limit: Maximum number of emails to return (ignored when since is set).
        since: When set, only return emails received after this datetime.

    Returns:
        List of EmailSummary in reverse chronological order.
    """
    client.select_folder("INBOX", readonly=True)

    if since is not None:
        # Use IMAP SINCE (date-only) as coarse filter, then refine by datetime
        uids = client.search(["SINCE", since.date()])  # type: ignore[arg-type]
        if not uids:
            return []
        filtered_uids = _filter_uids_by_datetime(client, uids, since)
        capped_uids = filtered_uids[-SINCE_FILTER_CAP:]
        return _fetch_summaries(client, capped_uids)

    all_uids = client.search(["ALL"])  # type: ignore[arg-type]
    if not all_uids:
        return []

    recent_uids = all_uids[-limit:]
    return _fetch_summaries(client, recent_uids)


def search_emails(client: IMAPClient, query: str) -> list[EmailSummary]:
    """Search emails by query string on subject and from fields.

    Uses IMAP OR search across subject and from fields, then fetches
    BODYSTRUCTURE to extract clean snippets.

    Args:
        client: Connected IMAPClient.
        query: Search query to match against emails.

    Returns:
        List of matching EmailSummary in reverse chronological order.
    """
    client.select_folder("INBOX", readonly=True)

    criteria = translate_query(query)
    uids = client.search(criteria)  # type: ignore[arg-type]
    if not uids:
        return []

    return _fetch_summaries(client, uids)


def count_emails_since(client: IMAPClient, since: datetime) -> int:
    """Count the number of emails in the inbox received after a given datetime.

    Uses IMAP SINCE (date-only) as a coarse filter, then fetches envelope
    dates and counts only those strictly after the full datetime.

    Args:
        client: Connected IMAPClient.
        since: Count emails received after this datetime.

    Returns:
        Number of emails after the given datetime.
    """
    client.select_folder("INBOX", readonly=True)
    uids = client.search(["SINCE", since.date()])  # type: ignore[arg-type]
    if not uids:
        return 0
    filtered = _filter_uids_by_datetime(client, uids, since)
    return len(filtered)


def count_unread_emails(client: IMAPClient) -> int:
    """Count the number of unread emails in the inbox.

    Args:
        client: Connected IMAPClient.

    Returns:
        Number of unread (UNSEEN) emails.
    """
    client.select_folder("INBOX", readonly=True)
    uids = client.search(["UNSEEN"])  # type: ignore[arg-type]
    return len(uids)


def _fetch_summaries(client: IMAPClient, uids: list[int]) -> list[EmailSummary]:
    """Fetch email summaries in a single IMAP call.

    Uses a partial fetch (first PARTIAL_FETCH_BYTES bytes) for BODY.PEEK[TEXT]
    to avoid downloading full email bodies. If no text snippet can be extracted,
    falls back to using the subject line as snippet.

    Args:
        client: Connected IMAPClient.
        uids: List of UIDs to fetch.

    Returns:
        List of EmailSummary in reverse chronological order.
    """
    fetch_data = client.fetch(uids, ["ENVELOPE", "BODYSTRUCTURE", f"BODY.PEEK[TEXT]<0.{PARTIAL_FETCH_BYTES}>"])

    messages: list[EmailSummary] = []
    for uid, data in fetch_data.items():
        envelope: Any = data.get(b"ENVELOPE")
        if not envelope:
            continue

        subject = _decode_header(envelope.subject)

        # Extract snippet from batch-fetched text body
        bodystructure = data.get(b"BODYSTRUCTURE")
        snippet = ""
        if bodystructure:
            raw_text: bytes = b""
            for key, value in data.items():
                if isinstance(key, bytes) and b"TEXT" in key and isinstance(value, bytes):
                    raw_text = value
                    break
            snippet = _extract_snippet_from_raw_text(raw_text, bodystructure)

        # Fall back to subject if no text snippet could be extracted
        if not snippet:
            snippet = subject[:SNIPPET_LENGTH]

        messages.append(EmailSummary(
            id=str(uid),
            from_addr=_format_address(envelope.from_),
            subject=subject,
            snippet=snippet,
            date=_format_date(envelope.date),
        ))

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


def fetch_reply_context(client: IMAPClient, email_id: str) -> ReplyContext:
    """Fetch the envelope and headers needed to build a properly threaded reply.

    Extracts Message-ID, References, From, all To addresses, all CC addresses,
    and the Subject from an email in INBOX.

    Args:
        client: Connected IMAPClient.
        email_id: The UID of the email to fetch context for.

    Returns:
        ReplyContext with threading and recipient info.

    Raises:
        RuntimeError: If the email is not found or has no Message-ID.
    """
    client.select_folder("INBOX", readonly=True)

    uid = int(email_id)
    fetch_data = client.fetch([uid], ["ENVELOPE", "RFC822.HEADER"])

    if uid not in fetch_data:
        raise RuntimeError(f"Email with UID {email_id} not found")

    data = fetch_data[uid]
    envelope: Any = data.get(b"ENVELOPE")
    if not envelope:
        raise RuntimeError(f"Email with UID {email_id} has no envelope data")

    # Message-ID is required for threading
    if not envelope.message_id:
        raise RuntimeError(f"Email with UID {email_id} has no Message-ID header")
    message_id = _decode_bytes(envelope.message_id)

    # Parse References from raw headers
    raw_headers: bytes = data.get(b"RFC822.HEADER", b"")  # type: ignore[assignment]
    references = _extract_references(raw_headers)

    # Extract raw email address from envelope fields
    from_addr = _extract_email_address(envelope.from_)
    to = _extract_all_email_addresses(envelope.to)
    cc = _extract_all_email_addresses(envelope.cc)

    subject = _decode_header(envelope.subject)

    return ReplyContext(
        message_id=message_id,
        references=references,
        from_addr=from_addr,
        to=to,
        cc=cc,
        subject=subject,
    )


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
) -> tuple[dict, str]:
    """Archive an email by moving it to All Mail.

    Fetches the envelope before moving to extract the stable RFC Message-ID.

    Args:
        client: Connected IMAPClient.
        email_id: The UID of the email to archive.
        source_folder: The folder the email is currently in.

    Returns:
        Tuple of (undo_recipe_dict, message_id).
    """
    archive_folder = resolve_special_use_folder(client, b"\\All")
    client.select_folder(source_folder)

    # Fetch envelope before move to extract stable Message-ID
    message_id = _fetch_message_id(client, int(email_id))

    client.move([int(email_id)], archive_folder)

    undo_recipe = {
        "operation": "move_email",
        "params": {
            "message_id": message_id,
            "from": archive_folder,
            "to": source_folder,
        },
    }
    return undo_recipe, message_id


def delete_email(
    client: IMAPClient, email_id: str, source_folder: str = "INBOX"
) -> tuple[dict, str]:
    """Delete an email by moving it to Trash.

    Fetches the envelope before moving to extract the stable RFC Message-ID.

    Args:
        client: Connected IMAPClient.
        email_id: The UID of the email to delete.
        source_folder: The folder the email is currently in.

    Returns:
        Tuple of (undo_recipe_dict, message_id).
    """
    trash_folder = resolve_special_use_folder(client, b"\\Trash")
    client.select_folder(source_folder)

    # Fetch envelope before move to extract stable Message-ID
    message_id = _fetch_message_id(client, int(email_id))

    client.move([int(email_id)], trash_folder)

    undo_recipe = {
        "operation": "move_email",
        "params": {
            "message_id": message_id,
            "from": trash_folder,
            "to": source_folder,
        },
    }
    return undo_recipe, message_id


def move_email(
    client: IMAPClient, message_id: str, from_folder: str, to_folder: str
) -> None:
    """Move an email between IMAP folders by Message-ID header search.

    Used by undo to reverse archive/delete/move. Searches the source folder
    for the email by its RFC Message-ID header, resolves the current UID,
    then moves it.

    Args:
        client: Connected IMAPClient.
        message_id: The RFC Message-ID header value (e.g. "<abc@example.com>").
        from_folder: Source folder.
        to_folder: Destination folder.

    Raises:
        RuntimeError: If no email with the given Message-ID is found in from_folder.
    """
    client.select_folder(from_folder)
    uids = client.search(["HEADER", "Message-ID", message_id])  # type: ignore[arg-type]
    if not uids:
        raise RuntimeError(
            f"No email with Message-ID {message_id!r} found in {from_folder}"
        )
    client.move([uids[0]], to_folder)


def list_folders(client: IMAPClient) -> list[FolderInfo]:
    """List all selectable IMAP folders, excluding INBOX and non-selectable folders.

    Args:
        client: Connected IMAPClient.

    Returns:
        List of FolderInfo for each selectable folder.
    """
    results: list[FolderInfo] = []
    for flags, _delimiter, name in client.list_folders():
        # Skip non-selectable folders (e.g. [Gmail] parent container)
        if b"\\Noselect" in flags:
            continue
        # Skip INBOX (user is already there)
        if name == "INBOX":
            continue

        # Extract display name (last path segment)
        display_name = name.rsplit("/", 1)[-1] if "/" in name else name

        # Check for special-use flag (e.g. \\Trash, \\All, \\Drafts)
        special_use: str | None = None
        for flag in flags:
            flag_str = flag.decode("utf-8", errors="replace") if isinstance(flag, bytes) else str(flag)
            if flag_str.startswith("\\") and flag_str not in ("\\HasChildren", "\\HasNoChildren", "\\Noselect"):
                special_use = flag_str
                break

        results.append(FolderInfo(path=name, name=display_name, special_use=special_use))

    return results


def move_email_to_folder(
    client: IMAPClient,
    email_id: str,
    target_folder: str,
    source_folder: str = "INBOX",
) -> tuple[dict, str]:
    """Move an email to a specified folder.

    Fetches the Message-ID header for stable undo, then moves the email.

    Args:
        client: Connected IMAPClient.
        email_id: The UID of the email to move.
        target_folder: Destination folder path.
        source_folder: The folder the email is currently in.

    Returns:
        Tuple of (undo_recipe_dict, message_id).
    """
    client.select_folder(source_folder)

    # Fetch Message-ID for stable undo recipe
    message_id = _fetch_message_id(client, int(email_id))

    client.move([int(email_id)], target_folder)

    undo_recipe = {
        "operation": "move_email",
        "params": {
            "message_id": message_id,
            "from": target_folder,
            "to": source_folder,
        },
    }
    return undo_recipe, message_id


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


async def reply_to_email(
    config: SmtpConfig,
    context: ReplyContext,
    body: str,
    reply_all: bool,
    sender_address: str,
) -> None:
    """Send a reply to an existing email with proper threading headers.

    Builds In-Reply-To, References, and Re: subject prefix.
    For reply_all, CCs all original To/CC recipients minus the sender.

    Args:
        config: SMTP server connection parameters.
        context: Reply context from the original email.
        body: Reply body text.
        reply_all: If True, CC all original To/CC recipients (minus sender).
        sender_address: The current user's email address (excluded from CC).

    Raises:
        Exception: If SMTP send fails.
    """
    msg = EmailMessage()
    msg["From"] = sender_address
    msg["To"] = context.from_addr

    # Build CC list for reply-all: original To + CC, minus our own address
    if reply_all:
        cc_addrs = [
            addr for addr in context.to + context.cc
            if addr.lower() != sender_address.lower()
        ]
        if cc_addrs:
            msg["Cc"] = ", ".join(cc_addrs)

    # Add Re: prefix only if not already present (case-insensitive)
    subject = context.subject if re.match(r"^re:", context.subject, re.IGNORECASE) else f"Re: {context.subject}"
    msg["Subject"] = subject

    # Threading headers
    msg["In-Reply-To"] = context.message_id
    msg["References"] = " ".join([*context.references, context.message_id])

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

def _filter_uids_by_datetime(
    client: IMAPClient,
    uids: list[int],
    since: datetime,
) -> list[int]:
    """Filter UIDs to only those with an envelope date strictly after `since`.

    Fetches ENVELOPE for each UID and compares envelope.date against the
    given datetime. This provides time-granular filtering on top of IMAP's
    date-only SINCE criterion.

    Args:
        client: Connected IMAPClient (folder must already be selected).
        uids: UIDs to check.
        since: Only keep UIDs whose envelope date is after this datetime.

    Returns:
        Filtered list of UIDs, preserving original order.
    """
    if not uids:
        return []

    # Precompute both forms of `since` for comparison:
    # - Aware: for comparing against timezone-aware envelope dates (e.g. Outlook)
    # - Naive: for comparing against naive envelope dates (e.g. Gmail)
    since_aware = since if since.tzinfo else since.replace(tzinfo=timezone.utc)
    since_naive = since.replace(tzinfo=None)

    fetch_data = client.fetch(uids, ["ENVELOPE"])
    filtered: list[int] = []

    for uid in uids:
        data = fetch_data.get(uid)
        if not data:
            continue
        envelope: Any = data.get(b"ENVELOPE")
        if not envelope or not envelope.date:
            continue
        env_date: datetime = envelope.date
        if env_date.tzinfo is not None:
            # Timezone-aware: compare in UTC (handles cross-timezone correctly)
            passes = env_date > since_aware
        else:
            # Naive (Gmail): compare as naive local times
            passes = env_date > since_naive
        if passes:
            filtered.append(uid)

    return filtered


def _fetch_message_id(client: IMAPClient, uid: int) -> str:
    """Fetch the RFC Message-ID from the envelope for a given UID.

    Must be called after select_folder so the UID is valid in the selected context.

    Args:
        client: Connected IMAPClient with a folder already selected.
        uid: The UID of the email.

    Returns:
        The Message-ID string (e.g. "<abc@example.com>").

    Raises:
        RuntimeError: If the envelope or Message-ID is missing.
    """
    fetch_data = client.fetch([uid], ["ENVELOPE"])
    if uid not in fetch_data:
        raise RuntimeError(f"Email with UID {uid} not found for envelope fetch")

    envelope: Any = fetch_data[uid].get(b"ENVELOPE")
    if not envelope:
        raise RuntimeError(f"Email with UID {uid} has no envelope data")

    if not envelope.message_id:
        raise RuntimeError(f"Email with UID {uid} has no Message-ID in envelope")

    return _decode_bytes(envelope.message_id)


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


def _extract_email_address(addresses: tuple | None) -> str:
    """Extract the raw email address from the first entry in an IMAP envelope address tuple.

    Args:
        addresses: Tuple of address objects from ENVELOPE, or None.

    Returns:
        Raw email address string (e.g. "alice@example.com").
    """
    if not addresses:
        return ""

    addr = addresses[0]
    mailbox = _decode_bytes(addr.mailbox) if addr.mailbox else ""
    host = _decode_bytes(addr.host) if addr.host else ""
    return f"{mailbox}@{host}" if mailbox and host else ""


def _extract_all_email_addresses(addresses: tuple | None) -> list[str]:
    """Extract raw email addresses from ALL entries in an IMAP envelope address tuple.

    Args:
        addresses: Tuple of address objects from ENVELOPE, or None.

    Returns:
        List of raw email address strings.
    """
    if not addresses:
        return []

    result: list[str] = []
    for addr in addresses:
        mailbox = _decode_bytes(addr.mailbox) if addr.mailbox else ""
        host = _decode_bytes(addr.host) if addr.host else ""
        if mailbox and host:
            result.append(f"{mailbox}@{host}")
    return result


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
    """Decode an email header value, including RFC 2047 encoded words.

    Handles =?UTF-8?Q?...?= and =?UTF-8?B?...?= encoded subjects.

    Args:
        value: Raw header bytes, string, or None.

    Returns:
        Decoded header string.
    """
    if value is None:
        return "(no subject)"

    raw = _decode_bytes(value) if isinstance(value, bytes) else value
    if not raw:
        return "(no subject)"

    # Decode RFC 2047 encoded words (=?charset?encoding?text?=)
    from email.header import decode_header as decode_rfc2047
    parts = decode_rfc2047(raw)
    decoded_parts = []
    for part_bytes, charset in parts:
        if isinstance(part_bytes, bytes):
            decoded_parts.append(part_bytes.decode(charset or "utf-8", errors="replace"))
        else:
            decoded_parts.append(part_bytes)

    return " ".join(decoded_parts).strip() or "(no subject)"


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


def _extract_snippet_from_raw_text(raw_text: bytes, bodystructure: Any) -> str:
    """Extract a clean text snippet from batch-fetched BODY.PEEK[TEXT] data.

    Reconstructs a minimal MIME message using the Content-Type from
    BODYSTRUCTURE, then uses Python's email stdlib to parse and extract
    the text content. This handles all encoding (base64, quoted-printable),
    charset, and multipart nesting automatically.

    Args:
        raw_text: Raw bytes from BODY.PEEK[TEXT] in the batch fetch.
        bodystructure: Parsed BODYSTRUCTURE from imapclient.

    Returns:
        Clean text snippet, max SNIPPET_LENGTH chars.
    """
    if not raw_text:
        return ""

    # Build a Content-Type header from BODYSTRUCTURE
    content_type = _build_content_type_string(bodystructure)

    # Reconstruct a minimal MIME message so Python's email parser can handle it
    header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
    mime_bytes = header + raw_text
    msg = email.message_from_bytes(mime_bytes, policy=email.policy.default)

    # Extract text content -- prefer plain text, fall back to HTML
    text = ""
    plain_part = msg.get_body(preferencelist=("plain",))
    if plain_part is not None:
        content = plain_part.get_content()
        if isinstance(content, str) and content.strip():
            text = content.strip()

    if not text:
        html_part = msg.get_body(preferencelist=("html",))
        if html_part is not None:
            html_content = html_part.get_content()
            if isinstance(html_content, str) and html_content.strip():
                text = markdownify(
                    html_content,
                    strip=["img", "table", "tr", "td", "th", "thead", "tbody"],
                ).strip()

    # Normalize line endings and strip zero-width characters
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\u200b\u200c\u200d\ufeff\u00ad]", "", text)

    return text[:SNIPPET_LENGTH].replace("\n", " ").strip()


def _build_content_type_string(bodystructure: Any) -> str:
    """Build a Content-Type header string from a parsed BODYSTRUCTURE.

    For multipart messages, includes the boundary parameter.
    For simple messages, returns type/subtype with charset if present.

    Args:
        bodystructure: Parsed BODYSTRUCTURE from imapclient.

    Returns:
        Content-Type string (e.g. "multipart/alternative; boundary=xyz").
    """
    # Multipart: first element is a list of child parts
    if isinstance(bodystructure[0], list):
        subtype = bodystructure[1]
        if isinstance(subtype, bytes):
            subtype = subtype.decode("ascii", errors="replace").lower()

        # Boundary is in the params (index 2 for multipart)
        boundary = ""
        params = bodystructure[2] if len(bodystructure) > 2 else None
        if params:
            param_list = list(params) if isinstance(params, tuple) else params
            for j in range(0, len(param_list) - 1, 2):
                key = param_list[j]
                if isinstance(key, bytes):
                    key = key.decode("ascii", errors="replace")
                if key.upper() == "BOUNDARY":
                    val = param_list[j + 1]
                    if isinstance(val, bytes):
                        val = val.decode("ascii", errors="replace")
                    boundary = val

        ct = f"multipart/{subtype}"
        if boundary:
            ct += f'; boundary="{boundary}"'
        return ct

    # Simple: (type, subtype, params, ...)
    main_type = bodystructure[0]
    sub_type = bodystructure[1]
    if isinstance(main_type, bytes):
        main_type = main_type.decode("ascii", errors="replace").lower()
    if isinstance(sub_type, bytes):
        sub_type = sub_type.decode("ascii", errors="replace").lower()

    ct = f"{main_type}/{sub_type}"

    # Include charset if present (index 2 for simple parts)
    params = bodystructure[2] if len(bodystructure) > 2 else None
    if params:
        param_list = list(params) if isinstance(params, tuple) else params
        for j in range(0, len(param_list) - 1, 2):
            key = param_list[j]
            if isinstance(key, bytes):
                key = key.decode("ascii", errors="replace")
            if key.upper() == "CHARSET":
                val = param_list[j + 1]
                if isinstance(val, bytes):
                    val = val.decode("ascii", errors="replace")
                ct += f"; charset={val}"

    return ct


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
    Prefers plain text; falls back to HTML-to-markdown via markdownify.

    Args:
        raw_source: Raw email source bytes or string.

    Returns:
        Plain text body content, or HTML converted to markdown.
    """
    if not raw_source:
        return ""

    source_bytes = raw_source if isinstance(raw_source, bytes) else raw_source.encode("utf-8")
    msg = email.message_from_bytes(source_bytes, policy=email.policy.default)

    body = ""

    # Try plain text first
    plain_part = msg.get_body(preferencelist=("plain",))
    if plain_part:
        content = plain_part.get_content()
        if isinstance(content, str) and content.strip():
            body = content.strip()

    # Fall back to HTML, converted to markdown (strip images)
    if not body:
        html_part = msg.get_body(preferencelist=("html",))
        if html_part:
            html_content = html_part.get_content()
            if isinstance(html_content, str) and html_content.strip():
                body = markdownify(html_content, strip=["img"]).strip()

    # Normalize CRLF line endings (RFC 5322 uses \r\n)
    body = body.replace("\r\n", "\n").replace("\r", "\n")

    # Strip zero-width characters (marketers stuff these into emails)
    import re
    body = re.sub(r"[\u200b\u200c\u200d\ufeff\u00ad]", "", body)
    body = re.sub(r"  +", " ", body)

    return body.strip()


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
