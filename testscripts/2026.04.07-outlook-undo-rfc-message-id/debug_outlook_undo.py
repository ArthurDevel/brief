"""
Debug script: Outlook Unipile archive + undo flow.

Walks through each step of the archive-then-undo flow against a real
Outlook account via Unipile, printing detailed diagnostics at every step.
Goal: figure out why the undo PUT succeeds but the email doesn't reappear
in the inbox listing.

Usage: python3 debug_outlook_undo.py
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv

# Load env from project root
load_dotenv(Path(__file__).resolve().parents[2] / ".env.test.local")

UNIPILE_API_KEY = os.environ["UNIPILE_API_KEY"]
UNIPILE_DSN = os.environ["UNIPILE_DSN"]
ACCOUNT_ID = os.environ["TEST_OUTLOOK_UNIPILE_ACCOUNT_ID"]
EMAIL_ADDRESS = os.environ["TEST_OUTLOOK_UNIPILE_EMAIL"]

TIMEOUT = 15.0


# ============================================================================
# UNIPILE API HELPERS
# ============================================================================

async def api_request(method: str, path: str, params: dict | None = None, json_body: dict | None = None) -> dict:
    """Make an authenticated Unipile API request and return JSON."""
    url = f"{UNIPILE_DSN}{path}"
    headers = {"X-API-KEY": UNIPILE_API_KEY, "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.request(method, url, headers=headers, params=params, json=json_body)
    if resp.status_code >= 400:
        print(f"  [ERROR] {method} {path} -> {resp.status_code}: {resp.text}")
    return resp.json()


async def resolve_folder_by_role(role: str) -> str:
    """Find a folder ID by its role."""
    data = await api_request("GET", "/api/v1/folders", params={"account_id": ACCOUNT_ID})
    items = data.get("items", data if isinstance(data, list) else [])
    for f in items:
        if (f.get("role") or "").lower() == role.lower():
            return f["provider_id"]
    raise RuntimeError(f"No folder with role '{role}'")


async def list_inbox(limit: int = 20) -> list[dict]:
    """List inbox emails, return raw items."""
    inbox_provider_id = None
    data = await api_request("GET", "/api/v1/folders", params={"account_id": ACCOUNT_ID})
    items = data.get("items", data if isinstance(data, list) else [])
    for f in items:
        if (f.get("role") or "").lower() == "inbox":
            inbox_provider_id = f["provider_id"]
            break

    data = await api_request("GET", "/api/v1/emails", params={
        "account_id": ACCOUNT_ID, "limit": limit, "folder": inbox_provider_id,
    })
    return data.get("items", [])


async def get_email_detail(email_id: str, include_headers: bool = False) -> dict:
    """Fetch full email detail."""
    params = {"account_id": ACCOUNT_ID}
    if include_headers:
        params["include_headers"] = "true"
    return await api_request("GET", f"/api/v1/emails/{email_id}", params=params)


async def send_test_email(subject: str) -> None:
    """Send a test email to ourselves."""
    payload = {
        "account_id": ACCOUNT_ID,
        "to": [{"identifier": EMAIL_ADDRESS}],
        "subject": subject,
        "body": f"Debug test email sent at {time.time()}",
    }
    await api_request("POST", "/api/v1/emails", json_body=payload)


# ============================================================================
# MAIN DEBUG FLOW
# ============================================================================

async def main() -> None:
    print("=" * 70)
    print("OUTLOOK UNIPILE UNDO DEBUG SCRIPT")
    print("=" * 70)
    print(f"Account ID: {ACCOUNT_ID}")
    print(f"Email: {EMAIL_ADDRESS}")
    print()

    # Step 1: Send a test email
    tag = f"[debug-{int(time.time() * 1000)}]"
    subject = f"{tag} Undo debug test"
    print(f"STEP 1: Sending test email with subject: {subject}")
    await send_test_email(subject)
    print("  Sent. Waiting 15s for delivery...")
    await asyncio.sleep(15)

    # Step 2: Find it in inbox
    print(f"\nSTEP 2: Looking for email in inbox...")
    target_email = None
    for attempt in range(6):
        items = await list_inbox(50)
        for item in items:
            if tag in item.get("subject", ""):
                target_email = item
                break
        if target_email:
            break
        print(f"  Attempt {attempt + 1}/6 - not found, waiting 5s...")
        await asyncio.sleep(5)

    if not target_email:
        print("  FAILED: Could not find test email in inbox after 6 attempts")
        return

    email_id: str = target_email.get("provider_id") or target_email["id"]
    unipile_id: str = target_email["id"]
    print(f"  Found! provider_id={email_id}, unipile_id={unipile_id}")
    print(f"  Subject: {target_email.get('subject')}")

    # Step 3: Fetch RFC Message-ID BEFORE archive
    print(f"\nSTEP 3: Fetching RFC Message-ID (include_headers=true)...")
    detail = await get_email_detail(email_id, include_headers=True)

    rfc_message_id = None
    headers = detail.get("headers", [])
    print(f"  Headers count: {len(headers)}")
    for h in headers:
        if h.get("name", "").lower() == "message-id":
            rfc_message_id = h["value"]
            break

    if rfc_message_id:
        print(f"  RFC Message-ID: {rfc_message_id}")
    else:
        print("  WARNING: No Message-ID header found!")
        print(f"  Available headers: {[h.get('name') for h in headers]}")
        # Dump full response to output
        with open(Path(__file__).parent / "output" / "no_message_id_response.json", "w") as f:
            json.dump(detail, f, indent=2)
        print("  Full response saved to output/no_message_id_response.json")
        return

    # Step 4: Archive the email
    print(f"\nSTEP 4: Archiving email (PUT with archive folder)...")
    archive_folder_id = await resolve_folder_by_role("archive")
    print(f"  Archive folder ID: {archive_folder_id}")

    archive_body = {"folders": [archive_folder_id]}
    result = await api_request("PUT", f"/api/v1/emails/{email_id}",
                                params={"account_id": ACCOUNT_ID}, json_body=archive_body)
    print(f"  Archive PUT response: {json.dumps(result, indent=2)}")

    print("  Waiting 10s for Outlook to process the move...")
    await asyncio.sleep(10)

    # Step 5: Verify email is gone from inbox
    print(f"\nSTEP 5: Verifying email is gone from inbox...")
    items = await list_inbox(50)
    still_in_inbox = any(tag in item.get("subject", "") for item in items)
    print(f"  Still in inbox: {still_in_inbox}")

    # Step 6: Try to re-find by RFC Message-ID
    print(f"\nSTEP 6: Re-finding email by RFC Message-ID...")
    refind_data = await api_request("GET", "/api/v1/emails",
                                     params={"account_id": ACCOUNT_ID, "message_id": rfc_message_id})
    refind_items = refind_data.get("items", [])
    print(f"  Results count: {len(refind_items)}")

    if refind_items:
        new_item = refind_items[0]
        new_unipile_id = new_item.get("id")
        new_provider_id = new_item.get("provider_id")
        print(f"  New unipile_id: {new_unipile_id}")
        print(f"  New provider_id: {new_provider_id}")
        print(f"  Old unipile_id was: {unipile_id}")
        print(f"  Old provider_id was: {email_id}")
        print(f"  ID changed: {new_unipile_id != unipile_id}")

        # Save full re-find response
        with open(Path(__file__).parent / "output" / "refind_response.json", "w") as f:
            json.dump(refind_data, f, indent=2)
    else:
        print("  FAILED: Could not re-find email by Message-ID!")
        with open(Path(__file__).parent / "output" / "refind_empty_response.json", "w") as f:
            json.dump(refind_data, f, indent=2)
        print("  Full response saved to output/refind_empty_response.json")

        # Try alternative: search by subject
        print(f"\n  Trying alternative: search by subject...")
        search_data = await api_request("GET", "/api/v1/emails",
                                         params={"account_id": ACCOUNT_ID, "q": tag})
        search_items = search_data.get("items", [])
        print(f"  Search results: {len(search_items)}")
        if search_items:
            for si in search_items:
                print(f"    id={si.get('id')}, provider_id={si.get('provider_id')}, subject={si.get('subject')}")

    # Step 7: Undo - move back to inbox using re-found ID
    if refind_items:
        target_id = refind_items[0]["id"]
    else:
        # Fallback: try with original email_id
        print(f"\n  Falling back to original email_id for undo: {email_id}")
        target_id = email_id

    print(f"\nSTEP 7: Undoing archive (PUT to inbox folder using id={target_id})...")
    inbox_folder_id = await resolve_folder_by_role("inbox")
    print(f"  Inbox folder ID: {inbox_folder_id}")

    undo_body = {"folders": [inbox_folder_id]}
    undo_result = await api_request("PUT", f"/api/v1/emails/{target_id}",
                                     params={"account_id": ACCOUNT_ID}, json_body=undo_body)
    print(f"  Undo PUT response: {json.dumps(undo_result, indent=2)}")

    # Step 8: Check if email reappears in inbox
    print(f"\nSTEP 8: Checking if email reappears in inbox...")
    for attempt in range(8):
        wait = 5
        print(f"  Attempt {attempt + 1}/8 (waiting {wait}s first)...")
        await asyncio.sleep(wait)
        items = await list_inbox(50)
        for item in items:
            if tag in item.get("subject", ""):
                print(f"  SUCCESS! Email found back in inbox after {(attempt + 1) * wait}s")
                print(f"    provider_id={item.get('provider_id')}, unipile_id={item.get('id')}")
                # Save the successful result
                with open(Path(__file__).parent / "output" / "success_result.json", "w") as f:
                    json.dump({"step": "undo_verified", "attempts": attempt + 1, "item": item}, f, indent=2)
                return

    print(f"  FAILED: Email did not reappear in inbox after 8 attempts (40s)")

    # Extra debug: check what folder the email is in now
    print(f"\nEXTRA: Checking email's current state after failed undo...")
    # Try to fetch it directly
    for check_id in [target_id, email_id]:
        print(f"  Trying to fetch email by id={check_id}...")
        try:
            detail = await get_email_detail(str(check_id), include_headers=False)
            print(f"    Status: found")
            print(f"    Folders: {detail.get('folders', 'N/A')}")
            print(f"    provider_id: {detail.get('provider_id')}")
            with open(Path(__file__).parent / "output" / f"post_undo_detail_{str(check_id)[:20]}.json", "w") as f:
                json.dump(detail, f, indent=2)
        except Exception as e:
            print(f"    Error: {e}")

    # Also try re-finding by Message-ID again after undo
    print(f"\n  Re-finding by Message-ID again after undo...")
    refind2 = await api_request("GET", "/api/v1/emails",
                                 params={"account_id": ACCOUNT_ID, "message_id": rfc_message_id})
    refind2_items = refind2.get("items", [])
    print(f"  Results: {len(refind2_items)}")
    if refind2_items:
        item = refind2_items[0]
        print(f"    id={item.get('id')}, provider_id={item.get('provider_id')}")
        print(f"    folders: {item.get('folders', 'N/A')}")
        with open(Path(__file__).parent / "output" / "post_undo_refind.json", "w") as f:
            json.dump(refind2, f, indent=2)

    print("\n" + "=" * 70)
    print("DEBUG COMPLETE - check output/ folder for detailed responses")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
