"""
Tests for the Unipile client draft and send operations.

CRITICAL: Unipile has two separate endpoints that behave very differently:
  - POST /api/v1/drafts  -> creates a draft (returns "DraftCreated" with draft_id)
  - POST /api/v1/emails  -> SENDS the email immediately (returns "EmailSent")

Previously we used POST /api/v1/emails with { draft: True } for drafts.
Unipile silently ignores that flag and sends the email anyway. This caused
every "save as draft" action (both voice pipeline and dashboard) to actually
send the email to the recipient.

These tests exist to prevent that regression. Do NOT change the endpoint
assertions without verifying against the real Unipile API.
"""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest  # type: ignore[import-untyped]

# Set required env vars before import
os.environ.setdefault("UNIPILE_API_KEY", "test-key")
os.environ.setdefault("UNIPILE_DSN", "https://test.unipile.com:1234")

from src.tools.unipile_client import save_draft, send_email


# ============================================================================
# CONSTANTS
# ============================================================================

TEST_ACCOUNT_ID = "test-account-id"


# ============================================================================
# TESTS
# ============================================================================

@pytest.mark.asyncio
async def test_save_draft_posts_to_drafts_endpoint():
    """save_draft must POST to /api/v1/drafts, not /api/v1/emails."""
    mock_request = AsyncMock(return_value={"object": "DraftCreated", "draft_id": "abc123"})

    with patch("src.tools.unipile_client._request", mock_request):
        await save_draft(TEST_ACCOUNT_ID, "to@example.com", "Subject", "Body")

    mock_request.assert_called_once()
    call_args = mock_request.call_args
    assert call_args[0][1] == "/api/v1/drafts", (
        f"Expected POST to /api/v1/drafts, got {call_args[0][1]}"
    )


@pytest.mark.asyncio
async def test_save_draft_payload_has_no_draft_flag():
    """save_draft must NOT include 'draft: True' in the payload."""
    mock_request = AsyncMock(return_value={"object": "DraftCreated", "draft_id": "abc123"})

    with patch("src.tools.unipile_client._request", mock_request):
        await save_draft(TEST_ACCOUNT_ID, "to@example.com", "Subject", "Body")

    payload = mock_request.call_args.kwargs.get("json_body")
    assert payload is not None, "json_body was not passed to _request"
    assert "draft" not in payload, (
        f"Payload should not contain 'draft' key, got: {payload}"
    )


@pytest.mark.asyncio
async def test_save_draft_reads_draft_id_from_response():
    """save_draft must read 'draft_id' from the DraftCreated response."""
    mock_request = AsyncMock(return_value={"object": "DraftCreated", "draft_id": "my-draft-999"})

    with patch("src.tools.unipile_client._request", mock_request):
        recipe = await save_draft(TEST_ACCOUNT_ID, "to@example.com", "Subject", "Body")

    assert recipe is not None
    assert recipe["params"]["draft_id"] == "my-draft-999"


@pytest.mark.asyncio
async def test_send_email_posts_to_emails_endpoint():
    """send_email must POST to /api/v1/emails, not /api/v1/drafts."""
    mock_request = AsyncMock(return_value={"object": "EmailSent", "tracking_id": "xyz"})

    with patch("src.tools.unipile_client._request", mock_request):
        await send_email(TEST_ACCOUNT_ID, "to@example.com", "Subject", "Body")

    mock_request.assert_called_once()
    call_args = mock_request.call_args
    assert call_args[0][1] == "/api/v1/emails", (
        f"Expected POST to /api/v1/emails, got {call_args[0][1]}"
    )
