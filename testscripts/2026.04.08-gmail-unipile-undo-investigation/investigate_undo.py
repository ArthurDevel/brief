"""
Investigate Gmail Unipile undo failures.

The undo PUT succeeds (HTTP 200) but the email does not reappear in inbox.
This script isolates the Unipile API calls to figure out exactly why.

Steps:
1. List folders and dump their ids, provider_ids, and roles
2. Send an email to self
3. Wait for delivery, find the email in inbox
4. Archive it (PUT folders=[])
5. Verify it disappeared from inbox
6. Attempt undo (PUT folders=[inbox_provider_id])
7. Check if it reappears -- if not, try alternative approaches:
   a. Use inbox "id" (Unipile internal) instead of provider_id
   b. Re-find email by RFC Message-ID first (like Outlook path)
   c. Use INBOX as a raw string
   d. Try adding label "INBOX" explicitly
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx
from dotenv import load_dotenv

# Load env from the repo root
_repo_root = Path(__file__).resolve().parents[2]
load_dotenv(_repo_root / ".env.test.local")

UNIPILE_API_KEY = os.environ["UNIPILE_API_KEY"]
UNIPILE_DSN = os.environ["UNIPILE_DSN"]
ACCOUNT_ID = os.environ["TEST_GMAIL_UNIPILE_ACCOUNT_ID"]
EMAIL_ADDRESS = os.environ["TEST_GMAIL_UNIPILE_EMAIL"]

OUTPUT_DIR = Path(__file__).parent / "output"

RUN_ID = f"undo-test-{int(time.time() * 1000)}"

# How long to wait for email delivery / sync
DELIVERY_WAIT = 15
POLL_INTERVAL = 5
MAX_POLLS = 8


# ============================================================================
# UNIPILE API HELPERS
# ============================================================================

async def api(method: str, path: str, params: dict | None = None, json_body: dict | None = None) -> dict:
    """Make a Unipile API request and return parsed JSON."""
    url = f"{UNIPILE_DSN}{path}"
    headers = {"X-API-KEY": UNIPILE_API_KEY, "Accept": "application/json"}

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.request(method, url, headers=headers, params=params, json=json_body)

    log(f"  {method} {path} params={params} body={json_body} -> {resp.status_code}")
    if resp.status_code >= 400:
        log(f"  ERROR BODY: {resp.text}")
    data = resp.json()
    return data


async def list_folders() -> list[dict]:
    """Fetch all folders for the test account."""
    data = await api("GET", "/api/v1/folders", params={"account_id": ACCOUNT_ID})
    return data.get("items", data if isinstance(data, list) else [])


async def list_inbox(limit: int = 30) -> list[dict]:
    """Fetch inbox emails."""
    data = await api("GET", "/api/v1/emails", params={
        "account_id": ACCOUNT_ID,
        "limit": str(limit),
        "folder": "INBOX",
    })
    return data.get("items", [])


async def send_email(subject: str, body: str) -> dict:
    """Send an email to self."""
    return await api("POST", "/api/v1/emails", json_body={
        "account_id": ACCOUNT_ID,
        "to": [{"identifier": EMAIL_ADDRESS}],
        "subject": subject,
        "body": body,
    })


async def get_email_detail(email_id: str, include_headers: bool = False) -> dict:
    """Get full email detail."""
    params = {"account_id": ACCOUNT_ID}
    if include_headers:
        params["include_headers"] = "true"
    return await api("GET", f"/api/v1/emails/{email_id}", params=params)


async def move_email(email_id: str, folders: list[str]) -> dict:
    """PUT /emails/{id} with folders."""
    return await api("PUT", f"/api/v1/emails/{email_id}",
                     params={"account_id": ACCOUNT_ID},
                     json_body={"folders": folders})


async def list_all_emails(limit: int = 30) -> list[dict]:
    """Fetch emails without folder filter."""
    data = await api("GET", "/api/v1/emails", params={
        "account_id": ACCOUNT_ID,
        "limit": str(limit),
    })
    return data.get("items", [])


async def get_email_by_provider_id(provider_id: str) -> dict | None:
    """Try to fetch an email directly by provider_id."""
    try:
        return await api("GET", f"/api/v1/emails/{provider_id}", params={"account_id": ACCOUNT_ID})
    except Exception as e:
        log(f"  Could not fetch by provider_id {provider_id}: {e}")
        return None


async def find_email_by_subject(subject: str, send_provider_id: str | None = None) -> dict | None:
    """Poll for an email by subject. Tries inbox listing, all-emails listing, and direct fetch."""
    # First try: direct fetch by provider_id from send response
    if send_provider_id:
        log(f"  Trying direct fetch by send provider_id: {send_provider_id}")
        email = await get_email_by_provider_id(send_provider_id)
        if email and subject in (email.get("subject") or ""):
            log(f"  Found via direct provider_id fetch!")
            return email

    for attempt in range(MAX_POLLS):
        # Try inbox listing
        emails = await list_inbox(50)
        for email in emails:
            if subject in (email.get("subject") or ""):
                log(f"  Found in inbox listing on attempt {attempt + 1}")
                return email

        # Try all-emails listing (no folder filter)
        all_emails = await list_all_emails(50)
        for email in all_emails:
            if subject in (email.get("subject") or ""):
                log(f"  Found in all-emails listing on attempt {attempt + 1} (NOT in inbox filter)")
                return email

        log(f"  Poll {attempt + 1}/{MAX_POLLS}: not found in inbox or all-emails, waiting {POLL_INTERVAL}s...")
        await asyncio.sleep(POLL_INTERVAL)
    return None


async def find_email_by_message_id(rfc_message_id: str) -> dict | None:
    """Search for email by RFC Message-ID."""
    data = await api("GET", "/api/v1/emails", params={
        "account_id": ACCOUNT_ID,
        "message_id": rfc_message_id,
    })
    items = data.get("items", [])
    return items[0] if items else None


async def check_email_in_inbox(subject: str, wait: int = 30) -> bool:
    """Check if email with subject is in inbox within wait seconds."""
    polls = wait // POLL_INTERVAL
    for attempt in range(polls):
        emails = await list_inbox(50)
        for email in emails:
            if subject in (email.get("subject") or ""):
                return True
        log(f"  Check {attempt + 1}/{polls}: not in inbox yet...")
        await asyncio.sleep(POLL_INTERVAL)
    return False


# ============================================================================
# LOGGING
# ============================================================================

_log_lines: list[str] = []

def log(msg: str) -> None:
    """Print and buffer a log line."""
    print(msg)
    _log_lines.append(msg)


def save_log(filename: str) -> None:
    """Write buffered log to output file."""
    path = OUTPUT_DIR / filename
    path.write_text("\n".join(_log_lines) + "\n")
    print(f"\nLog saved to {path}")


def save_json(filename: str, data: Any) -> None:
    """Write JSON data to output file."""
    path = OUTPUT_DIR / filename
    path.write_text(json.dumps(data, indent=2, default=str) + "\n")
    print(f"JSON saved to {path}")


# ============================================================================
# INVESTIGATION
# ============================================================================

async def step_1_dump_folders() -> dict:
    """Dump all folders and identify inbox provider_id."""
    log("\n=== STEP 1: List all folders ===")
    folders = await list_folders()
    save_json("folders.json", folders)

    folder_summary = {}
    for f in folders:
        role = f.get("role", "")
        log(f"  name={f.get('name'):<30} role={role:<10} id={f.get('id'):<30} provider_id={f.get('provider_id')}")
        if role:
            folder_summary[role.lower()] = {
                "id": f.get("id"),
                "provider_id": f.get("provider_id"),
                "name": f.get("name"),
            }

    return folder_summary


async def step_2_send_and_find(subject: str) -> dict:
    """Send email to self and find it in inbox."""
    log(f"\n=== STEP 2: Send email (subject: {subject}) ===")
    send_result = await send_email(subject, f"Test body for {RUN_ID}")
    log(f"  Send result: {json.dumps(send_result, indent=2)}")

    send_provider_id = send_result.get("provider_id")
    log(f"  send provider_id: {send_provider_id}")
    log(f"  Waiting {DELIVERY_WAIT}s for delivery...")
    await asyncio.sleep(DELIVERY_WAIT)

    email = await find_email_by_subject(subject, send_provider_id=send_provider_id)
    if not email:
        log("  FATAL: Email not found in inbox after polling. Cannot continue.")
        sys.exit(1)

    log(f"  Found email: id={email['id']} provider_id={email.get('provider_id')}")
    save_json("found_email.json", email)

    # Also get headers to capture RFC Message-ID
    detail = await get_email_detail(email["id"], include_headers=True)
    rfc_msg_id = None
    for h in detail.get("headers", []):
        if h.get("name", "").lower() == "message-id":
            rfc_msg_id = h["value"]
            break
    log(f"  RFC Message-ID: {rfc_msg_id}")
    save_json("email_detail_with_headers.json", detail)

    return {"email": email, "rfc_message_id": rfc_msg_id}


async def step_3_archive(email_id: str) -> None:
    """Archive the email (PUT folders=[])."""
    log(f"\n=== STEP 3: Archive email {email_id} ===")
    result = await move_email(email_id, [])
    log(f"  Archive result: {json.dumps(result, indent=2)}")


async def step_4_verify_gone(subject: str) -> None:
    """Verify email is no longer in inbox."""
    log(f"\n=== STEP 4: Verify email gone from inbox ===")
    await asyncio.sleep(5)
    emails = await list_inbox(50)
    found = bool([e for e in emails if subject in (e.get("subject") or "")])
    log(f"  Still in inbox after archive: {found}")
    if found:
        log("  WARNING: Email still in inbox after archive. Sync delay?")


async def step_5_undo_attempts(
    email_id: str,
    subject: str,
    rfc_message_id: str | None,
    folders: dict,
) -> str | None:
    """Try multiple undo approaches and report which one works.

    Returns the name of the approach that worked, or None.
    """
    inbox_provider_id = folders.get("inbox", {}).get("provider_id", "")
    inbox_internal_id = folders.get("inbox", {}).get("id", "")

    # -------------------------------------------------------
    # Attempt A: Current implementation -- original ID + provider_id
    # -------------------------------------------------------
    log(f"\n=== STEP 5A: Undo with original email_id + inbox provider_id ===")
    log(f"  email_id={email_id}, folders=[{inbox_provider_id}]")
    result_a = await move_email(email_id, [inbox_provider_id])
    log(f"  PUT result: {json.dumps(result_a, indent=2)}")
    await asyncio.sleep(10)

    if await check_email_in_inbox(subject, wait=20):
        log("  SUCCESS: Email reappeared in inbox with approach A!")
        return "A_original_id_provider_id"
    log("  FAILED: Email NOT in inbox after approach A")

    # Check if email still exists under original ID
    log("  Checking if email still exists under original ID...")
    try:
        detail = await get_email_detail(email_id)
        log(f"  Email exists: id={detail.get('id')} folders={detail.get('folders', [])}")
        save_json("email_after_undo_a.json", detail)
    except Exception as e:
        log(f"  Email NOT found under original ID: {e}")

    # -------------------------------------------------------
    # Attempt B: Re-find by RFC Message-ID first (like Outlook path)
    # -------------------------------------------------------
    if rfc_message_id:
        log(f"\n=== STEP 5B: Re-find by Message-ID, then undo ===")
        refound = await find_email_by_message_id(rfc_message_id)
        if refound:
            new_id = refound["id"]
            log(f"  Re-found email: new_id={new_id} (original was {email_id})")
            log(f"  IDs match: {new_id == email_id}")
            save_json("refound_email.json", refound)

            result_b = await move_email(new_id, [inbox_provider_id])
            log(f"  PUT result: {json.dumps(result_b, indent=2)}")
            await asyncio.sleep(10)

            if await check_email_in_inbox(subject, wait=20):
                log("  SUCCESS: Email reappeared with approach B (re-find + provider_id)!")
                return "B_refind_provider_id"
            log("  FAILED: approach B did not work")
        else:
            log(f"  Could not re-find email by Message-ID: {rfc_message_id}")

    # -------------------------------------------------------
    # Attempt C: Use inbox internal ID instead of provider_id
    # -------------------------------------------------------
    log(f"\n=== STEP 5C: Undo with inbox internal ID ===")
    target_id = email_id
    if rfc_message_id:
        refound = await find_email_by_message_id(rfc_message_id)
        if refound:
            target_id = refound["id"]
    log(f"  target_id={target_id}, folders=[{inbox_internal_id}]")
    result_c = await move_email(target_id, [inbox_internal_id])
    log(f"  PUT result: {json.dumps(result_c, indent=2)}")
    await asyncio.sleep(10)

    if await check_email_in_inbox(subject, wait=20):
        log("  SUCCESS: Email reappeared with approach C (internal ID)!")
        return "C_internal_id"
    log("  FAILED: approach C did not work")

    # -------------------------------------------------------
    # Attempt D: Use raw string "INBOX"
    # -------------------------------------------------------
    log(f"\n=== STEP 5D: Undo with raw 'INBOX' string ===")
    if rfc_message_id:
        refound = await find_email_by_message_id(rfc_message_id)
        if refound:
            target_id = refound["id"]
    log(f"  target_id={target_id}, folders=['INBOX']")
    result_d = await move_email(target_id, ["INBOX"])
    log(f"  PUT result: {json.dumps(result_d, indent=2)}")
    await asyncio.sleep(10)

    if await check_email_in_inbox(subject, wait=20):
        log("  SUCCESS: Email reappeared with approach D (raw INBOX)!")
        return "D_raw_inbox"
    log("  FAILED: approach D did not work")

    # -------------------------------------------------------
    # Attempt E: Re-find + raw "INBOX"
    # -------------------------------------------------------
    if rfc_message_id:
        log(f"\n=== STEP 5E: Re-find + raw 'INBOX' ===")
        refound = await find_email_by_message_id(rfc_message_id)
        if refound:
            new_id = refound["id"]
            log(f"  Re-found: new_id={new_id}")
            result_e = await move_email(new_id, ["INBOX"])
            log(f"  PUT result: {json.dumps(result_e, indent=2)}")
            await asyncio.sleep(10)

            if await check_email_in_inbox(subject, wait=20):
                log("  SUCCESS: Email reappeared with approach E (re-find + raw INBOX)!")
                return "E_refind_raw_inbox"
            log("  FAILED: approach E did not work")

    # -------------------------------------------------------
    # Attempt F: Check what the email detail looks like now
    # and dump all folder info for analysis
    # -------------------------------------------------------
    log(f"\n=== STEP 5F: Final diagnostic dump ===")
    if rfc_message_id:
        refound = await find_email_by_message_id(rfc_message_id)
        if refound:
            detail = await get_email_detail(refound["id"], include_headers=True)
            log(f"  Final email state: {json.dumps(detail, indent=2)}")
            save_json("email_final_state.json", detail)

    return None


# ============================================================================
# MAIN
# ============================================================================

async def main() -> None:
    log(f"Gmail Unipile Undo Investigation - Run {RUN_ID}")
    log(f"Account: {ACCOUNT_ID}")
    log(f"Email: {EMAIL_ADDRESS}")
    log(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}")

    # Step 1: Dump folders
    folders = await step_1_dump_folders()

    # Step 2: Send email and find it
    subject = f"[{RUN_ID}] Undo investigation"
    email_data = await step_2_send_and_find(subject)
    email_id = email_data["email"]["id"]
    rfc_message_id = email_data["rfc_message_id"]

    # Step 3: Archive it
    await step_3_archive(email_id)

    # Step 4: Verify gone
    await step_4_verify_gone(subject)

    # Step 5: Try undo approaches
    winner = await step_5_undo_attempts(email_id, subject, rfc_message_id, folders)

    # Summary
    log(f"\n{'=' * 60}")
    log(f"RESULT: {'Approach ' + winner + ' worked!' if winner else 'NO APPROACH WORKED'}")
    log(f"{'=' * 60}")

    save_log("investigation_log.txt")


if __name__ == "__main__":
    asyncio.run(main())
