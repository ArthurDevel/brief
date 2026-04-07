"""
E2E tests for email tool dispatch across all provider/connection combos.

Tests _dispatch_tool and _dispatch_undo with real email accounts (same
accounts as the TypeScript e2e suite). Each account sends only to itself.
Each test run seeds its own data using a unique run ID.

Responsibilities:
- Seed each account with test emails before running assertions
- Verify _dispatch_tool produces correct results for all email operations
- Verify _dispatch_undo reverses mutations correctly
- Run the same tests against Gmail/Outlook x Unipile/IMAP
"""

from __future__ import annotations

import re
import time
from typing import Any
from unittest.mock import MagicMock

import pytest  # type: ignore[import-untyped]

from src.tools.handlers import _dispatch_tool, _dispatch_undo, UndoRecipe
from tests.e2e.conftest import (
    E2EAccount,
    TEST_RUN_ID,
    DELIVERY_WAIT_S,
    RETRY_WAIT_S,
    MAX_RETRIES,
)


# ============================================================================
# CONSTANTS
# ============================================================================

TAG = f"[{TEST_RUN_ID}]"
SEED_SUBJECT = f"{TAG} Seed email"
SEARCH_SUBJECT = f"{TAG} Searchable uniquetoken"

DUMMY_USER_ID = "e2e-test-user"


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def dispatch(
    tool_name: str,
    args: dict[str, Any],
    account: E2EAccount,
    supabase: MagicMock,
) -> tuple[dict[str, Any], UndoRecipe | None, str | None]:
    """Call _dispatch_tool with e2e defaults (no session, dummy user)."""
    return _dispatch_tool(
        tool_name=tool_name,
        args=args,
        email_ctx=account.email_ctx,
        supabase=supabase,
        user_id=DUMMY_USER_ID,
        session_id=None,
    )


def undo(recipe: UndoRecipe, account: E2EAccount, supabase: MagicMock) -> None:
    """Call _dispatch_undo with the given recipe."""
    _dispatch_undo(recipe, account.email_ctx, supabase)


def find_email_id_by_subject(
    account: E2EAccount,
    supabase: MagicMock,
    subject: str,
) -> str:
    """Search inbox for an email matching the subject. Retries for delivery delay.

    Args:
        account: The test account to search.
        supabase: Mock supabase client.
        subject: Subject substring to match.

    Returns:
        The email ID.

    Raises:
        RuntimeError: If not found after all retries.
    """
    for attempt in range(MAX_RETRIES):
        result, _, _ = dispatch("list_inbox", {"limit": 50}, account, supabase)
        markdown = result.get("markdown", "")

        # Parse email IDs and subjects from the markdown table
        email_id = _find_id_in_markdown(markdown, subject)
        if email_id:
            return email_id

        if attempt < MAX_RETRIES - 1:
            time.sleep(RETRY_WAIT_S)

    raise RuntimeError(
        f'Could not find email with subject containing "{subject}" after {MAX_RETRIES} attempts'
    )


def wait_until_gone_from_inbox(
    account: E2EAccount,
    supabase: MagicMock,
    subject: str,
) -> None:
    """Wait until an email with the given subject is no longer in the inbox.

    Args:
        account: The test account to check.
        supabase: Mock supabase client.
        subject: Subject substring to match.

    Raises:
        RuntimeError: If still present after all retries.
    """
    for attempt in range(MAX_RETRIES):
        result, _, _ = dispatch("list_inbox", {"limit": 50}, account, supabase)
        markdown = result.get("markdown", "")

        if subject not in markdown:
            return

        if attempt < MAX_RETRIES - 1:
            time.sleep(RETRY_WAIT_S)

    raise RuntimeError(
        f'Email with subject containing "{subject}" still in inbox after {MAX_RETRIES} attempts'
    )


def _find_id_in_markdown(markdown: str, subject: str) -> str | None:
    """Extract the email ID from a markdown bullet list matching the subject.

    The markdown format from format_email_summaries uses:
      - **[id:EMAIL_ID]** From: ...
        **Subject line**

    We look for the subject on a "  **Subject**" line, then grab the id
    from the preceding bullet line.

    Args:
        markdown: The markdown string from format_email_summaries.
        subject: Subject substring to find.

    Returns:
        The email ID or None if not found.
    """
    lines = markdown.split("\n")
    for i, line in enumerate(lines):
        # Subject lines look like: "  **Subject text here**"
        if subject in line and i > 0:
            # The id line is the previous line: "- **[id:XXXX]** From: ..."
            id_match = re.search(r"\[id:([^\]]+)\]", lines[i - 1])
            if id_match:
                return id_match.group(1)
    return None


# ============================================================================
# TEST SETUP (module-scoped seeding per account)
# ============================================================================

# Store seeded email IDs per account label
_seeded: dict[str, dict[str, str]] = {}


def _ensure_seeded(account: E2EAccount, supabase: MagicMock) -> dict[str, str]:
    """Seed test emails for the account if not already done.

    Sends 2 emails to self and waits for delivery. Returns dict with
    'seed_email_id' and 'search_email_id' (looked up by subject).
    """
    if account.label in _seeded:
        return _seeded[account.label]

    # Send seed emails
    dispatch("send_email", {
        "to": account.email_address,
        "subject": SEED_SUBJECT,
        "body": f"Seed body for {TEST_RUN_ID}",
    }, account, supabase)

    dispatch("send_email", {
        "to": account.email_address,
        "subject": SEARCH_SUBJECT,
        "body": f"Search body for {TEST_RUN_ID}",
    }, account, supabase)

    # Wait for delivery
    time.sleep(DELIVERY_WAIT_S)

    seed_email_id = find_email_id_by_subject(account, supabase, SEED_SUBJECT)

    _seeded[account.label] = {"seed_email_id": seed_email_id}
    return _seeded[account.label]


# ============================================================================
# TESTS: INBOX & SEARCH
# ============================================================================

class TestListInbox:
    def test_returns_markdown_with_emails(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        _ensure_seeded(account, mock_supabase)
        result, undo_recipe, _ = dispatch("list_inbox", {"limit": 20}, account, mock_supabase)

        assert "markdown" in result
        assert len(result["markdown"]) > 0
        assert undo_recipe is None

    def test_contains_seeded_email(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        _ensure_seeded(account, mock_supabase)
        result, _, _ = dispatch("list_inbox", {"limit": 50}, account, mock_supabase)

        assert TAG in result["markdown"]


class TestSearchEmails:
    def test_finds_searchable_email(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        _ensure_seeded(account, mock_supabase)
        result, _, _ = dispatch("search_emails", {"query": "uniquetoken"}, account, mock_supabase)

        assert SEARCH_SUBJECT in result["markdown"]


# ============================================================================
# TESTS: READ
# ============================================================================

class TestReadEmail:
    def test_returns_full_email_with_body(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        ids = _ensure_seeded(account, mock_supabase)
        result, _, _ = dispatch("read_email", {"email_id": ids["seed_email_id"]}, account, mock_supabase)

        markdown = result["markdown"]
        assert SEED_SUBJECT in markdown
        assert TEST_RUN_ID in markdown


# ============================================================================
# TESTS: FOLDERS
# ============================================================================

class TestListFolders:
    def test_returns_folders(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        result, _, _ = dispatch("list_folders", {}, account, mock_supabase)

        folders = result["folders"]
        assert len(folders) > 0
        assert "path" in folders[0]
        assert "name" in folders[0]
        assert "special_use" in folders[0]

    def test_contains_trash_folder(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        result, _, _ = dispatch("list_folders", {}, account, mock_supabase)

        folders = result["folders"]
        has_trash = any(
            f.get("special_use") and "trash" in f["special_use"].lower()
            for f in folders
        )
        assert has_trash, f"No trash folder found in: {[f['path'] for f in folders]}"


# ============================================================================
# TESTS: DRAFT LIFECYCLE
# ============================================================================

class TestDraftLifecycle:
    def test_draft_email_creates_and_undo_deletes(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        result, undo_recipe, _ = dispatch("draft_email", {
            "to": account.email_address,
            "subject": f"{TAG} Draft test",
            "body": f"Draft body {TEST_RUN_ID}",
        }, account, mock_supabase)

        assert result["drafted"] is True
        assert undo_recipe is not None

        # Undo (delete the draft)
        undo(undo_recipe, account, mock_supabase)


# ============================================================================
# TESTS: SEND
# ============================================================================

class TestSendEmail:
    def test_send_email_delivers_to_self(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        subject = f"{TAG} Send test {int(time.time() * 1000)}"
        result, _, _ = dispatch("send_email", {
            "to": account.email_address,
            "subject": subject,
            "body": "Send test body",
        }, account, mock_supabase)

        assert result["sent"] is True

        time.sleep(DELIVERY_WAIT_S)

        search_result, _, _ = dispatch("search_emails", {"query": subject}, account, mock_supabase)
        assert subject in search_result["markdown"]


# ============================================================================
# TESTS: ARCHIVE
# ============================================================================

class TestArchiveEmail:
    def test_archive_removes_from_inbox(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        subject = f"{TAG} Archive test {int(time.time() * 1000)}"
        dispatch("send_email", {
            "to": account.email_address,
            "subject": subject,
            "body": "Archive test body",
        }, account, mock_supabase)
        time.sleep(DELIVERY_WAIT_S)

        email_id = find_email_id_by_subject(account, mock_supabase, subject)

        result, undo_recipe, _ = dispatch("archive_email", {
            "email_id": email_id,
            "source_folder": "INBOX",
        }, account, mock_supabase)

        assert result["archived"] is True
        assert undo_recipe is not None
        wait_until_gone_from_inbox(account, mock_supabase, subject)

    def test_archive_undo_restores_to_inbox(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        if account.connection_type == "unipile":
            pytest.xfail("Unipile undo fails: Outlook IDs go stale after move (see #168)")

        subject = f"{TAG} Archive undo test {int(time.time() * 1000)}"
        dispatch("send_email", {
            "to": account.email_address,
            "subject": subject,
            "body": "Archive undo test body",
        }, account, mock_supabase)
        time.sleep(DELIVERY_WAIT_S)

        email_id = find_email_id_by_subject(account, mock_supabase, subject)

        _, undo_recipe, _ = dispatch("archive_email", {
            "email_id": email_id,
            "source_folder": "INBOX",
        }, account, mock_supabase)
        wait_until_gone_from_inbox(account, mock_supabase, subject)

        assert undo_recipe is not None, "archive_email should return an undo recipe"
        undo(undo_recipe, account, mock_supabase)

        restored_id = find_email_id_by_subject(account, mock_supabase, subject)
        assert restored_id


# ============================================================================
# TESTS: DELETE
# ============================================================================

class TestDeleteEmail:
    def test_delete_removes_from_inbox(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        subject = f"{TAG} Delete test {int(time.time() * 1000)}"
        dispatch("send_email", {
            "to": account.email_address,
            "subject": subject,
            "body": "Delete test body",
        }, account, mock_supabase)
        time.sleep(DELIVERY_WAIT_S)

        email_id = find_email_id_by_subject(account, mock_supabase, subject)

        result, undo_recipe, _ = dispatch("delete_email", {
            "email_id": email_id,
            "source_folder": "INBOX",
        }, account, mock_supabase)

        assert result["deleted"] is True
        assert undo_recipe is not None
        wait_until_gone_from_inbox(account, mock_supabase, subject)

    def test_delete_undo_restores_to_inbox(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        if account.connection_type == "unipile":
            pytest.xfail("Unipile undo fails: Outlook IDs go stale after move (see #168)")

        subject = f"{TAG} Delete undo test {int(time.time() * 1000)}"
        dispatch("send_email", {
            "to": account.email_address,
            "subject": subject,
            "body": "Delete undo test body",
        }, account, mock_supabase)
        time.sleep(DELIVERY_WAIT_S)

        email_id = find_email_id_by_subject(account, mock_supabase, subject)

        _, undo_recipe, _ = dispatch("delete_email", {
            "email_id": email_id,
            "source_folder": "INBOX",
        }, account, mock_supabase)
        wait_until_gone_from_inbox(account, mock_supabase, subject)

        assert undo_recipe is not None, "delete_email should return an undo recipe"
        undo(undo_recipe, account, mock_supabase)

        restored_id = find_email_id_by_subject(account, mock_supabase, subject)
        assert restored_id


# ============================================================================
# TESTS: MOVE TO FOLDER
# ============================================================================

class TestMoveToFolder:
    def test_move_to_folder_removes_from_inbox(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        subject = f"{TAG} Move test {int(time.time() * 1000)}"
        dispatch("send_email", {
            "to": account.email_address,
            "subject": subject,
            "body": "Move test body",
        }, account, mock_supabase)
        time.sleep(DELIVERY_WAIT_S)

        email_id = find_email_id_by_subject(account, mock_supabase, subject)

        folders_result, _, _ = dispatch("list_folders", {}, account, mock_supabase)
        folders = folders_result["folders"]
        trash = next(
            (f for f in folders if f.get("special_use") and "trash" in f["special_use"].lower()),
            None,
        )
        assert trash is not None, "No trash folder found"

        result, undo_recipe, _ = dispatch("move_to_folder", {
            "email_id": email_id,
            "folder": trash["path"],
            "source_folder": "INBOX",
        }, account, mock_supabase)

        assert result["moved"] is True
        assert undo_recipe is not None
        wait_until_gone_from_inbox(account, mock_supabase, subject)

    def test_move_to_folder_undo_restores_to_inbox(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        if account.connection_type == "unipile":
            pytest.xfail("Unipile undo fails: Outlook IDs go stale after move (see #168)")

        subject = f"{TAG} Move undo test {int(time.time() * 1000)}"
        dispatch("send_email", {
            "to": account.email_address,
            "subject": subject,
            "body": "Move undo test body",
        }, account, mock_supabase)
        time.sleep(DELIVERY_WAIT_S)

        email_id = find_email_id_by_subject(account, mock_supabase, subject)

        folders_result, _, _ = dispatch("list_folders", {}, account, mock_supabase)
        folders = folders_result["folders"]
        trash = next(
            (f for f in folders if f.get("special_use") and "trash" in f["special_use"].lower()),
            None,
        )
        assert trash is not None, "No trash folder found"

        _, undo_recipe, _ = dispatch("move_to_folder", {
            "email_id": email_id,
            "folder": trash["path"],
            "source_folder": "INBOX",
        }, account, mock_supabase)
        wait_until_gone_from_inbox(account, mock_supabase, subject)

        assert undo_recipe is not None, "move_to_folder should return an undo recipe"
        undo(undo_recipe, account, mock_supabase)

        restored_id = find_email_id_by_subject(account, mock_supabase, subject)
        assert restored_id

    def test_move_to_nonexistent_folder_raises(self, account: E2EAccount, mock_supabase: MagicMock) -> None:
        ids = _ensure_seeded(account, mock_supabase)
        bogus_folder = f"NONEXISTENT_{int(time.time() * 1000)}"

        with pytest.raises(ValueError, match="does not exist"):
            dispatch("move_to_folder", {
                "email_id": ids["seed_email_id"],
                "folder": bogus_folder,
                "source_folder": "INBOX",
            }, account, mock_supabase)

        # Verify email is still in inbox
        result, _, _ = dispatch("list_inbox", {"limit": 50}, account, mock_supabase)
        assert SEED_SUBJECT in result["markdown"]
