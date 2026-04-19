"""
Contact extraction and Supabase sync (provider-aware).

Scans mailbox data from either IMAP ENVELOPE headers or Unipile API
to build a per-user contacts index in Supabase. Supports full and
incremental sync with a cooldown to prevent concurrent scans.

- full_sync: scan last N inbox + sent emails, upsert all contacts
- incremental_sync: scan only emails newer than the most recent contact
- delete_user_contacts: wipe contacts when inbox is changed/removed
- extract_contacts_from_imap: low-level ENVELOPE scanning and deduplication
- _extract_contacts_from_unipile: Unipile API-based contact extraction
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import date, datetime, timezone, timedelta
from typing import Any, cast

from imapclient import IMAPClient
from supabase import Client

from src.session import EmailAccount, ImapConfig
from src.tools.email_client import (
    create_imap_connection,
    close_imap_connection,
    resolve_special_use_folder,
)

logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

SYNC_COOLDOWN_SECONDS = 300
SCAN_LIMIT = 500


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class ContactRecord:
    """A contact extracted from email headers.

    Args:
        email: The contact's email address.
        display_name: The contact's display name, or None if unavailable.
        frequency: Number of times this contact appeared in scanned emails.
        last_seen_at: Timestamp of the most recent email involving this contact.
    """

    email: str
    display_name: str | None
    frequency: int
    last_seen_at: datetime


# ============================================================================
# MAIN FUNCTIONS
# ============================================================================

def full_sync(account: EmailAccount, user_id: str, supabase: Client) -> int:
    """Run a full contact sync: scan last SCAN_LIMIT inbox + sent emails.

    Checks contacts_synced_at cooldown first. If within SYNC_COOLDOWN_SECONDS,
    returns 0. Otherwise claims the sync slot, scans the mailbox via the
    appropriate provider, and upserts contacts.

    Args:
        account: The user's active email account (custom or Unipile).
        user_id: The user to sync contacts for.
        supabase: Supabase service-role client.

    Returns:
        Number of contacts upserted, or 0 if skipped due to cooldown.
    """
    if not _claim_sync_slot(user_id, supabase):
        return 0

    logger.info("[contact_sync] Full sync started for user %s (provider=%s)", user_id, account.provider)

    try:
        if account.connection_type == "unipile":
            contacts = _extract_contacts_from_unipile(account, limit=SCAN_LIMIT, since=None)
        else:
            contacts = _extract_contacts_from_custom(account, limit=SCAN_LIMIT, since=None)

        count = _upsert_contacts(contacts, user_id, supabase)
        logger.info("[contact_sync] Full sync completed for user %s: %d contacts", user_id, count)
        return count
    except Exception:
        _release_sync_slot(user_id, supabase)
        raise


def incremental_sync(account: EmailAccount, user_id: str, supabase: Client) -> int:
    """Run an incremental contact sync: scan only emails newer than the latest contact.

    If no contacts exist yet (first-time user), skips entirely. Checks cooldown
    before proceeding.

    Args:
        account: The user's active email account (custom or Unipile).
        user_id: The user to sync contacts for.
        supabase: Supabase service-role client.

    Returns:
        Number of contacts upserted, or 0 if skipped.
    """
    # Find the most recent last_seen_at from existing contacts
    result = (
        supabase.table("user_contacts")
        .select("last_seen_at")
        .eq("user_id", user_id)
        .order("last_seen_at", desc=True)
        .limit(1)
        .execute()
    )

    if not result.data:
        # No contacts yet -- skip incremental sync
        return 0

    if not _claim_sync_slot(user_id, supabase):
        return 0

    logger.info("[contact_sync] Incremental sync started for user %s (provider=%s)", user_id, account.provider)

    row = cast(dict[str, Any], result.data[0])
    last_seen_str = cast(str, row["last_seen_at"])
    last_seen = datetime.fromisoformat(last_seen_str)
    since_date = last_seen.date()

    try:
        if account.connection_type == "unipile":
            contacts = _extract_contacts_from_unipile(account, limit=SCAN_LIMIT, since=since_date)
        else:
            contacts = _extract_contacts_from_custom(account, limit=SCAN_LIMIT, since=since_date)

        count = _upsert_contacts(contacts, user_id, supabase)
        logger.info("[contact_sync] Incremental sync completed for user %s: %d contacts", user_id, count)
        return count
    except Exception:
        _release_sync_slot(user_id, supabase)
        raise


def delete_user_contacts(user_id: str, supabase: Client) -> None:
    """Delete all contacts for a user. Called when inbox is changed or removed.

    Args:
        user_id: The user whose contacts to delete.
        supabase: Supabase service-role client.
    """
    supabase.table("user_contacts").delete().eq("user_id", user_id).execute()


def extract_contacts_from_imap(
    client: IMAPClient,
    folders: list[str],
    limit: int,
    since: date | None,
) -> list[ContactRecord]:
    """Scan IMAP ENVELOPE data from specified folders and extract contacts.

    For INBOX, extracts From addresses. For Sent folders, extracts To/CC addresses.
    Deduplicates by email, summing frequency and keeping the latest last_seen_at.

    Args:
        client: Connected IMAPClient.
        folders: List of folder names to scan (e.g. ["INBOX", "[Gmail]/Sent Mail"]).
        limit: Maximum number of emails to scan per folder.
        since: Only scan emails since this date, or None for no date filter.

    Returns:
        Deduplicated list of ContactRecord with frequency counts.
    """
    # Accumulate contacts keyed by lowercase email
    contacts_map: dict[str, ContactRecord] = {}

    for folder in folders:
        is_sent = folder != "INBOX"

        try:
            client.select_folder(folder, readonly=True)
        except Exception as exc:
            logger.warning("[contact_sync] Could not select folder %s: %s", folder, exc)
            continue

        # Build search criteria
        if since is not None:
            uids = client.search(["SINCE", since])  # type: ignore[arg-type]
        else:
            uids = client.search(["ALL"])  # type: ignore[arg-type]

        if not uids:
            continue

        # Take only the most recent `limit` emails
        uids = uids[-limit:]

        # Fetch ENVELOPE data only (fast, pre-parsed by server)
        fetch_data = client.fetch(uids, ["ENVELOPE"])

        for uid, data in fetch_data.items():
            envelope: Any = data.get(b"ENVELOPE")
            if not envelope:
                continue

            # Determine the envelope date for last_seen_at
            env_date = envelope.date or datetime.now(timezone.utc)
            if env_date.tzinfo is None:
                env_date = env_date.replace(tzinfo=timezone.utc)

            # Extract addresses: From for inbox, To/CC for sent
            if is_sent:
                address_lists = [envelope.to, envelope.cc]
            else:
                address_lists = [envelope.from_]

            for addr_list in address_lists:
                if not addr_list:
                    continue
                for addr in addr_list:
                    parsed = _parse_envelope_address(addr)
                    if parsed is None:
                        continue

                    display_name, email_addr = parsed
                    key = email_addr.lower()

                    if key in contacts_map:
                        existing = contacts_map[key]
                        existing.frequency += 1
                        if env_date > existing.last_seen_at:
                            existing.last_seen_at = env_date
                            # Update display_name to the most recent non-None value
                            if display_name is not None:
                                existing.display_name = display_name
                    else:
                        contacts_map[key] = ContactRecord(
                            email=email_addr.lower(),
                            display_name=display_name,
                            frequency=1,
                            last_seen_at=env_date,
                        )

    return list(contacts_map.values())


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _extract_contacts_from_custom(
    account: EmailAccount,
    limit: int,
    since: date | None,
) -> list[ContactRecord]:
    """Extract contacts from a custom IMAP account.

    Opens an IMAP connection, scans INBOX + Sent folders, then closes.

    Args:
        account: The custom email account (must have imap_config).
        limit: Maximum number of emails to scan per folder.
        since: Only scan emails since this date, or None for no date filter.

    Returns:
        Deduplicated list of ContactRecord.

    Raises:
        RuntimeError: If the account has no IMAP config.
    """
    if not account.imap_config:
        raise RuntimeError("Custom account has no IMAP config for contact sync")

    client = create_imap_connection(account.imap_config)
    try:
        sent_folder = resolve_special_use_folder(client, b"\\Sent")
        folders = ["INBOX", sent_folder]
        return extract_contacts_from_imap(client, folders, limit=limit, since=since)
    finally:
        close_imap_connection(client)


def _extract_contacts_from_unipile(
    account: EmailAccount,
    limit: int,
    since: date | None,
) -> list[ContactRecord]:
    """Extract contacts from a Unipile-backed email account.

    Lists recent inbox and sent emails via the Unipile API, then extracts
    contact information from the from/to fields.

    Args:
        account: The Unipile email account (must have unipile_account_id).
        limit: Maximum number of emails to fetch per folder.
        since: Only include emails since this date, or None for no date filter.

    Returns:
        Deduplicated list of ContactRecord.

    Raises:
        RuntimeError: If the account has no unipile_account_id.
    """
    if not account.unipile_account_id:
        raise RuntimeError("Unipile account has no unipile_account_id for contact sync")

    # Run async Unipile calls from sync context
    return asyncio.run(_extract_contacts_from_unipile_async(
        account.unipile_account_id, limit, since
    ))


async def _extract_contacts_from_unipile_async(
    account_id: str,
    limit: int,
    since: date | None,
) -> list[ContactRecord]:
    """Async implementation of Unipile contact extraction.

    Fetches inbox emails (extracts From addresses) and sent emails
    (extracts To addresses) from the Unipile API.

    Args:
        account_id: The Unipile account ID.
        limit: Maximum number of emails to fetch per folder.
        since: Only include emails since this date, or None for no date filter.

    Returns:
        Deduplicated list of ContactRecord.
    """
    from src.tools.unipile_client import _request

    contacts_map: dict[str, ContactRecord] = {}

    # Fetch inbox emails (extract From addresses)
    inbox_params: dict[str, Any] = {
        "account_id": account_id,
        "limit": limit,
        "folder": "INBOX",
    }
    inbox_data = await _request("GET", "/api/v1/emails", params=inbox_params)
    inbox_items = inbox_data.get("items", [])

    for item in inbox_items:
        item_date = _parse_unipile_date(item.get("date"))
        if since is not None and item_date.date() < since:
            continue

        from_obj = item.get("from", {})
        _accumulate_unipile_address(contacts_map, from_obj, item_date)

    # Fetch sent emails (extract To addresses)
    sent_params: dict[str, Any] = {
        "account_id": account_id,
        "limit": limit,
        "folder": "SENT",
    }
    sent_data = await _request("GET", "/api/v1/emails", params=sent_params)
    sent_items = sent_data.get("items", [])

    for item in sent_items:
        item_date = _parse_unipile_date(item.get("date"))
        if since is not None and item_date.date() < since:
            continue

        to_list = item.get("to", [])
        if isinstance(to_list, list):
            for to_obj in to_list:
                _accumulate_unipile_address(contacts_map, to_obj, item_date)

        cc_list = item.get("cc", [])
        if isinstance(cc_list, list):
            for cc_obj in cc_list:
                _accumulate_unipile_address(contacts_map, cc_obj, item_date)

    return list(contacts_map.values())


def _accumulate_unipile_address(
    contacts_map: dict[str, ContactRecord],
    addr_obj: Any,
    item_date: datetime,
) -> None:
    """Accumulate a contact from a Unipile address object into the contacts map.

    Args:
        contacts_map: Mutable map of lowercase email -> ContactRecord.
        addr_obj: Unipile address object (dict with "identifier" and/or "display_name").
        item_date: Timestamp of the email this address came from.
    """
    if not isinstance(addr_obj, dict):
        return

    email_addr = addr_obj.get("identifier", "")
    if not email_addr or not isinstance(email_addr, str):
        return

    display_name = addr_obj.get("display_name")
    if display_name and isinstance(display_name, str):
        display_name = display_name.strip() or None
    else:
        display_name = None

    key = email_addr.lower()

    if key in contacts_map:
        existing = contacts_map[key]
        existing.frequency += 1
        if item_date > existing.last_seen_at:
            existing.last_seen_at = item_date
            if display_name is not None:
                existing.display_name = display_name
    else:
        contacts_map[key] = ContactRecord(
            email=email_addr.lower(),
            display_name=display_name,
            frequency=1,
            last_seen_at=item_date,
        )


def _parse_unipile_date(date_str: Any) -> datetime:
    """Parse a date string from the Unipile API into a timezone-aware datetime.

    Args:
        date_str: Date string from Unipile, or None.

    Returns:
        Timezone-aware datetime (defaults to now in UTC if unparseable).
    """
    if not date_str or not isinstance(date_str, str):
        return datetime.now(timezone.utc)

    try:
        parsed = datetime.fromisoformat(date_str)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    except ValueError:
        return datetime.now(timezone.utc)


def _parse_envelope_address(addr: Any) -> tuple[str | None, str] | None:
    """Extract display name and email from an IMAP ENVELOPE address tuple.

    ENVELOPE addresses follow RFC 3501: (name, route, mailbox, host).

    Args:
        addr: An address tuple from the IMAP ENVELOPE response.

    Returns:
        Tuple of (display_name, email) where display_name may be None.
        Returns None if the address cannot be parsed (missing mailbox or host).
    """
    mailbox = addr.mailbox
    host = addr.host

    if not mailbox or not host:
        return None

    # Decode bytes to str
    if isinstance(mailbox, bytes):
        mailbox = mailbox.decode("utf-8", errors="replace")
    if isinstance(host, bytes):
        host = host.decode("utf-8", errors="replace")

    email_addr = f"{mailbox}@{host}"

    display_name: str | None = None
    if addr.name:
        name_raw = addr.name
        if isinstance(name_raw, bytes):
            name_raw = name_raw.decode("utf-8", errors="replace")
        display_name = name_raw.strip() or None

    return (display_name, email_addr)


def _upsert_contacts(contacts: list[ContactRecord], user_id: str, supabase: Client) -> int:
    """Upsert contacts into the user_contacts table.

    On conflict (user_id, email), updates display_name to the most recent,
    adds frequency, and updates last_seen_at if newer.

    Args:
        contacts: List of ContactRecord to upsert.
        user_id: The user these contacts belong to.
        supabase: Supabase service-role client.

    Returns:
        Number of contacts upserted.
    """
    if not contacts:
        return 0

    count = 0
    for contact in contacts:
        row = {
            "user_id": user_id,
            "email": contact.email,
            "display_name": contact.display_name,
            "frequency": contact.frequency,
            "last_seen_at": contact.last_seen_at.isoformat(),
        }

        supabase.table("user_contacts").upsert(
            row,
            on_conflict="user_id,email",
        ).execute()

        count += 1

    return count


def _claim_sync_slot(user_id: str, supabase: Client) -> bool:
    """Atomically claim the sync slot using contacts_synced_at cooldown.

    Uses an atomic UPDATE with a WHERE clause to prevent TOCTOU races.
    If another sync is already running (synced_at is within the cooldown),
    returns False.

    Args:
        user_id: The user to claim the sync slot for.
        supabase: Supabase service-role client.

    Returns:
        True if the slot was claimed, False if another sync is active.
    """
    now = datetime.now(timezone.utc)
    threshold = now - timedelta(seconds=SYNC_COOLDOWN_SECONDS)

    now_iso = now.isoformat()
    threshold_iso = threshold.isoformat()

    result = (
        supabase.table("user_settings")
        .update({"contacts_synced_at": now_iso})
        .eq("user_id", user_id)
        .or_(f"contacts_synced_at.is.null,contacts_synced_at.lt.{threshold_iso}")
        .execute()
    )

    if not result.data:
        return False

    return True


def _release_sync_slot(user_id: str, supabase: Client) -> None:
    """Reset contacts_synced_at to null so future syncs are not blocked.

    Called when a sync fails before doing any real work (e.g. bad credentials).

    Args:
        user_id: The user whose sync slot to release.
        supabase: Supabase service-role client.
    """
    supabase.table("user_settings").update(
        {"contacts_synced_at": None}
    ).eq("user_id", user_id).execute()
