"""
Gmail Archive Undo Investigation Script

Investigates why Gmail Unipile archive undo (PUT with folders) doesn't restore
the email to inbox. The PUT returns 200 but the email doesn't appear in inbox.

Tests three different folder identifier formats to find which one works:
  1. Unipile folder id (short internal ID)
  2. Folder provider_id (e.g. "INBOX")
  3. Hardcoded string "INBOX"

Usage: python3 test_gmail_archive_undo.py
Requires: .env file in the same directory with UNIPILE_API_KEY, UNIPILE_DSN,
          TEST_GMAIL_UNIPILE_ACCOUNT_ID, TEST_GMAIL_UNIPILE_EMAIL
"""

import asyncio
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

# ============================================================================
# CONSTANTS
# ============================================================================

SCRIPT_DIR = Path(__file__).parent
load_dotenv(SCRIPT_DIR / ".env")

API_KEY = os.environ["UNIPILE_API_KEY"]
BASE_URL = os.environ["UNIPILE_DSN"]
ACCOUNT_ID = os.environ["TEST_GMAIL_UNIPILE_ACCOUNT_ID"]
TEST_EMAIL = os.environ["TEST_GMAIL_UNIPILE_EMAIL"]

HEADERS = {
    "X-API-KEY": API_KEY,
    "Accept": "application/json",
    "Content-Type": "application/json",
}

WAIT_AFTER_SEND = 15
WAIT_AFTER_ACTION = 5


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================


def _print_section(title: str) -> None:
    """Print a section header for readability."""
    print(f"\n{'=' * 60}")
    print(f"  {title}")
    print(f"{'=' * 60}")


def _print_folders(folders: list[dict]) -> None:
    """Print all folders in a readable table format."""
    print(f"\n{'ID':<30} {'Name':<25} {'Role':<15} {'Provider ID'}")
    print("-" * 100)
    for f in folders:
        print(f"{f.get('id', 'N/A'):<30} {f.get('name', 'N/A'):<25} {f.get('role', 'N/A'):<15} {f.get('provider_id', 'N/A')}")


def _find_email_in_list(emails: list[dict], tag: str) -> dict | None:
    """Find the test email in a list by matching the tag in the subject."""
    for email in emails:
        if tag in (email.get("subject") or ""):
            return email
    return None


async def _api_get(client: httpx.AsyncClient, path: str) -> dict:
    """Make a GET request to the Unipile API."""
    url = f"{BASE_URL}{path}"
    resp = await client.get(url, headers=HEADERS)
    resp.raise_for_status()
    return resp.json()


async def _api_post(client: httpx.AsyncClient, path: str, body: dict) -> httpx.Response:
    """Make a POST request to the Unipile API. Returns raw response."""
    url = f"{BASE_URL}{path}"
    resp = await client.post(url, headers=HEADERS, json=body)
    return resp


async def _api_put(client: httpx.AsyncClient, path: str, body: dict) -> httpx.Response:
    """Make a PUT request to the Unipile API. Returns raw response."""
    url = f"{BASE_URL}{path}"
    resp = await client.put(url, headers=HEADERS, json=body)
    return resp


async def _list_inbox(client: httpx.AsyncClient) -> list[dict]:
    """List the most recent 10 emails in the inbox."""
    data = await _api_get(client, f"/api/v1/emails?account_id={ACCOUNT_ID}&limit=10")
    return data.get("items", [])


async def _check_inbox_for_tag(client: httpx.AsyncClient, tag: str) -> bool:
    """Check if the test email (by tag) is present in the inbox listing."""
    emails = await _list_inbox(client)
    found = _find_email_in_list(emails, tag)
    if found:
        print(f"  -> FOUND in inbox: {found.get('subject')}")
        return True
    else:
        print(f"  -> NOT found in inbox")
        return False


# ============================================================================
# MAIN LOGIC
# ============================================================================


async def main() -> None:
    async with httpx.AsyncClient(timeout=30.0) as client:

        # -- Step 1: List all folders -----------------------------------------
        _print_section("STEP 1: List ALL folders")

        folders_data = await _api_get(client, f"/api/v1/folders?account_id={ACCOUNT_ID}")
        folders = folders_data.get("items", [])
        _print_folders(folders)

        # Find inbox folder
        inbox_folder = next((f for f in folders if f.get("role") == "inbox"), None)
        if not inbox_folder:
            print("ERROR: No folder with role='inbox' found")
            sys.exit(1)

        inbox_unipile_id = inbox_folder["id"]
        inbox_provider_id = inbox_folder.get("provider_id", "")
        print(f"\nInbox Unipile ID: {inbox_unipile_id}")
        print(f"Inbox provider_id: {inbox_provider_id}")

        # Check for archive folder
        archive_folder = next((f for f in folders if f.get("role") == "archive"), None)
        if archive_folder:
            print(f"\nArchive folder found: id={archive_folder['id']}, provider_id={archive_folder.get('provider_id')}")
        else:
            print("\nNo folder with role='archive' found")

        # -- Step 2: Send test email to self ----------------------------------
        _print_section("STEP 2: Send test email to self")

        tag = f"undo-test-{int(time.time())}"
        subject = f"[{tag}] Gmail archive undo investigation"
        print(f"Sending to: {TEST_EMAIL}")
        print(f"Subject: {subject}")

        send_resp = await _api_post(client, "/api/v1/emails", {
            "account_id": ACCOUNT_ID,
            "to": [{"identifier": TEST_EMAIL}],
            "subject": subject,
            "body": "Test email for archive undo investigation",
        })
        print(f"Send response: {send_resp.status_code}")
        if not send_resp.is_success:
            print(f"Send failed: {send_resp.text}")
            sys.exit(1)

        # -- Step 3: Wait for email to arrive ---------------------------------
        _print_section("STEP 3: Wait for email to arrive in inbox")

        print(f"Waiting {WAIT_AFTER_SEND}s for delivery...")
        await asyncio.sleep(WAIT_AFTER_SEND)

        # -- Step 4: Find the email in inbox ----------------------------------
        _print_section("STEP 4: Find test email in inbox")

        emails = await _list_inbox(client)
        test_email = _find_email_in_list(emails, tag)

        if not test_email:
            print("ERROR: Test email not found in inbox after waiting")
            print("Subjects found:")
            for e in emails:
                print(f"  - {e.get('subject')}")
            sys.exit(1)

        email_id = test_email["id"]
        email_provider_id = test_email.get("provider_id", "")
        print(f"Found test email:")
        print(f"  id (Unipile):  {email_id}")
        print(f"  provider_id:   {email_provider_id}")
        print(f"  subject:       {test_email.get('subject')}")

        # -- Step 5: Archive the email ----------------------------------------
        _print_section("STEP 5: Archive (PUT with empty folders)")

        archive_resp = await _api_put(
            client,
            f"/api/v1/emails/{email_provider_id}?account_id={ACCOUNT_ID}",
            {"folders": []},
        )
        print(f"Archive response status: {archive_resp.status_code}")
        print(f"Archive response body:   {archive_resp.text}")

        # -- Step 6: Wait and verify email left inbox -------------------------
        _print_section("STEP 6: Verify email left inbox")

        print(f"Waiting {WAIT_AFTER_ACTION}s...")
        await asyncio.sleep(WAIT_AFTER_ACTION)

        still_in_inbox = await _check_inbox_for_tag(client, tag)
        if still_in_inbox:
            print("WARNING: Email is still in inbox after archive -- archive may not have worked")

        # -- Step 7: Undo attempt 1 -- Unipile folder ID ---------------------
        _print_section("STEP 7: Undo attempt 1 -- folders=[inbox_unipile_id]")

        print(f"Using inbox Unipile ID: {inbox_unipile_id}")
        undo1_resp = await _api_put(
            client,
            f"/api/v1/emails/{email_provider_id}?account_id={ACCOUNT_ID}",
            {"folders": [inbox_unipile_id]},
        )
        print(f"Response status: {undo1_resp.status_code}")
        print(f"Response body:   {undo1_resp.text}")

        print(f"\nWaiting {WAIT_AFTER_ACTION}s...")
        await asyncio.sleep(WAIT_AFTER_ACTION)

        found_after_1 = await _check_inbox_for_tag(client, tag)

        # -- Step 8: Undo attempt 2 -- folder provider_id --------------------
        if not found_after_1:
            _print_section("STEP 8: Undo attempt 2 -- folders=[inbox_provider_id]")

            print(f"Using inbox provider_id: {inbox_provider_id}")
            undo2_resp = await _api_put(
                client,
                f"/api/v1/emails/{email_provider_id}?account_id={ACCOUNT_ID}",
                {"folders": [inbox_provider_id]},
            )
            print(f"Response status: {undo2_resp.status_code}")
            print(f"Response body:   {undo2_resp.text}")

            print(f"\nWaiting {WAIT_AFTER_ACTION}s...")
            await asyncio.sleep(WAIT_AFTER_ACTION)

            found_after_2 = await _check_inbox_for_tag(client, tag)
        else:
            print("\n  Skipping attempt 2 -- email already restored")
            found_after_2 = True

        # -- Step 9: Undo attempt 3 -- hardcoded "INBOX" ---------------------
        if not found_after_2:
            _print_section("STEP 9: Undo attempt 3 -- folders=['INBOX'] (hardcoded)")

            print('Using hardcoded string: "INBOX"')
            undo3_resp = await _api_put(
                client,
                f"/api/v1/emails/{email_provider_id}?account_id={ACCOUNT_ID}",
                {"folders": ["INBOX"]},
            )
            print(f"Response status: {undo3_resp.status_code}")
            print(f"Response body:   {undo3_resp.text}")

            print(f"\nWaiting {WAIT_AFTER_ACTION}s...")
            await asyncio.sleep(WAIT_AFTER_ACTION)

            found_after_3 = await _check_inbox_for_tag(client, tag)
        else:
            print("\n  Skipping attempt 3 -- email already restored")
            found_after_3 = True

        # -- Summary ----------------------------------------------------------
        _print_section("SUMMARY")

        print(f"Inbox Unipile ID:  {inbox_unipile_id}")
        print(f"Inbox provider_id: {inbox_provider_id}")
        print(f"Email provider_id: {email_provider_id}")
        print()
        print(f"Attempt 1 (Unipile folder ID):  {'RESTORED' if found_after_1 else 'FAILED'}")
        print(f"Attempt 2 (folder provider_id): {'RESTORED' if found_after_2 and not found_after_1 else 'SKIPPED' if found_after_1 else 'FAILED'}")
        print(f"Attempt 3 (hardcoded 'INBOX'):  {'RESTORED' if found_after_3 and not found_after_2 else 'SKIPPED' if found_after_2 else 'FAILED'}")

        if not found_after_3:
            print("\nNone of the attempts restored the email to inbox.")
            print("The PUT may require a different payload format or Gmail may not support this operation via Unipile.")


if __name__ == "__main__":
    asyncio.run(main())
