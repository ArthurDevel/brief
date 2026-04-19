"""
Investigate whether Unipile DELETE permanently removes an email vs PUT-to-trash.

- Test A: DELETE /api/v1/emails/{id}, then try to undo by PUT back to inbox
- Test B: PUT /api/v1/emails/{id} with trash folder, then try to undo by PUT back to inbox

Expected: DELETE is permanent (undo fails with 404), PUT-to-trash is reversible.
"""

import asyncio
import os
import time

import httpx
from dotenv import load_dotenv

# ============================================================================
# CONSTANTS
# ============================================================================

DELIVERY_WAIT_SECONDS = 15
EMAIL_LIST_LIMIT = 10

# ============================================================================
# HELPER FUNCTIONS
# ============================================================================


def _get_env() -> tuple[str, str, str, str]:
    """Load and return required env vars. Fails fast if any are missing."""
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

    required_vars = [
        "UNIPILE_API_KEY",
        "UNIPILE_DSN",
        "TEST_GMAIL_UNIPILE_ACCOUNT_ID",
        "TEST_GMAIL_UNIPILE_EMAIL",
    ]

    values: dict[str, str] = {}
    missing: list[str] = []
    for var in required_vars:
        val = os.environ.get(var)
        if not val:
            missing.append(var)
        else:
            values[var] = val

    if missing:
        raise RuntimeError(f"Missing env vars: {', '.join(missing)}")

    # Strip trailing slash from DSN
    dsn = values["UNIPILE_DSN"].rstrip("/")

    return values["UNIPILE_API_KEY"], dsn, values["TEST_GMAIL_UNIPILE_ACCOUNT_ID"], values["TEST_GMAIL_UNIPILE_EMAIL"]


def _headers(api_key: str) -> dict:
    """Return common headers for Unipile API calls."""
    return {
        "X-API-KEY": api_key,
        "Accept": "application/json",
    }


async def _find_folder_id(
    client: httpx.AsyncClient,
    base_url: str,
    headers: dict,
    account_id: str,
    role: str,
) -> str:
    """
    Find a folder ID by its role (e.g. 'trash', 'inbox').

    Args:
        client: httpx async client
        base_url: Unipile DSN base URL
        headers: API headers
        account_id: Unipile account ID
        role: folder role to search for

    Returns:
        The folder ID string
    """
    resp = await client.get(
        f"{base_url}/api/v1/folders",
        params={"account_id": account_id},
        headers=headers,
    )
    resp.raise_for_status()
    data = resp.json()

    # The response could be a list or have an "items" key
    folders = data if isinstance(data, list) else data.get("items", data.get("folders", []))

    for folder in folders:
        if folder.get("role") == role:
            return folder["id"]

    raise RuntimeError(f"Could not find folder with role='{role}'. Available folders: {folders}")


async def _send_test_email(
    client: httpx.AsyncClient,
    base_url: str,
    headers: dict,
    account_id: str,
    email_address: str,
    subject: str,
) -> dict:
    """
    Send a test email to self.

    Args:
        client: httpx async client
        base_url: Unipile DSN base URL
        headers: API headers
        account_id: Unipile account ID
        email_address: recipient (self) email address
        subject: email subject line

    Returns:
        The API response as dict
    """
    resp = await client.post(
        f"{base_url}/api/v1/emails",
        headers=headers,
        json={
            "account_id": account_id,
            "to": [{"identifier": email_address}],
            "subject": subject,
            "body": "Test email for delete vs put-to-trash investigation.",
        },
    )
    resp.raise_for_status()
    return resp.json()


async def _find_email_by_subject(
    client: httpx.AsyncClient,
    base_url: str,
    headers: dict,
    account_id: str,
    subject_search: str,
) -> dict:
    """
    List recent inbox emails and find one matching the subject.

    Args:
        client: httpx async client
        base_url: Unipile DSN base URL
        headers: API headers
        account_id: Unipile account ID
        subject_search: substring to match in subject

    Returns:
        The matching email dict with 'id' and 'provider_id'
    """
    resp = await client.get(
        f"{base_url}/api/v1/emails",
        params={"account_id": account_id, "limit": EMAIL_LIST_LIMIT},
        headers=headers,
    )
    resp.raise_for_status()
    data = resp.json()

    emails = data if isinstance(data, list) else data.get("items", data.get("emails", []))

    for email in emails:
        if subject_search in email.get("subject", ""):
            return {
                "id": email["id"],
                "provider_id": email.get("provider_id", email["id"]),
            }

    raise RuntimeError(
        f"Could not find email with subject containing '{subject_search}'. "
        f"Found subjects: {[e.get('subject', '?') for e in emails]}"
    )


# ============================================================================
# MAIN LOGIC
# ============================================================================


async def run_test_a(
    client: httpx.AsyncClient,
    base_url: str,
    headers: dict,
    account_id: str,
    email_address: str,
    inbox_folder_id: str,
) -> None:
    """
    Test A: DELETE endpoint, then try to undo with PUT back to inbox.

    Args:
        client: httpx async client
        base_url: Unipile DSN base URL
        headers: API headers
        account_id: Unipile account ID
        email_address: self email address
        inbox_folder_id: inbox folder ID for undo
    """
    timestamp = int(time.time())
    subject = f"[test-delete] DELETE test {timestamp}"

    print(f"\n{'=' * 60}")
    print("Test A: DELETE endpoint")
    print(f"{'=' * 60}")

    # Step 1: Send test email
    print(f"\nSending test email with subject: {subject}")
    send_resp = await _send_test_email(client, base_url, headers, account_id, email_address, subject)
    print(f"Send response: {send_resp}")

    # Step 2: Wait for delivery
    print(f"\nWaiting {DELIVERY_WAIT_SECONDS}s for delivery...")
    await asyncio.sleep(DELIVERY_WAIT_SECONDS)

    # Step 3: Find the email
    email = await _find_email_by_subject(client, base_url, headers, account_id, subject)
    print(f"Found email: id={email['id']}, provider_id={email['provider_id']}")

    # Step 4: DELETE the email
    print(f"\nDELETing email via DELETE /api/v1/emails/{email['provider_id']}...")
    delete_resp = await client.delete(
        f"{base_url}/api/v1/emails/{email['provider_id']}",
        params={"account_id": account_id},
        headers=headers,
    )
    print(f"DELETE response: {delete_resp.status_code} {delete_resp.text}")

    # Step 5: Try to undo by PUT back to inbox
    print(f"\nAttempting undo: PUT /api/v1/emails/{email['provider_id']} -> inbox...")
    undo_resp = await client.put(
        f"{base_url}/api/v1/emails/{email['provider_id']}",
        params={"account_id": account_id},
        headers=headers,
        json={"folders": [inbox_folder_id]},
    )
    print(f"Undo PUT response: {undo_resp.status_code} {undo_resp.text}")

    if undo_resp.status_code == 200:
        print("\nResult: UNDO WORKS")
    else:
        print(f"\nResult: UNDO FAILS ({undo_resp.status_code})")


async def run_test_b(
    client: httpx.AsyncClient,
    base_url: str,
    headers: dict,
    account_id: str,
    email_address: str,
    inbox_folder_id: str,
    trash_folder_id: str,
) -> None:
    """
    Test B: PUT to trash folder, then try to undo with PUT back to inbox.

    Args:
        client: httpx async client
        base_url: Unipile DSN base URL
        headers: API headers
        account_id: Unipile account ID
        email_address: self email address
        inbox_folder_id: inbox folder ID for undo
        trash_folder_id: trash folder ID for move-to-trash
    """
    timestamp = int(time.time())
    subject = f"[test-delete] PUT-trash test {timestamp}"

    print(f"\n{'=' * 60}")
    print("Test B: PUT to trash")
    print(f"{'=' * 60}")

    # Step 1: Send test email
    print(f"\nSending test email with subject: {subject}")
    send_resp = await _send_test_email(client, base_url, headers, account_id, email_address, subject)
    print(f"Send response: {send_resp}")

    # Step 2: Wait for delivery
    print(f"\nWaiting {DELIVERY_WAIT_SECONDS}s for delivery...")
    await asyncio.sleep(DELIVERY_WAIT_SECONDS)

    # Step 3: Find the email
    email = await _find_email_by_subject(client, base_url, headers, account_id, subject)
    print(f"Found email: id={email['id']}, provider_id={email['provider_id']}")

    # Step 4: PUT to trash
    print(f"\nMoving email to trash via PUT /api/v1/emails/{email['provider_id']}...")
    trash_resp = await client.put(
        f"{base_url}/api/v1/emails/{email['provider_id']}",
        params={"account_id": account_id},
        headers=headers,
        json={"folders": [trash_folder_id]},
    )
    print(f"PUT-to-trash response: {trash_resp.status_code} {trash_resp.text}")

    # Step 5: Try to undo by PUT back to inbox
    print(f"\nAttempting undo: PUT /api/v1/emails/{email['provider_id']} -> inbox...")
    undo_resp = await client.put(
        f"{base_url}/api/v1/emails/{email['provider_id']}",
        params={"account_id": account_id},
        headers=headers,
        json={"folders": [inbox_folder_id]},
    )
    print(f"Undo PUT response: {undo_resp.status_code} {undo_resp.text}")

    if undo_resp.status_code == 200:
        print("\nResult: UNDO WORKS")
    else:
        print(f"\nResult: UNDO FAILS ({undo_resp.status_code})")


# ============================================================================
# ENTRY POINT
# ============================================================================


async def main():
    api_key, base_url, account_id, email_address = _get_env()
    headers = _headers(api_key)

    async with httpx.AsyncClient(timeout=30) as client:
        # Find folder IDs
        print("Looking up folder IDs...")
        trash_folder_id = await _find_folder_id(client, base_url, headers, account_id, "trash")
        inbox_folder_id = await _find_folder_id(client, base_url, headers, account_id, "inbox")
        print(f"Trash folder ID: {trash_folder_id}")
        print(f"Inbox folder ID: {inbox_folder_id}")

        # Run tests
        await run_test_a(client, base_url, headers, account_id, email_address, inbox_folder_id)
        await run_test_b(client, base_url, headers, account_id, email_address, inbox_folder_id, trash_folder_id)

        print(f"\n{'=' * 60}")
        print("DONE")
        print(f"{'=' * 60}")


if __name__ == "__main__":
    asyncio.run(main())
