"""
Unipile REST client for voice-side email operations.

Thin async wrapper around the Unipile API for email actions needed
by the voice pipeline. Maps Unipile responses to the same dataclasses
used by email_client.py so tool handlers are provider-agnostic.

- list_inbox: fetch inbox email summaries
- search_emails: search emails by query
- read_email: fetch full email content
- archive_email: archive an email
- delete_email: delete an email
- send_email: send a new email
- save_draft: create a draft email
- list_folders: list account folders
- move_to_folder: move an email to a folder
- batch_move_to_folder: move multiple emails to a folder in one call
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx

from src.tools.email_client import Email, EmailSummary, FolderInfo

logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

UNIPILE_API_KEY = os.environ.get("UNIPILE_API_KEY", "")
UNIPILE_DSN = os.environ.get("UNIPILE_DSN", "")

# Timeout for Unipile API calls (seconds)
REQUEST_TIMEOUT = 15.0


# ============================================================================
# TYPES
# ============================================================================

# UndoRecipe is a dict with "operation" and "params" keys, matching handlers.py
UndoRecipe = dict[str, Any]


# ============================================================================
# MAIN HANDLERS
# ============================================================================

async def list_inbox(account_id: str, limit: int) -> list[EmailSummary]:
    """Retrieve inbox email summaries through Unipile.

    Args:
        account_id: The Unipile account ID.
        limit: Maximum number of emails to return.

    Returns:
        List of EmailSummary in reverse chronological order.
    """
    inbox_id = await _resolve_inbox_folder_provider_id(account_id)
    params: dict[str, Any] = {
        "account_id": account_id,
        "limit": limit,
        "folder": inbox_id,
    }

    data = await _request("GET", "/api/v1/emails", params=params)
    items = data.get("items", [])
    return [_map_to_email_summary(item) for item in items]


async def search_emails(account_id: str, query: str) -> list[EmailSummary]:
    """Search emails through Unipile using the shared voice email return shape.

    Args:
        account_id: The Unipile account ID.
        query: Search query string.

    Returns:
        List of matching EmailSummary.
    """
    params: dict[str, Any] = {
        "account_id": account_id,
        "q": query,
    }

    data = await _request("GET", "/api/v1/emails", params=params)
    items = data.get("items", [])
    return [_map_to_email_summary(item) for item in items]


async def read_email(account_id: str, email_id: str) -> Email:
    """Load one email through Unipile.

    Args:
        account_id: The Unipile account ID.
        email_id: The Unipile email ID.

    Returns:
        Full Email content.
    """
    data = await _request("GET", f"/api/v1/emails/{email_id}", params={"account_id": account_id})

    return Email(
        id=str(data.get("provider_id", data.get("id", email_id))),
        from_addr=_extract_address(data.get("from_attendee", {})),
        to=_extract_address(data.get("to_attendees", [{}])[0] if data.get("to_attendees") else {}),
        subject=str(data.get("subject", "")),
        body=str(data.get("body_plain", "") or data.get("body", "")),
        date=str(data.get("date", "")),
        is_read=data.get("read_date") is not None,
    )


async def archive_email(
    account_id: str,
    email_id: str,
    source_folder: str | None,
    provider: str,
) -> tuple[UndoRecipe | None, str | None]:
    """Archive an email through Unipile.

    Args:
        account_id: The Unipile account ID.
        email_id: The Unipile email ID.
        source_folder: The folder the email is currently in (for undo).
        provider: Email provider ("gmail" or "outlook").

    Returns:
        Tuple of (undo recipe dict, message_id or None).
    """
    # For Outlook: fetch the stable RFC Message-ID BEFORE moving
    rfc_message_id: str | None = None
    if provider == "outlook":
        rfc_message_id = await _get_rfc_message_id(account_id, email_id)

    # Outlook has role "archive"; Gmail does not -- use folders: [] to remove from inbox
    try:
        archive_folder_id = await _resolve_folder_by_role(account_id, "archive")
        folders = [archive_folder_id]
    except RuntimeError:
        archive_folder_id = None
        folders = []

    body: dict[str, Any] = {"folders": folders}
    await _request("PUT", f"/api/v1/emails/{email_id}", params={"account_id": account_id}, json_body=body)

    inbox_folder_id = await _resolve_folder_by_role(account_id, "inbox")
    undo_params: dict[str, Any] = {
        "account_id": account_id,
        "email_id": email_id,
        "to_folders": [inbox_folder_id],
    }
    if rfc_message_id is not None:
        undo_params["rfc_message_id"] = rfc_message_id

    undo_recipe: UndoRecipe = {
        "operation": "unipile_move_email",
        "params": undo_params,
    }
    return undo_recipe, None


async def delete_email(
    account_id: str,
    email_id: str,
    source_folder: str | None,
    provider: str,
) -> tuple[UndoRecipe | None, str | None]:
    """Delete an email through Unipile (moves to Trash via PUT).

    Uses PUT with folders=[trash_folder_id] instead of DELETE, because
    DELETE permanently removes the email and makes undo impossible.

    Args:
        account_id: The Unipile account ID.
        email_id: The Unipile email ID.
        source_folder: The folder the email is currently in (for undo).
        provider: Email provider ("gmail" or "outlook").

    Returns:
        Tuple of (undo recipe dict, message_id or None).
    """
    # For Outlook: fetch the stable RFC Message-ID BEFORE moving
    rfc_message_id: str | None = None
    if provider == "outlook":
        rfc_message_id = await _get_rfc_message_id(account_id, email_id)

    trash_folder_id = await _resolve_folder_by_role(account_id, "trash")
    body: dict[str, Any] = {"folders": [trash_folder_id]}
    await _request("PUT", f"/api/v1/emails/{email_id}", params={"account_id": account_id}, json_body=body)

    inbox_folder_id = await _resolve_folder_by_role(account_id, "inbox")
    undo_params: dict[str, Any] = {
        "account_id": account_id,
        "email_id": email_id,
        "to_folders": [inbox_folder_id],
    }
    if rfc_message_id is not None:
        undo_params["rfc_message_id"] = rfc_message_id

    undo_recipe: UndoRecipe = {
        "operation": "unipile_move_email",
        "params": undo_params,
    }
    return undo_recipe, None


async def send_email(account_id: str, to: str, subject: str, body: str) -> None:
    """Send an email through Unipile.

    Args:
        account_id: The Unipile account ID.
        to: Recipient email address.
        subject: Email subject line.
        body: Email body text.
    """
    payload: dict[str, Any] = {
        "account_id": account_id,
        "to": [{"identifier": to}],
        "subject": subject,
        "body": body,
    }
    await _request("POST", "/api/v1/emails", json_body=payload)


async def save_draft(
    account_id: str,
    to: str,
    subject: str,
    body: str,
) -> UndoRecipe | None:
    """Create a draft through Unipile.

    Args:
        account_id: The Unipile account ID.
        to: Recipient email address.
        subject: Email subject line.
        body: Email body text.

    Returns:
        UndoRecipe dict for deleting the draft, or None.
    """
    payload: dict[str, Any] = {
        "account_id": account_id,
        "to": [{"identifier": to}],
        "subject": subject,
        "body": body,
    }
    data = await _request("POST", "/api/v1/drafts", json_body=payload)

    # POST /api/v1/drafts returns { "object": "DraftCreated", "draft_id": "..." }
    draft_id = data.get("draft_id") or data.get("id")
    if draft_id:
        return {
            "operation": "unipile_delete_draft",
            "params": {
                "account_id": account_id,
                "draft_id": str(draft_id),
            },
        }
    return None


async def list_folders(account_id: str) -> list[FolderInfo]:
    """List all folders for a Unipile account (excluding INBOX).

    Args:
        account_id: The Unipile account ID.

    Returns:
        List of FolderInfo for each folder.
    """
    data = await _request("GET", "/api/v1/folders", params={"account_id": account_id})
    items = data.get("items", data if isinstance(data, list) else [])

    results: list[FolderInfo] = []
    for f in items:
        name = f.get("name", "")
        if (f.get("role") or "").lower() == "inbox":
            continue
        # Unipile returns role for special-use (e.g. "TRASH", "DRAFTS", "SENT")
        role = f.get("role")
        special_use = f"\\{role.capitalize()}" if role else None
        results.append(FolderInfo(
            path=f.get("provider_id", f.get("id", name)),
            name=name,
            special_use=special_use,
        ))

    return results


async def move_to_folder(
    account_id: str,
    email_id: str,
    target_folder: str,
    source_folder: str,
    provider: str,
) -> tuple[UndoRecipe | None, str | None]:
    """Move an email to a target folder through Unipile.

    Args:
        account_id: The Unipile account ID.
        email_id: The Unipile email ID.
        target_folder: Destination folder name.
        source_folder: The folder the email is currently in (for undo).
        provider: Email provider ("gmail" or "outlook").

    Returns:
        Tuple of (undo recipe dict, message_id or None).
    """
    # For Outlook: fetch the stable RFC Message-ID BEFORE moving
    rfc_message_id: str | None = None
    if provider == "outlook":
        rfc_message_id = await _get_rfc_message_id(account_id, email_id)

    body: dict[str, Any] = {"folders": [target_folder]}
    await _request("PUT", f"/api/v1/emails/{email_id}", params={"account_id": account_id}, json_body=body)

    # Resolve source folder for undo -- "INBOX" needs to be resolved to actual folder ID
    resolved_source = source_folder
    if source_folder == "INBOX":
        resolved_source = await _resolve_folder_by_role(account_id, "inbox")

    undo_params: dict[str, Any] = {
        "account_id": account_id,
        "email_id": email_id,
        "to_folders": [resolved_source],
    }
    if rfc_message_id is not None:
        undo_params["rfc_message_id"] = rfc_message_id

    undo_recipe: UndoRecipe = {
        "operation": "unipile_move_email",
        "params": undo_params,
    }
    return undo_recipe, None


async def batch_move_to_folder(
    account_id: str,
    email_ids: list[str],
    target_folder: str,
    source_folder: str,
    provider: str,
) -> list[dict[str, Any]]:
    """Move multiple emails to a target folder through Unipile.

    Resolves the source folder once, then moves all emails concurrently
    via asyncio.gather (safe because these are independent HTTP calls,
    not IMAP). Returns a result per email with undo recipe and
    success/failure status.

    Args:
        account_id: The Unipile account ID.
        email_ids: List of Unipile email IDs to move.
        target_folder: Destination folder name.
        source_folder: The folder the emails are currently in (for undo).
        provider: Email provider ("gmail" or "outlook").

    Returns:
        List of dicts, one per email_id, each containing:
        - email_id, succeeded, undo_recipe (or error on failure).
    """
    # Resolve source folder once for all undo recipes
    resolved_source = source_folder
    if source_folder == "INBOX":
        resolved_source = await _resolve_folder_by_role(account_id, "inbox")

    async def _move_single(email_id: str) -> dict[str, Any]:
        """Move a single email and return its result dict."""
        try:
            # For Outlook: fetch stable RFC Message-ID BEFORE moving
            rfc_message_id: str | None = None
            if provider == "outlook":
                rfc_message_id = await _get_rfc_message_id(account_id, email_id)

            await _request("PUT", f"/api/v1/emails/{email_id}", params={"account_id": account_id}, json_body={"folders": [target_folder]})

            undo_params: dict[str, Any] = {
                "account_id": account_id,
                "email_id": email_id,
                "to_folders": [resolved_source],
            }
            if rfc_message_id is not None:
                undo_params["rfc_message_id"] = rfc_message_id

            return {
                "email_id": email_id,
                "succeeded": True,
                "undo_recipe": {"operation": "unipile_move_email", "params": undo_params},
            }
        except Exception as e:
            return {
                "email_id": email_id,
                "succeeded": False,
                "error": str(e),
            }

    # Fire all moves concurrently -- these are independent HTTP requests
    results = await asyncio.gather(*[_move_single(eid) for eid in email_ids])
    return list(results)


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def _get_rfc_message_id(account_id: str, email_id: str) -> str:
    """Fetch the RFC 2822 Message-ID header for an email.

    Must be called BEFORE moving the email, because Outlook invalidates
    the old ID after a move.

    Args:
        account_id: The Unipile account ID.
        email_id: The email's provider_id.

    Returns:
        The Message-ID header value (e.g. "<abc@example.com>").

    Raises:
        RuntimeError: If the Message-ID header is not found.
    """
    data = await _request(
        "GET",
        f"/api/v1/emails/{email_id}",
        params={"account_id": account_id, "include_headers": "true"},
    )

    headers = data.get("headers", [])
    for header in headers:
        if header.get("name", "").lower() == "message-id":
            return header["value"]

    raise RuntimeError(
        f"Message-ID header not found for email {email_id} "
        f"(account {account_id})"
    )


async def _refind_email_by_message_id(account_id: str, rfc_message_id: str) -> str:
    """Re-find an email by its RFC Message-ID after a move.

    Outlook changes the Unipile id and provider_id when an email is moved.
    This function uses the stable RFC Message-ID to locate the email under
    its new Unipile internal ID.

    Args:
        account_id: The Unipile account ID.
        rfc_message_id: The RFC 2822 Message-ID header value.

    Returns:
        The Unipile internal ID (not provider_id) of the re-found email.

    Raises:
        RuntimeError: If no email is found with the given Message-ID.
    """
    data = await _request(
        "GET",
        "/api/v1/emails",
        params={"account_id": account_id, "message_id": rfc_message_id},
    )

    items = data.get("items", [])
    if not items:
        raise RuntimeError(
            f"No email found with Message-ID {rfc_message_id} "
            f"(account {account_id})"
        )

    return items[0]["id"]


async def undo_move_email(
    account_id: str,
    email_id: str,
    to_folders: list[str],
    rfc_message_id: str | None,
) -> None:
    """Undo a move by putting the email back into the original folders.

    For Outlook (rfc_message_id provided): re-finds the email by its
    stable RFC Message-ID first, since the original ID is stale after a move.
    For Gmail (rfc_message_id is None): uses the original email_id directly.

    Args:
        account_id: The Unipile account ID.
        email_id: The original email ID (provider_id) from the undo recipe.
        to_folders: Target folder IDs to move the email back to.
        rfc_message_id: RFC Message-ID for Outlook re-find, or None for Gmail.
    """
    # Outlook path: re-find the email under its new ID
    target_id = email_id
    if rfc_message_id is not None:
        target_id = await _refind_email_by_message_id(account_id, rfc_message_id)

    body: dict[str, Any] = {"folders": to_folders}
    await _request(
        "PUT",
        f"/api/v1/emails/{target_id}",
        params={"account_id": account_id},
        json_body=body,
    )


async def _resolve_folder_by_role(account_id: str, role: str) -> str:
    """Resolve a folder's provider_id by its role (e.g. 'inbox', 'trash', 'archive').

    The PUT /emails endpoint needs the provider_id (not the Unipile internal id)
    for the move to actually happen on the Exchange/Gmail side.

    Args:
        account_id: The Unipile account ID.
        role: The folder role to find.

    Returns:
        The folder's provider_id.
    """
    data = await _request("GET", "/api/v1/folders", params={"account_id": account_id})
    items = data.get("items", data if isinstance(data, list) else [])
    for f in items:
        if (f.get("role") or "").lower() == role.lower():
            return f["provider_id"]
    raise RuntimeError(f"No folder with role '{role}' found for Unipile account {account_id}")


async def _resolve_inbox_folder_provider_id(account_id: str) -> str:
    """Resolve the inbox folder provider_id for a Unipile account by looking up the folder with role 'inbox'.

    Args:
        account_id: The Unipile account ID.

    Returns:
        The provider_id for the inbox folder.
    """
    data = await _request("GET", "/api/v1/folders", params={"account_id": account_id})
    items = data.get("items", data if isinstance(data, list) else [])
    for f in items:
        if (f.get("role") or "").lower() == "inbox":
            return f["provider_id"]
    raise RuntimeError(f"No inbox folder found for Unipile account {account_id}")


async def _request(
    method: str,
    path: str,
    params: dict[str, Any] | None = None,
    json_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Make an authenticated request to the Unipile API.

    Args:
        method: HTTP method (GET, POST, PUT, DELETE).
        path: API path (e.g. "/api/v1/emails").
        params: Optional query parameters.
        json_body: Optional JSON request body.

    Returns:
        Parsed JSON response as a dict.

    Raises:
        RuntimeError: If UNIPILE_DSN or UNIPILE_API_KEY are not configured.
        RuntimeError: If the API returns an error status.
    """
    if not UNIPILE_DSN:
        raise RuntimeError("UNIPILE_DSN environment variable is not set")
    if not UNIPILE_API_KEY:
        raise RuntimeError("UNIPILE_API_KEY environment variable is not set")

    url = f"{UNIPILE_DSN}{path}"
    headers = {
        "X-API-KEY": UNIPILE_API_KEY,
        "Accept": "application/json",
    }

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        response = await client.request(
            method,
            url,
            headers=headers,
            params=params,
            json=json_body,
        )

    if response.status_code >= 400:
        raise RuntimeError(
            f"Unipile API error {response.status_code}: {response.text}"
        )

    return response.json()


def _map_to_email_summary(item: dict[str, Any]) -> EmailSummary:
    """Map a Unipile email list item to an EmailSummary dataclass.

    Args:
        item: A single email item from the Unipile API response.

    Returns:
        EmailSummary with fields mapped from the Unipile response.
    """
    from_obj = item.get("from_attendee", {})
    body_plain = str(item.get("body_plain", "") or "")
    snippet = body_plain[:100] if body_plain else ""

    return EmailSummary(
        id=str(item.get("provider_id", item.get("id", ""))),
        from_addr=_extract_address(from_obj),
        subject=str(item.get("subject", "")),
        snippet=snippet,
        date=str(item.get("date", "")),
    )


def _extract_address(addr_obj: dict[str, Any] | list | str) -> str:
    """Extract a display-friendly email address from a Unipile address object.

    Args:
        addr_obj: Address object from Unipile (dict with "identifier"/"display_name", or string).

    Returns:
        Formatted address string.
    """
    if isinstance(addr_obj, str):
        return addr_obj
    if isinstance(addr_obj, list):
        if not addr_obj:
            return ""
        addr_obj = addr_obj[0]
    if isinstance(addr_obj, dict):
        display_name = addr_obj.get("display_name", "")
        identifier = addr_obj.get("identifier", "")
        if display_name and identifier:
            return f"{display_name} <{identifier}>"
        return identifier or display_name or ""
    return str(addr_obj)
