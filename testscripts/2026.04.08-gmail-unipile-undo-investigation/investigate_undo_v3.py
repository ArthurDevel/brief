"""
Investigation v3: Test undo by checking email folder state directly.

Key finding from v1/v2:
- Unipile's GET /emails?folder=INBOX listing for this Gmail account has severe
  sync delays (>60s). Emails sent to self never appear in the inbox listing.
- But emails ARE accessible by provider_id immediately and by internal ID after ~20s.
- This means the inbox listing is the wrong way to verify undo success.

This version:
- Checks the email's actual folder/label state (from email detail) instead of listing
- Tests archive, delete, move_to_folder undo flows
- Also tests whether Gmail changes the Unipile ID after moves (like Outlook does)
"""

import asyncio
import json
import os
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
RUN_ID = f"undo-v3-{int(time.time() * 1000)}"

POLL_INTERVAL = 5
MAX_POLLS = 12


# ============================================================================
# API HELPERS
# ============================================================================

async def api(
    method: str,
    path: str,
    params: dict | None = None,
    json_body: dict | None = None,
) -> tuple[int, dict]:
    """Make a Unipile API request. Returns (status_code, body)."""
    url = f"{UNIPILE_DSN}{path}"
    headers = {"X-API-KEY": UNIPILE_API_KEY, "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.request(method, url, headers=headers, params=params, json=json_body)
    log(f"  {method} {path} -> {resp.status_code}")
    data = resp.json()
    return resp.status_code, data


async def send_email(subject: str) -> str:
    """Send email to self, return provider_id."""
    _, data = await api("POST", "/api/v1/emails", json_body={
        "account_id": ACCOUNT_ID,
        "to": [{"identifier": EMAIL_ADDRESS}],
        "subject": subject,
        "body": f"Body for {RUN_ID}",
    })
    return data["provider_id"]


async def wait_for_sync(provider_id: str) -> str:
    """Wait until email is accessible by internal ID. Returns internal_id."""
    log(f"  Waiting for {provider_id} to sync...")
    for attempt in range(MAX_POLLS):
        status, data = await api("GET", f"/api/v1/emails/{provider_id}",
                                 params={"account_id": ACCOUNT_ID})
        if data.get("id"):
            internal_id = data["id"]
            s2, _ = await api("GET", f"/api/v1/emails/{internal_id}",
                              params={"account_id": ACCOUNT_ID})
            if s2 == 200:
                log(f"  Synced after {(attempt + 1) * POLL_INTERVAL}s: internal_id={internal_id}")
                return internal_id
        await asyncio.sleep(POLL_INTERVAL)
    raise RuntimeError(f"Email {provider_id} never synced")


async def get_email_folders(email_id: str) -> tuple[list[str], list[str], dict[str, Any]]:
    """Get the folder names/IDs from an email's detail."""
    _, data = await api("GET", f"/api/v1/emails/{email_id}",
                        params={"account_id": ACCOUNT_ID})
    # Unipile returns folders in different formats depending on provider
    folders = data.get("folders", [])
    # Also check for "labels" which Gmail might use
    labels = data.get("labels", [])
    log(f"  Email {email_id}: folders={folders}, labels={labels}")
    return folders, labels, data


async def get_rfc_message_id(email_id: str) -> str | None:
    """Fetch RFC Message-ID header."""
    _, data = await api("GET", f"/api/v1/emails/{email_id}",
                        params={"account_id": ACCOUNT_ID, "include_headers": "true"})
    for h in data.get("headers", []):
        if h.get("name", "").lower() == "message-id":
            return h["value"]
    return None


async def refind_by_message_id(rfc_message_id: str) -> str | None:
    """Re-find email by Message-ID, return new internal ID or None."""
    _, data = await api("GET", "/api/v1/emails",
                        params={"account_id": ACCOUNT_ID, "message_id": rfc_message_id})
    items = data.get("items", [])
    return items[0]["id"] if items else None


async def get_folder_provider_id(role: str) -> str:
    """Get folder provider_id by role."""
    _, data = await api("GET", "/api/v1/folders", params={"account_id": ACCOUNT_ID})
    for f in data.get("items", []):
        if (f.get("role") or "").lower() == role.lower():
            return f["provider_id"]
    raise RuntimeError(f"No folder with role '{role}'")


async def move_email(email_id: str, folders: list[str]) -> tuple[int, dict]:
    """PUT /emails/{id} with folders."""
    return await api("PUT", f"/api/v1/emails/{email_id}",
                     params={"account_id": ACCOUNT_ID},
                     json_body={"folders": folders})


# ============================================================================
# LOGGING
# ============================================================================

_log_lines: list[str] = []

def log(msg: str) -> None:
    print(msg)
    _log_lines.append(msg)

def save_output() -> None:
    (OUTPUT_DIR / "investigation_v3_log.txt").write_text("\n".join(_log_lines) + "\n")

def save_json(filename: str, data: Any) -> None:
    (OUTPUT_DIR / filename).write_text(json.dumps(data, indent=2, default=str) + "\n")


# ============================================================================
# TESTS
# ============================================================================

async def test_archive_undo() -> dict[str, Any]:
    """Archive -> check folder state -> undo -> check folder state."""
    log(f"\n{'='*60}")
    log("TEST: Archive + Undo")
    log(f"{'='*60}")

    inbox_pid = await get_folder_provider_id("inbox")
    subject = f"[{RUN_ID}] archive"

    # Send and wait for sync
    provider_id = await send_email(subject)
    internal_id = await wait_for_sync(provider_id)

    # Get initial state
    log("\n  --- Initial state ---")
    folders_before, labels_before, detail_before = await get_email_folders(internal_id)
    save_json("archive_01_before.json", detail_before)

    rfc_msg_id = await get_rfc_message_id(internal_id)
    log(f"  RFC Message-ID: {rfc_msg_id}")

    # Archive (PUT folders=[])
    log("\n  --- Archive (PUT folders=[]) ---")
    status, result = await move_email(internal_id, [])
    log(f"  Status: {status}, Result: {json.dumps(result)}")

    # Wait a bit for the move to propagate
    await asyncio.sleep(10)

    # Check state after archive
    log("\n  --- State after archive ---")
    folders_after_archive, labels_after_archive, detail_after_archive = await get_email_folders(internal_id)
    save_json("archive_02_after_archive.json", detail_after_archive)

    # Check if ID changed
    id_changed = False
    if rfc_msg_id:
        new_id = await refind_by_message_id(rfc_msg_id)
        if new_id and new_id != internal_id:
            log(f"  ID CHANGED after archive: {internal_id} -> {new_id}")
            id_changed = True
            internal_id = new_id
        else:
            log(f"  ID unchanged: {internal_id}")

    # Undo (PUT folders=[inbox_provider_id])
    log(f"\n  --- Undo (PUT folders=[{inbox_pid}]) ---")
    undo_target_id = internal_id
    status, result = await move_email(undo_target_id, [inbox_pid])
    log(f"  Status: {status}, Result: {json.dumps(result)}")

    await asyncio.sleep(10)

    # Check state after undo
    log("\n  --- State after undo ---")
    # If ID changed again, re-find
    if rfc_msg_id:
        newest_id = await refind_by_message_id(rfc_msg_id)
        if newest_id and newest_id != undo_target_id:
            log(f"  ID changed again after undo: {undo_target_id} -> {newest_id}")
            undo_target_id = newest_id

    folders_after_undo, labels_after_undo, detail_after_undo = await get_email_folders(undo_target_id)
    save_json("archive_03_after_undo.json", detail_after_undo)

    # Determine success: check if INBOX label is back
    inbox_restored = "INBOX" in str(folders_after_undo) or "INBOX" in str(labels_after_undo)
    log(f"\n  INBOX restored: {inbox_restored}")
    log(f"  ID changed during archive: {id_changed}")

    return {
        "test": "archive_undo",
        "inbox_restored": inbox_restored,
        "id_changed_on_archive": id_changed,
        "archive_status": status,
        "folders_before": folders_before,
        "folders_after_archive": folders_after_archive,
        "folders_after_undo": folders_after_undo,
    }


async def test_delete_undo() -> dict[str, Any]:
    """Delete (move to trash) -> undo -> check."""
    log(f"\n{'='*60}")
    log("TEST: Delete + Undo")
    log(f"{'='*60}")

    inbox_pid = await get_folder_provider_id("inbox")
    trash_pid = await get_folder_provider_id("trash")
    subject = f"[{RUN_ID}] delete"

    provider_id = await send_email(subject)
    internal_id = await wait_for_sync(provider_id)

    log("\n  --- Initial state ---")
    folders_before, labels_before, detail_before = await get_email_folders(internal_id)
    save_json("delete_01_before.json", detail_before)

    rfc_msg_id = await get_rfc_message_id(internal_id)
    log(f"  RFC Message-ID: {rfc_msg_id}")

    # Delete (move to trash)
    log(f"\n  --- Delete (PUT folders=[{trash_pid}]) ---")
    status, result = await move_email(internal_id, [trash_pid])
    log(f"  Status: {status}, Result: {json.dumps(result)}")
    await asyncio.sleep(10)

    log("\n  --- State after delete ---")
    folders_after_delete, _, detail_after_delete = await get_email_folders(internal_id)
    save_json("delete_02_after_delete.json", detail_after_delete)

    # Check ID change
    id_changed = False
    if rfc_msg_id:
        new_id = await refind_by_message_id(rfc_msg_id)
        if new_id and new_id != internal_id:
            log(f"  ID CHANGED: {internal_id} -> {new_id}")
            id_changed = True
            internal_id = new_id

    # Undo
    log(f"\n  --- Undo (PUT folders=[{inbox_pid}]) ---")
    status, result = await move_email(internal_id, [inbox_pid])
    log(f"  Status: {status}, Result: {json.dumps(result)}")
    await asyncio.sleep(10)

    log("\n  --- State after undo ---")
    if rfc_msg_id:
        newest_id = await refind_by_message_id(rfc_msg_id)
        if newest_id and newest_id != internal_id:
            internal_id = newest_id

    folders_after_undo, labels_after_undo, detail_after_undo = await get_email_folders(internal_id)
    save_json("delete_03_after_undo.json", detail_after_undo)

    inbox_restored = "INBOX" in str(folders_after_undo) or "INBOX" in str(labels_after_undo)
    log(f"\n  INBOX restored: {inbox_restored}")
    log(f"  ID changed during delete: {id_changed}")

    return {
        "test": "delete_undo",
        "inbox_restored": inbox_restored,
        "id_changed_on_delete": id_changed,
        "folders_before": folders_before,
        "folders_after_delete": folders_after_delete,
        "folders_after_undo": folders_after_undo,
    }


async def test_move_undo() -> dict[str, Any]:
    """Move to trash -> undo -> check."""
    log(f"\n{'='*60}")
    log("TEST: Move to folder + Undo")
    log(f"{'='*60}")

    inbox_pid = await get_folder_provider_id("inbox")
    trash_pid = await get_folder_provider_id("trash")
    subject = f"[{RUN_ID}] move"

    provider_id = await send_email(subject)
    internal_id = await wait_for_sync(provider_id)

    log("\n  --- Initial state ---")
    folders_before, labels_before, detail_before = await get_email_folders(internal_id)
    save_json("move_01_before.json", detail_before)

    rfc_msg_id = await get_rfc_message_id(internal_id)
    log(f"  RFC Message-ID: {rfc_msg_id}")

    # Move to trash
    log(f"\n  --- Move (PUT folders=[{trash_pid}]) ---")
    status, result = await move_email(internal_id, [trash_pid])
    log(f"  Status: {status}, Result: {json.dumps(result)}")
    await asyncio.sleep(10)

    log("\n  --- State after move ---")
    folders_after_move, _, detail_after_move = await get_email_folders(internal_id)
    save_json("move_02_after_move.json", detail_after_move)

    id_changed = False
    if rfc_msg_id:
        new_id = await refind_by_message_id(rfc_msg_id)
        if new_id and new_id != internal_id:
            log(f"  ID CHANGED: {internal_id} -> {new_id}")
            id_changed = True
            internal_id = new_id

    # Undo
    log(f"\n  --- Undo (PUT folders=[{inbox_pid}]) ---")
    status, result = await move_email(internal_id, [inbox_pid])
    log(f"  Status: {status}, Result: {json.dumps(result)}")
    await asyncio.sleep(10)

    log("\n  --- State after undo ---")
    if rfc_msg_id:
        newest_id = await refind_by_message_id(rfc_msg_id)
        if newest_id and newest_id != internal_id:
            internal_id = newest_id

    folders_after_undo, labels_after_undo, detail_after_undo = await get_email_folders(internal_id)
    save_json("move_03_after_undo.json", detail_after_undo)

    inbox_restored = "INBOX" in str(folders_after_undo) or "INBOX" in str(labels_after_undo)
    log(f"\n  INBOX restored: {inbox_restored}")
    log(f"  ID changed during move: {id_changed}")

    return {
        "test": "move_undo",
        "inbox_restored": inbox_restored,
        "id_changed_on_move": id_changed,
        "folders_before": folders_before,
        "folders_after_move": folders_after_move,
        "folders_after_undo": folders_after_undo,
    }


# ============================================================================
# MAIN
# ============================================================================

async def main() -> None:
    log(f"Gmail Unipile Undo Investigation v3 - {RUN_ID}")
    log(f"Account: {ACCOUNT_ID} / {EMAIL_ADDRESS}")
    log(f"Time: {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime())}")

    results = []
    results.append(await test_archive_undo())
    results.append(await test_delete_undo())
    results.append(await test_move_undo())

    log(f"\n{'='*60}")
    log("SUMMARY")
    log(f"{'='*60}")
    for r in results:
        status = "PASS" if r["inbox_restored"] else "FAIL"
        id_note = " (ID changed!)" if r.get("id_changed_on_archive") or r.get("id_changed_on_delete") or r.get("id_changed_on_move") else ""
        log(f"  {r['test']}: {status}{id_note}")
        log(f"    folders before:     {r.get('folders_before')}")
        key = [k for k in r.keys() if 'after_archive' in k or 'after_delete' in k or 'after_move' in k]
        if key:
            log(f"    folders after move: {r[key[0]]}")
        log(f"    folders after undo: {r.get('folders_after_undo')}")

    save_json("investigation_v3_results.json", results)
    save_output()


if __name__ == "__main__":
    asyncio.run(main())
