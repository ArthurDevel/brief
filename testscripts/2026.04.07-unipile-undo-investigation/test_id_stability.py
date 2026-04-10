"""
Investigates whether Outlook/Gmail provider_id changes after an email is moved
(archived/trashed), and whether Unipile's internal id stays stable.

- Sends a test email to self
- Records id + provider_id
- Moves to trash
- Checks if old id / provider_id still resolve
- Attempts to move back to inbox using both identifiers

Run: python3 test_id_stability.py
"""

import asyncio
import os
import time
from pathlib import Path

from dotenv import load_dotenv
import httpx

# ============================================================================
# CONSTANTS
# ============================================================================

WAIT_AFTER_SEND_SECONDS = 15
WAIT_AFTER_MOVE_SECONDS = 5

load_dotenv(Path(__file__).parent / ".env")

UNIPILE_API_KEY = os.environ["UNIPILE_API_KEY"]
UNIPILE_DSN = os.environ["UNIPILE_DSN"].rstrip("/")

ACCOUNTS = [
    {
        "label": "Gmail Unipile",
        "account_id": os.environ["TEST_GMAIL_UNIPILE_ACCOUNT_ID"],
        "email": os.environ["TEST_GMAIL_UNIPILE_EMAIL"],
    },
    {
        "label": "Outlook Unipile",
        "account_id": os.environ["TEST_OUTLOOK_UNIPILE_ACCOUNT_ID"],
        "email": os.environ["TEST_OUTLOOK_UNIPILE_EMAIL"],
    },
]

HEADERS = {
    "X-API-KEY": UNIPILE_API_KEY,
    "Accept": "application/json",
    "Content-Type": "application/json",
}


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def api_get(client: httpx.AsyncClient, path: str) -> tuple[int, dict | str]:
    """GET request to Unipile. Returns (status_code, parsed_body)."""
    url = f"{UNIPILE_DSN}{path}"
    resp = await client.get(url, headers=HEADERS)
    try:
        body = resp.json()
    except Exception:
        body = resp.text
    return resp.status_code, body


async def api_post(client: httpx.AsyncClient, path: str, json_body: dict) -> tuple[int, dict | str]:
    """POST request to Unipile. Returns (status_code, parsed_body)."""
    url = f"{UNIPILE_DSN}{path}"
    resp = await client.post(url, headers=HEADERS, json=json_body)
    try:
        body = resp.json()
    except Exception:
        body = resp.text
    return resp.status_code, body


async def api_put(client: httpx.AsyncClient, path: str, json_body: dict) -> tuple[int, dict | str]:
    """PUT request to Unipile. Returns (status_code, parsed_body)."""
    url = f"{UNIPILE_DSN}{path}"
    resp = await client.put(url, headers=HEADERS, json=json_body)
    try:
        body = resp.json()
    except Exception:
        body = resp.text
    return resp.status_code, body


def snippet(body: dict | str, max_len: int = 120) -> str:
    """Return a short string representation of a response body."""
    text = str(body)
    if len(text) > max_len:
        return text[:max_len] + "..."
    return text


# ============================================================================
# MAIN LOGIC
# ============================================================================

async def test_account(client: httpx.AsyncClient, label: str, account_id: str, email: str) -> None:
    """
    Run the full id-stability test for a single Unipile account.

    Steps:
    1. Resolve inbox + trash folder IDs
    2. Send test email to self
    3. Wait, then find the email in inbox
    4. Move to trash
    5. Check if old identifiers still work
    6. Try to move back to inbox using old identifiers
    """
    print(f"\n{'=' * 60}")
    print(f"=== {label} ===")
    print(f"{'=' * 60}")

    # Step 1: Get folder IDs
    status, folders_data = await api_get(client, f"/api/v1/folders?account_id={account_id}")
    if status != 200 or not isinstance(folders_data, dict):
        print(f"ERROR: Failed to list folders (status={status}): {snippet(folders_data)}")
        return

    items: list[dict] = folders_data.get("items", [])
    inbox_folder = next((f for f in items if f.get("role") == "inbox"), None)
    trash_folder = next((f for f in items if f.get("role") == "trash"), None)

    if not inbox_folder or not trash_folder:
        print(f"ERROR: Could not find inbox or trash folder. Roles found: {[f.get('role') for f in items]}")
        return

    inbox_folder_id = inbox_folder["id"]
    trash_folder_id = trash_folder["id"]
    print(f"Inbox folder id: {inbox_folder_id}")
    print(f"Trash folder id: {trash_folder_id}")

    # Step 2: Send test email to self
    timestamp = int(time.time())
    subject = f"[test-ids] ID stability {timestamp}"
    print(f"\nSending test email: {subject}")

    send_status, send_body = await api_post(client, "/api/v1/emails", {
        "account_id": account_id,
        "to": [{"identifier": email}],
        "subject": subject,
        "body": "test body for id stability investigation",
    })
    if send_status not in (200, 201):
        print(f"ERROR: Failed to send email (status={send_status}): {snippet(send_body)}")
        return
    print(f"Send response: status={send_status}")

    # Step 3: Wait for email to arrive
    print(f"\nWaiting {WAIT_AFTER_SEND_SECONDS}s for email to arrive...")
    await asyncio.sleep(WAIT_AFTER_SEND_SECONDS)

    # Step 4: Find test email in inbox
    list_status, list_body = await api_get(client, f"/api/v1/emails?account_id={account_id}&limit=10")
    if list_status != 200 or not isinstance(list_body, dict):
        print(f"ERROR: Failed to list inbox (status={list_status}): {snippet(list_body)}")
        return

    emails: list[dict] = list_body.get("items", [])
    test_email = next((e for e in emails if subject in e.get("subject", "")), None)

    if not test_email:
        print(f"ERROR: Test email not found in inbox. Subjects: {[e.get('subject', '') for e in emails]}")
        return

    old_id = test_email["id"]
    old_provider_id = test_email["provider_id"]
    print(f"\nBEFORE MOVE: id={old_id}, provider_id={old_provider_id}")

    # Step 5: Move to trash
    print(f"\nMoving to trash (PUT by provider_id)...")
    move_status, move_body = await api_put(
        client,
        f"/api/v1/emails/{old_provider_id}?account_id={account_id}",
        {"folders": [trash_folder_id]},
    )
    print(f"Move to trash: status={move_status} {snippet(move_body)}")

    if move_status not in (200, 201, 204):
        print(f"ERROR: Move to trash failed. Aborting further checks.")
        return

    # Step 6: Wait after move
    print(f"\nWaiting {WAIT_AFTER_MOVE_SECONDS}s after move...")
    await asyncio.sleep(WAIT_AFTER_MOVE_SECONDS)

    # Step 7: Check old identifiers
    print("\nAfter move to trash:")

    get_by_provider_status, get_by_provider_body = await api_get(
        client, f"/api/v1/emails/{old_provider_id}?account_id={account_id}"
    )
    print(f"  GET by old provider_id: {get_by_provider_status} {snippet(get_by_provider_body)}")

    get_by_id_status, get_by_id_body = await api_get(
        client, f"/api/v1/emails/{old_id}?account_id={account_id}"
    )
    print(f"  GET by old unipile id:  {get_by_id_status} {snippet(get_by_id_body)}")

    # Step 8: Try to PUT back to inbox using old provider_id
    put_provider_status, put_provider_body = await api_put(
        client,
        f"/api/v1/emails/{old_provider_id}?account_id={account_id}",
        {"folders": [inbox_folder_id]},
    )
    print(f"  PUT-to-inbox by old provider_id: {put_provider_status} {snippet(put_provider_body)}")

    # Step 9: If PUT by provider_id failed, try by unipile id
    if put_provider_status not in (200, 201, 204):
        put_id_status, put_id_body = await api_put(
            client,
            f"/api/v1/emails/{old_id}?account_id={account_id}",
            {"folders": [inbox_folder_id]},
        )
        print(f"  PUT-to-inbox by old unipile id:  {put_id_status} {snippet(put_id_body)}")
    else:
        print(f"  PUT-to-inbox by old unipile id:  (skipped, provider_id worked)")


async def main() -> None:
    """Entry point. Runs the id-stability test for each configured account."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        for account in ACCOUNTS:
            await test_account(
                client,
                label=account["label"],
                account_id=account["account_id"],
                email=account["email"],
            )

    print("\n\nDone.")


if __name__ == "__main__":
    asyncio.run(main())
