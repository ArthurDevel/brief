"""
Investigation v2: Gmail Unipile undo with proper sync waits.

Findings from v1:
- Email fetched by provider_id works immediately after send
- Email fetched by Unipile internal ID gives 404 until fully synced
- Inbox listing (folder=INBOX) has the longest sync delay
- The undo approach A (current impl) worked once enough time passed

This version:
1. Waits for the email to be fully synced (accessible by internal ID)
2. Tests archive -> verify gone -> undo -> verify back
3. Also tests delete -> undo and move_to_folder -> undo
4. Uses provider_id for initial fetch, then waits for internal ID to sync
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

_repo_root = Path(__file__).resolve().parents[2]
load_dotenv(_repo_root / ".env.test.local")

UNIPILE_API_KEY = os.environ["UNIPILE_API_KEY"]
UNIPILE_DSN = os.environ["UNIPILE_DSN"]
ACCOUNT_ID = os.environ["TEST_GMAIL_UNIPILE_ACCOUNT_ID"]
EMAIL_ADDRESS = os.environ["TEST_GMAIL_UNIPILE_EMAIL"]

OUTPUT_DIR = Path(__file__).parent / "output"
RUN_ID = f"undo-v2-{int(time.time() * 1000)}"

POLL_INTERVAL = 5
MAX_POLLS = 12  # up to 60s


# ============================================================================
# API HELPERS
# ============================================================================

async def api(method: str, path: str, params: dict | None = None, json_body: dict | None = None) -> dict:
    """Make a Unipile API request."""
    url = f"{UNIPILE_DSN}{path}"
    headers = {"X-API-KEY": UNIPILE_API_KEY, "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.request(method, url, headers=headers, params=params, json=json_body)
    log(f"  {method} {path} params={params} body={json_body} -> {resp.status_code}")
    if resp.status_code >= 400:
        log(f"  ERROR: {resp.text}")
    return resp.json()


async def send_email(subject: str) -> str:
    """Send email to self, return provider_id."""
    data = await api("POST", "/api/v1/emails", json_body={
        "account_id": ACCOUNT_ID,
        "to": [{"identifier": EMAIL_ADDRESS}],
        "subject": subject,
        "body": f"Body for {RUN_ID}",
    })
    return data["provider_id"]


async def wait_for_email_synced(provider_id: str) -> dict:
    """Wait until the email is fully synced (accessible by internal ID AND in inbox listing)."""
    log(f"  Waiting for email {provider_id} to fully sync...")

    # Step 1: Get internal ID from provider_id
    internal_id = None
    for attempt in range(MAX_POLLS):
        data = await api("GET", f"/api/v1/emails/{provider_id}", params={"account_id": ACCOUNT_ID})
        if data.get("id"):
            internal_id = data["id"]
            # Verify internal ID also works
            check = await api("GET", f"/api/v1/emails/{internal_id}", params={"account_id": ACCOUNT_ID})
            if check.get("id") == internal_id:
                log(f"  Synced: internal_id={internal_id} (attempt {attempt + 1})")
                return data
        log(f"  Sync poll {attempt + 1}/{MAX_POLLS}...")
        await asyncio.sleep(POLL_INTERVAL)

    raise RuntimeError(f"Email {provider_id} never fully synced after {MAX_POLLS * POLL_INTERVAL}s")


async def wait_in_inbox(subject: str, should_exist: bool, label: str = "") -> bool:
    """Wait until email is (or is not) in inbox listing."""
    verb = "appear in" if should_exist else "disappear from"
    log(f"  Waiting for email to {verb} inbox... {label}")
    for attempt in range(MAX_POLLS):
        data = await api("GET", "/api/v1/emails", params={
            "account_id": ACCOUNT_ID,
            "limit": "50",
            "folder": "INBOX",
        })
        items = data.get("items", [])
        found = False
        for e in items:
            if subject in (e.get("subject") or ""):
                found = True
                break

        if found == should_exist:
            log(f"  Done: email {'found' if found else 'not found'} in inbox (attempt {attempt + 1})")
            return True
        log(f"  Poll {attempt + 1}/{MAX_POLLS}: {'found' if found else 'not found'}, expected {'found' if should_exist else 'not found'}...")
        await asyncio.sleep(POLL_INTERVAL)
    log(f"  TIMEOUT: email never {'appeared' if should_exist else 'disappeared'} in inbox")
    return False


async def get_rfc_message_id(email_id: str) -> str | None:
    """Fetch RFC Message-ID header."""
    data = await api("GET", f"/api/v1/emails/{email_id}",
                     params={"account_id": ACCOUNT_ID, "include_headers": "true"})
    for h in data.get("headers", []):
        if h.get("name", "").lower() == "message-id":
            return h["value"]
    return None


async def get_folder_provider_id(role: str) -> str:
    """Get folder provider_id by role."""
    data = await api("GET", "/api/v1/folders", params={"account_id": ACCOUNT_ID})
    for f in data.get("items", []):
        if (f.get("role") or "").lower() == role.lower():
            return f["provider_id"]
    raise RuntimeError(f"No folder with role '{role}'")


# ============================================================================
# LOGGING
# ============================================================================

_log_lines: list[str] = []

def log(msg: str) -> None:
    print(msg)
    _log_lines.append(msg)

def save_log(filename: str) -> None:
    path = OUTPUT_DIR / filename
    path.write_text("\n".join(_log_lines) + "\n")
    print(f"\nLog saved to {path}")

def save_json(filename: str, data: Any) -> None:
    path = OUTPUT_DIR / filename
    path.write_text(json.dumps(data, indent=2, default=str) + "\n")


# ============================================================================
# TEST SCENARIOS
# ============================================================================

async def test_archive_undo() -> bool:
    """Test: send -> wait sync -> archive -> undo -> verify back in inbox."""
    log(f"\n{'='*60}")
    log("TEST: Archive + Undo")
    log(f"{'='*60}")

    subject = f"[{RUN_ID}] archive-undo"
    inbox_pid = await get_folder_provider_id("inbox")

    # Send and wait for full sync
    provider_id = await send_email(subject)
    email = await wait_for_email_synced(provider_id)
    email_id = email["id"]

    # Wait until it appears in inbox listing
    in_inbox = await wait_in_inbox(subject, should_exist=True, label="after send")
    if not in_inbox:
        log("  SKIP: email never appeared in inbox listing (sync issue)")
        return False

    # Get RFC Message-ID for diagnostics
    rfc_msg_id = await get_rfc_message_id(email_id)
    log(f"  RFC Message-ID: {rfc_msg_id}")

    # Archive (PUT folders=[])
    log("\n  --- ARCHIVE ---")
    result = await api("PUT", f"/api/v1/emails/{email_id}",
                       params={"account_id": ACCOUNT_ID},
                       json_body={"folders": []})
    log(f"  Archive result: {json.dumps(result)}")

    # Verify gone from inbox
    gone = await wait_in_inbox(subject, should_exist=False, label="after archive")
    if not gone:
        log("  WARNING: email still in inbox after archive")

    # Undo: PUT folders=[inbox_provider_id]
    log("\n  --- UNDO (PUT folders=[inbox_provider_id]) ---")
    log(f"  Using email_id={email_id}, folders=[{inbox_pid}]")

    # Check if email_id still valid
    check = await api("GET", f"/api/v1/emails/{email_id}", params={"account_id": ACCOUNT_ID})
    log(f"  Email check before undo: status={check.get('status', 'ok')} id={check.get('id')}")
    save_json("archive_email_before_undo.json", check)

    # Also check if Gmail changed the ID after archive (like Outlook does)
    if rfc_msg_id:
        log(f"  Re-finding by RFC Message-ID: {rfc_msg_id}")
        refind = await api("GET", "/api/v1/emails",
                          params={"account_id": ACCOUNT_ID, "message_id": rfc_msg_id})
        refind_items = refind.get("items", [])
        if refind_items:
            refound_id = refind_items[0]["id"]
            log(f"  Re-found id={refound_id}, same as original: {refound_id == email_id}")
            if refound_id != email_id:
                log(f"  IMPORTANT: Gmail ALSO changes ID after archive! Using new ID for undo.")
                email_id = refound_id

    undo_result = await api("PUT", f"/api/v1/emails/{email_id}",
                            params={"account_id": ACCOUNT_ID},
                            json_body={"folders": [inbox_pid]})
    log(f"  Undo result: {json.dumps(undo_result)}")

    # Verify back in inbox
    back = await wait_in_inbox(subject, should_exist=True, label="after undo")
    if back:
        log("  PASS: Archive undo works!")
    else:
        log("  FAIL: Email did not reappear in inbox after undo")
    return back


async def test_delete_undo() -> bool:
    """Test: send -> wait sync -> delete (move to trash) -> undo -> verify back in inbox."""
    log(f"\n{'='*60}")
    log("TEST: Delete + Undo")
    log(f"{'='*60}")

    subject = f"[{RUN_ID}] delete-undo"
    inbox_pid = await get_folder_provider_id("inbox")
    trash_pid = await get_folder_provider_id("trash")

    provider_id = await send_email(subject)
    email = await wait_for_email_synced(provider_id)
    email_id = email["id"]

    in_inbox = await wait_in_inbox(subject, should_exist=True, label="after send")
    if not in_inbox:
        log("  SKIP: email never appeared in inbox")
        return False

    rfc_msg_id = await get_rfc_message_id(email_id)
    log(f"  RFC Message-ID: {rfc_msg_id}")

    # Delete (move to trash)
    log("\n  --- DELETE (move to trash) ---")
    result = await api("PUT", f"/api/v1/emails/{email_id}",
                       params={"account_id": ACCOUNT_ID},
                       json_body={"folders": [trash_pid]})
    log(f"  Delete result: {json.dumps(result)}")

    gone = await wait_in_inbox(subject, should_exist=False, label="after delete")

    # Undo
    log("\n  --- UNDO ---")

    # Check if ID changed
    if rfc_msg_id:
        refind = await api("GET", "/api/v1/emails",
                          params={"account_id": ACCOUNT_ID, "message_id": rfc_msg_id})
        refind_items = refind.get("items", [])
        if refind_items:
            refound_id = refind_items[0]["id"]
            log(f"  Re-found id={refound_id}, same as original: {refound_id == email_id}")
            if refound_id != email_id:
                log(f"  Gmail changes ID after delete! Using new ID.")
                email_id = refound_id

    undo_result = await api("PUT", f"/api/v1/emails/{email_id}",
                            params={"account_id": ACCOUNT_ID},
                            json_body={"folders": [inbox_pid]})
    log(f"  Undo result: {json.dumps(undo_result)}")

    back = await wait_in_inbox(subject, should_exist=True, label="after undo")
    if back:
        log("  PASS: Delete undo works!")
    else:
        log("  FAIL: Email did not reappear in inbox after undo")
    return back


async def test_move_to_folder_undo() -> bool:
    """Test: send -> wait sync -> move to trash (as target folder) -> undo -> verify back."""
    log(f"\n{'='*60}")
    log("TEST: Move to folder + Undo")
    log(f"{'='*60}")

    subject = f"[{RUN_ID}] move-undo"
    inbox_pid = await get_folder_provider_id("inbox")
    trash_pid = await get_folder_provider_id("trash")

    provider_id = await send_email(subject)
    email = await wait_for_email_synced(provider_id)
    email_id = email["id"]

    in_inbox = await wait_in_inbox(subject, should_exist=True, label="after send")
    if not in_inbox:
        log("  SKIP: email never appeared in inbox")
        return False

    rfc_msg_id = await get_rfc_message_id(email_id)
    log(f"  RFC Message-ID: {rfc_msg_id}")

    # Move to trash folder
    log("\n  --- MOVE TO TRASH ---")
    result = await api("PUT", f"/api/v1/emails/{email_id}",
                       params={"account_id": ACCOUNT_ID},
                       json_body={"folders": [trash_pid]})
    log(f"  Move result: {json.dumps(result)}")

    gone = await wait_in_inbox(subject, should_exist=False, label="after move")

    # Undo
    log("\n  --- UNDO ---")
    if rfc_msg_id:
        refind = await api("GET", "/api/v1/emails",
                          params={"account_id": ACCOUNT_ID, "message_id": rfc_msg_id})
        refind_items = refind.get("items", [])
        if refind_items:
            refound_id = refind_items[0]["id"]
            log(f"  Re-found id={refound_id}, same as original: {refound_id == email_id}")
            if refound_id != email_id:
                log(f"  Gmail changes ID after move! Using new ID.")
                email_id = refound_id

    undo_result = await api("PUT", f"/api/v1/emails/{email_id}",
                            params={"account_id": ACCOUNT_ID},
                            json_body={"folders": [inbox_pid]})
    log(f"  Undo result: {json.dumps(undo_result)}")

    back = await wait_in_inbox(subject, should_exist=True, label="after undo")
    if back:
        log("  PASS: Move undo works!")
    else:
        log("  FAIL: Email did not reappear in inbox after undo")
    return back


# ============================================================================
# MAIN
# ============================================================================

async def main() -> None:
    log(f"Gmail Unipile Undo Investigation v2 - Run {RUN_ID}")
    log(f"Account: {ACCOUNT_ID}")
    log(f"Email: {EMAIL_ADDRESS}")
    log(f"Timestamp: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}")

    results: dict[str, bool] = {}

    results["archive_undo"] = await test_archive_undo()
    results["delete_undo"] = await test_delete_undo()
    results["move_to_folder_undo"] = await test_move_to_folder_undo()

    log(f"\n{'='*60}")
    log("SUMMARY")
    log(f"{'='*60}")
    for name, passed in results.items():
        log(f"  {name}: {'PASS' if passed else 'FAIL'}")

    save_log("investigation_v2_log.txt")
    save_json("investigation_v2_results.json", results)


if __name__ == "__main__":
    asyncio.run(main())
