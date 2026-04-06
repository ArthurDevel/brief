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
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from src.tools.email_client import Email, EmailSummary

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
    params: dict[str, Any] = {
        "account_id": account_id,
        "limit": limit,
        "folder": "INBOX",
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
) -> tuple[UndoRecipe | None, str | None]:
    """Archive an email through Unipile.

    Args:
        account_id: The Unipile account ID.
        email_id: The Unipile email ID.
        source_folder: The folder the email is currently in (for undo).

    Returns:
        Tuple of (undo recipe dict, message_id or None).
    """
    # Unipile folders is an array of label strings. Empty array removes from inbox.
    body: dict[str, Any] = {"folders": []}
    await _request("PUT", f"/api/v1/emails/{email_id}", params={"account_id": account_id}, json_body=body)

    undo_recipe: UndoRecipe = {
        "operation": "unipile_move_email",
        "params": {
            "account_id": account_id,
            "email_id": email_id,
            "to_folders": [source_folder or "INBOX"],
        },
    }
    return undo_recipe, None


async def delete_email(
    account_id: str,
    email_id: str,
    source_folder: str | None,
) -> tuple[UndoRecipe | None, str | None]:
    """Delete an email through Unipile (moves to Trash).

    Args:
        account_id: The Unipile account ID.
        email_id: The Unipile email ID.
        source_folder: The folder the email is currently in (for undo).

    Returns:
        Tuple of (undo recipe dict, message_id or None).
    """
    await _request("DELETE", f"/api/v1/emails/{email_id}", params={"account_id": account_id})

    undo_recipe: UndoRecipe = {
        "operation": "unipile_move_email",
        "params": {
            "account_id": account_id,
            "email_id": email_id,
            "to_folders": [source_folder or "INBOX"],
        },
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


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

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
