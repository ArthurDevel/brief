"""
Investigates whether RFC Message-ID can be used as a stable identifier for
Unipile email undo operations (to solve the Outlook ID staleness problem).

Tests four hypotheses:
1. include_headers on GET returns the RFC Message-ID header
2. message_id filter on GET /api/v1/emails can find an email by RFC Message-ID
3. PUT response body -- does it return useful data (e.g. new ID)?
4. Full undo flow using RFC Message-ID: move email, re-find by Message-ID, move back

Run: python3 test_message_id_approach.py
"""

import asyncio
import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
import httpx

# ============================================================================
# CONSTANTS
# ============================================================================

WAIT_AFTER_SEND_SECONDS = 15
WAIT_AFTER_MOVE_SECONDS = 10

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

OUTPUT_DIR = Path(__file__).parent / "output"


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


def dump_json(label: str, data: dict | str) -> None:
    """Pretty-print a JSON response for debugging."""
    if isinstance(data, dict):
        print(f"  {label}: {json.dumps(data, indent=2, default=str)}")
    else:
        print(f"  {label}: {data}")


def save_result(filename: str, data: dict) -> None:
    """Save a result dict to the output folder for later review."""
    out = OUTPUT_DIR / filename
    out.write_text(json.dumps(data, indent=2, default=str))
    print(f"  [saved to {out.name}]")


def extract_message_id_from_headers(headers: list[dict]) -> str | None:
    """Extract the RFC Message-ID from a list of email header dicts."""
    for h in headers:
        if h.get("name", "").lower() == "message-id":
            return h.get("value")
    return None


async def resolve_folder_ids(client: httpx.AsyncClient, account_id: str) -> dict[str, str]:
    """Resolve inbox and trash folder IDs for an account.

    Returns:
        Dict with keys 'inbox' and 'trash', values are Unipile folder IDs.
    """
    status, data = await api_get(client, f"/api/v1/folders?account_id={account_id}")
    if status != 200 or not isinstance(data, dict):
        raise RuntimeError(f"Failed to list folders: status={status}")

    items = data.get("items", [])
    inbox = next((f for f in items if f.get("role") == "inbox"), None)
    trash = next((f for f in items if f.get("role") == "trash"), None)

    if not inbox or not trash:
        raise RuntimeError(f"Missing inbox/trash. Roles: {[f.get('role') for f in items]}")

    return {"inbox": inbox["id"], "trash": trash["id"]}


async def send_and_find_email(
    client: httpx.AsyncClient,
    account_id: str,
    email: str,
    subject: str,
) -> dict | None:
    """Send a test email to self and wait until it appears in inbox.

    Returns:
        The email dict from Unipile, or None if not found.
    """
    send_status, _ = await api_post(client, "/api/v1/emails", {
        "account_id": account_id,
        "to": [{"identifier": email}],
        "subject": subject,
        "body": f"Test body for: {subject}",
    })
    if send_status not in (200, 201):
        print(f"  ERROR: Send failed (status={send_status})")
        return None

    print(f"  Waiting {WAIT_AFTER_SEND_SECONDS}s for delivery...")
    await asyncio.sleep(WAIT_AFTER_SEND_SECONDS)

    # Find the email
    status, body = await api_get(client, f"/api/v1/emails?account_id={account_id}&limit=15")
    if status != 200 or not isinstance(body, dict):
        print(f"  ERROR: List failed (status={status})")
        return None

    emails = body.get("items", [])
    found = next((e for e in emails if subject in e.get("subject", "")), None)
    if not found:
        print(f"  ERROR: Email not found. Subjects: {[e.get('subject', '')[:50] for e in emails]}")
    return found


# ============================================================================
# TEST 1: include_headers -- can we get the RFC Message-ID?
# ============================================================================

async def test_include_headers(
    client: httpx.AsyncClient,
    label: str,
    account_id: str,
    email_id: str,
) -> str | None:
    """Fetch an email with include_headers=true and look for the Message-ID header.

    Args:
        client: HTTP client.
        label: Account label for logging.
        account_id: Unipile account ID.
        email_id: Unipile email ID to fetch.

    Returns:
        The RFC Message-ID string, or None if not found.
    """
    print(f"\n--- TEST 1: include_headers ({label}) ---")

    # Try GET with include_headers=true
    status, body = await api_get(
        client,
        f"/api/v1/emails/{email_id}?account_id={account_id}&include_headers=true",
    )
    print(f"  GET with include_headers=true: status={status}")

    if status != 200 or not isinstance(body, dict):
        print(f"  FAIL: Could not fetch email")
        return None

    headers = body.get("headers", [])
    print(f"  Headers present: {len(headers)} header(s)")

    if headers:
        # Show all header names
        header_names = [h.get("name", "") for h in headers]
        print(f"  Header names: {header_names}")

        rfc_message_id = extract_message_id_from_headers(headers)
        if rfc_message_id:
            print(f"  RFC Message-ID: {rfc_message_id}")
            return rfc_message_id
        else:
            print(f"  FAIL: No Message-ID header found in headers")
    else:
        print(f"  FAIL: No headers returned. Keys in response: {list(body.keys())}")
        # Check if headers might be nested differently
        if "header" in body:
            print(f"  Found 'header' key: {body['header']}")

    save_result(f"test1_include_headers_{label.replace(' ', '_')}.json", body)
    return None


# ============================================================================
# TEST 2: message_id filter on GET /api/v1/emails
# ============================================================================

async def test_message_id_filter(
    client: httpx.AsyncClient,
    label: str,
    account_id: str,
    rfc_message_id: str,
) -> dict | None:
    """Search for an email using the message_id filter parameter.

    Args:
        client: HTTP client.
        label: Account label for logging.
        account_id: Unipile account ID.
        rfc_message_id: RFC Message-ID to search for.

    Returns:
        The found email dict, or None.
    """
    print(f"\n--- TEST 2: message_id filter ({label}) ---")
    print(f"  Searching for message_id={rfc_message_id}")

    # Try the message_id filter
    status, body = await api_get(
        client,
        f"/api/v1/emails?account_id={account_id}&message_id={rfc_message_id}",
    )
    print(f"  GET with message_id filter: status={status}")

    if status != 200 or not isinstance(body, dict):
        print(f"  FAIL: Request failed")
        save_result(f"test2_message_id_filter_{label.replace(' ', '_')}.json", {"status": status, "body": body})
        return None

    items = body.get("items", [])
    print(f"  Results: {len(items)} email(s) found")

    if items:
        found = items[0]
        print(f"  Found: id={found.get('id')}, provider_id={found.get('provider_id')}, subject={found.get('subject', '')[:60]}")
        return found
    else:
        print(f"  FAIL: No emails found with this message_id")
        # Try without angle brackets in case Unipile expects bare ID
        bare_id = rfc_message_id.strip("<>")
        status2, body2 = await api_get(
            client,
            f"/api/v1/emails?account_id={account_id}&message_id={bare_id}",
        )
        items2 = body2.get("items", []) if isinstance(body2, dict) else []
        print(f"  Retry without angle brackets: status={status2}, results={len(items2)}")
        if items2:
            found = items2[0]
            print(f"  Found: id={found.get('id')}, subject={found.get('subject', '')[:60]}")
            return found

    save_result(f"test2_message_id_filter_{label.replace(' ', '_')}.json", body)
    return None


# ============================================================================
# TEST 3: PUT response body inspection
# ============================================================================

async def test_put_response(
    client: httpx.AsyncClient,
    label: str,
    account_id: str,
    email_id: str,
    target_folder: str,
) -> dict | str:
    """Move an email via PUT and inspect the full response body.

    Args:
        client: HTTP client.
        label: Account label for logging.
        account_id: Unipile account ID.
        email_id: Email ID to move.
        target_folder: Target folder ID.

    Returns:
        The PUT response body.
    """
    print(f"\n--- TEST 3: PUT response body ({label}) ---")
    print(f"  Moving email {email_id} to folder {target_folder}")

    status, body = await api_put(
        client,
        f"/api/v1/emails/{email_id}?account_id={account_id}",
        {"folders": [target_folder]},
    )
    print(f"  PUT status: {status}")
    dump_json("PUT response body", body)

    save_result(f"test3_put_response_{label.replace(' ', '_')}.json", {
        "status": status,
        "body": body,
        "email_id_used": email_id,
        "target_folder": target_folder,
    })

    return body


# ============================================================================
# TEST 4: Full RFC Message-ID undo flow
# ============================================================================

async def test_full_undo_flow(
    client: httpx.AsyncClient,
    label: str,
    account_id: str,
    email: str,
) -> dict:
    """Full undo flow: send, get Message-ID, move to trash, re-find by Message-ID, move back.

    Args:
        client: HTTP client.
        label: Account label for logging.
        account_id: Unipile account ID.
        email: Email address to send test email to.

    Returns:
        Result dict with pass/fail for each step.
    """
    print(f"\n--- TEST 4: Full RFC Message-ID undo flow ({label}) ---")
    result = {"label": label, "steps": {}}

    # Step 1: Resolve folders
    folders = await resolve_folder_ids(client, account_id)
    print(f"  Inbox: {folders['inbox']}, Trash: {folders['trash']}")

    # Step 2: Send test email
    timestamp = int(time.time())
    subject = f"[test-msgid-undo] {label} {timestamp}"
    print(f"  Sending: {subject}")

    test_email = await send_and_find_email(client, account_id, email, subject)
    if not test_email:
        result["steps"]["send"] = "FAIL"
        return result
    result["steps"]["send"] = "PASS"

    original_id = test_email["id"]
    original_provider_id = test_email["provider_id"]
    print(f"  Original: id={original_id}, provider_id={original_provider_id}")

    # Step 3: Get RFC Message-ID via include_headers
    # NOTE: Unipile GET only works with provider_id (not the internal id)
    rfc_msg_id = await test_include_headers(client, label, account_id, original_provider_id)

    if not rfc_msg_id:
        result["steps"]["get_message_id"] = "FAIL"
        print(f"  ABORT: Cannot get RFC Message-ID")
        return result
    result["steps"]["get_message_id"] = f"PASS: {rfc_msg_id}"

    # Step 4: Move to trash (using provider_id -- Unipile requires it for PUT)
    print(f"\n  Moving to trash...")
    put_status, put_body = await api_put(
        client,
        f"/api/v1/emails/{original_provider_id}?account_id={account_id}",
        {"folders": [folders["trash"]]},
    )
    print(f"  Move status: {put_status}")
    dump_json("PUT response", put_body)
    save_result(f"test3_put_response_{label.replace(' ', '_')}.json", {
        "status": put_status, "body": put_body,
    })
    if put_status not in (200, 201, 204):
        result["steps"]["move_to_trash"] = f"FAIL: status={put_status}"
        return result
    result["steps"]["move_to_trash"] = "PASS"
    result["steps"]["put_response_keys"] = str(list(put_body.keys())) if isinstance(put_body, dict) else str(put_body)

    # Step 5: Wait for Unipile to re-index
    print(f"  Waiting {WAIT_AFTER_MOVE_SECONDS}s for re-index...")
    await asyncio.sleep(WAIT_AFTER_MOVE_SECONDS)

    # Step 6: Verify old IDs are stale (for Outlook) or still valid (for Gmail)
    get_by_pid_status, _ = await api_get(
        client, f"/api/v1/emails/{original_provider_id}?account_id={account_id}"
    )
    result["steps"]["old_provider_id_after_move"] = f"status={get_by_pid_status}"
    print(f"  Old provider_id after move: status={get_by_pid_status}")

    # Step 7: Re-find by RFC Message-ID
    print(f"\n  Re-finding by message_id filter...")
    refound = await test_message_id_filter(client, label, account_id, rfc_msg_id)

    if not refound:
        result["steps"]["refind_by_message_id"] = "FAIL"
        print(f"  ABORT: Cannot re-find email by Message-ID")
        return result

    new_id = refound["id"]
    new_provider_id = refound.get("provider_id", "?")
    id_changed = new_id != original_id
    result["steps"]["refind_by_message_id"] = f"PASS: new_id={new_id}, id_changed={id_changed}"
    print(f"  New: id={new_id}, provider_id={new_provider_id}")
    print(f"  ID changed: {id_changed}")

    # Step 8: Move back to inbox using the NEW id
    print(f"\n  Moving back to inbox using new id ({new_id})...")
    undo_status, undo_body = await api_put(
        client,
        f"/api/v1/emails/{new_id}?account_id={account_id}",
        {"folders": [folders["inbox"]]},
    )
    print(f"  Undo move status: {undo_status}")
    result["steps"]["undo_move"] = f"status={undo_status}"

    if undo_status not in (200, 201, 204):
        dump_json("Undo response", undo_body)
        return result

    # Step 9: Verify email is back in inbox
    print(f"  Waiting 5s for inbox sync...")
    await asyncio.sleep(5)

    list_status, list_body = await api_get(
        client, f"/api/v1/emails?account_id={account_id}&limit=15"
    )
    if list_status == 200 and isinstance(list_body, dict):
        items = list_body.get("items", [])
        back_in_inbox = any(subject in e.get("subject", "") for e in items)
        result["steps"]["back_in_inbox"] = f"{'PASS' if back_in_inbox else 'FAIL'}"
        print(f"  Back in inbox: {back_in_inbox}")
    else:
        result["steps"]["back_in_inbox"] = "FAIL: could not list inbox"

    return result


# ============================================================================
# ENTRY POINT
# ============================================================================

async def main() -> None:
    """Run all tests for each configured account and save a summary."""
    all_results = []

    async with httpx.AsyncClient(timeout=30.0) as client:
        for account in ACCOUNTS:
            label = account["label"]
            account_id = account["account_id"]
            email = account["email"]

            print(f"\n{'=' * 70}")
            print(f"=== {label} ===")
            print(f"{'=' * 70}")

            # Run the full undo flow test (which includes tests 1, 2, 3 internally)
            result = await test_full_undo_flow(client, label, account_id, email)
            all_results.append(result)

    # Print summary
    print(f"\n\n{'=' * 70}")
    print("SUMMARY")
    print(f"{'=' * 70}")
    for r in all_results:
        print(f"\n{r['label']}:")
        for step, outcome in r["steps"].items():
            print(f"  {step}: {outcome}")

    # Save summary
    save_result("summary.json", {"results": all_results})
    print(f"\nDone.")


if __name__ == "__main__":
    asyncio.run(main())
