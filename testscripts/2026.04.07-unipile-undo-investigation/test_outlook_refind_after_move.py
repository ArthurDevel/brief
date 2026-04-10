"""
Investigate whether we can find an Outlook email in its destination folder after a move
(since both provider_id and Unipile id return 404 after moving), and then move it back
to inbox using the NEW id.

Also tests Gmail archive behavior: whether PUT {"folders": []} actually archives,
and what alternatives exist.

Run: python3 test_outlook_refind_after_move.py
"""

import asyncio
import os
import time
from urllib.parse import quote

import httpx
from dotenv import load_dotenv

# ============================================================================
# CONSTANTS
# ============================================================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(SCRIPT_DIR, ".env"))

UNIPILE_API_KEY = os.environ["UNIPILE_API_KEY"]
UNIPILE_DSN = os.environ["UNIPILE_DSN"]

OUTLOOK_ACCOUNT_ID = os.environ["TEST_OUTLOOK_UNIPILE_ACCOUNT_ID"]
OUTLOOK_EMAIL = os.environ["TEST_OUTLOOK_UNIPILE_EMAIL"]

GMAIL_ACCOUNT_ID = os.environ["TEST_GMAIL_UNIPILE_ACCOUNT_ID"]
GMAIL_EMAIL = os.environ["TEST_GMAIL_UNIPILE_EMAIL"]

HEADERS = {
    "X-API-KEY": UNIPILE_API_KEY,
    "Accept": "application/json",
    "Content-Type": "application/json",
}


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================


async def api(client: httpx.AsyncClient, method: str, path: str, body: dict | None = None) -> dict:
    """Make an API call to Unipile. Returns {status, ok, data}."""
    url = f"{UNIPILE_DSN}{path}"
    response = await client.request(method, url, json=body, headers=HEADERS, timeout=30)
    try:
        data = response.json()
    except Exception:
        data = response.text
    return {"status": response.status_code, "ok": response.is_success, "data": data}


def log(label: str, obj=None):
    """Print a labeled section."""
    print(f"\n--- {label} ---")
    if obj is not None:
        if isinstance(obj, str):
            print(obj)
        else:
            import json
            print(json.dumps(obj, indent=2, default=str))


def find_email_by_subject(items: list, search_term: str) -> dict | None:
    """Find an email in a list by partial subject match."""
    if not items:
        return None
    for item in items:
        if search_term in (item.get("subject") or ""):
            return item
    return None


# ============================================================================
# TEST 1: OUTLOOK - REFIND AFTER MOVE
# ============================================================================


async def test_outlook_refind_after_move(client: httpx.AsyncClient):
    """
    Test whether we can find an Outlook email in trash after moving it there,
    get its new ID, and move it back to inbox.
    """
    print("\n" + "=" * 70)
    print("TEST 1: OUTLOOK - REFIND EMAIL AFTER MOVE TO TRASH")
    print("=" * 70)

    # -- Step 1: List folders, find inbox and trash --
    log("Step 1: Listing folders")
    folders_res = await api(client, "GET", f"/api/v1/folders?account_id={OUTLOOK_ACCOUNT_ID}")
    if not folders_res["ok"]:
        print(f"FAILED to list folders: {folders_res['status']}")
        return

    folders = folders_res["data"].get("items", [])
    inbox_folder = next((f for f in folders if f.get("role") == "inbox"), None)
    trash_folder = next((f for f in folders if f.get("role") == "trash"), None)

    if not inbox_folder or not trash_folder:
        print(f"Missing folders. inbox={inbox_folder}, trash={trash_folder}")
        return

    inbox_id = inbox_folder["id"]
    trash_id = trash_folder["id"]
    trash_provider_id = trash_folder.get("provider_id", "")
    print(f"Inbox: id={inbox_id}")
    print(f"Trash: id={trash_id}, provider_id={trash_provider_id}")

    # -- Step 2: Send a test email to self --
    timestamp = int(time.time())
    tag = f"Outlook refind {timestamp}"
    subject = f"[test-refind] {tag}"

    log("Step 2: Sending test email to self")
    print(f"Subject: {subject}")

    send_res = await api(client, "POST", "/api/v1/emails", {
        "account_id": OUTLOOK_ACCOUNT_ID,
        "to": [{"identifier": OUTLOOK_EMAIL}],
        "subject": subject,
        "body": "test body for refind investigation",
    })
    print(f"Send result: status={send_res['status']}, ok={send_res['ok']}")

    if not send_res["ok"]:
        print(f"FAILED to send email: {send_res['data']}")
        return

    # -- Step 3: Wait for email to arrive --
    log("Step 3: Waiting 15s for email to arrive in inbox")
    await asyncio.sleep(15)

    # -- Step 4: Find email in inbox (retry up to 60s) --
    log("Step 4: Finding email in inbox")
    email = None
    for attempt in range(6):
        list_res = await api(client, "GET", f"/api/v1/emails?account_id={OUTLOOK_ACCOUNT_ID}&limit=30")
        items = list_res["data"].get("items", [])
        if attempt == 0:
            print(f"  Inbox has {len(items)} emails, first 3 subjects: {[i.get('subject','?')[:50] for i in items[:3]]}")
        email = find_email_by_subject(items, tag)
        if email:
            break
        print(f"  Not found (attempt {attempt+1}/6), waiting 10s...")
        await asyncio.sleep(10)

    if not email:
        print("FAILED: Could not find test email in inbox after 60s")
        return

    old_id = email["id"]
    old_provider_id = email.get("provider_id", "")

    # -- Step 5: Print BEFORE state --
    log("Step 5: BEFORE move")
    print(f"  id:          {old_id}")
    print(f"  provider_id: {old_provider_id}")

    # -- Step 6: Move to trash --
    log("Step 6: Moving to trash via PUT")
    move_res = await api(
        client, "PUT",
        f"/api/v1/emails/{old_provider_id}?account_id={OUTLOOK_ACCOUNT_ID}",
        {"folders": [trash_id]},
    )
    print(f"Move result: status={move_res['status']}, ok={move_res['ok']}")
    print(f"Response: {move_res['data']}")

    # -- Step 7: Wait for re-sync --
    log("Step 7: Waiting 10s for Unipile to re-sync")
    await asyncio.sleep(10)

    # -- Step 8: Strategy A - List emails in trash folder --
    log("Step 8: Strategy A - List emails in trash folder")

    strategy_a_results = {}

    # Attempt 1: folder={trash_id}
    res_a1 = await api(client, "GET", f"/api/v1/emails?account_id={OUTLOOK_ACCOUNT_ID}&folder={trash_id}&limit=20")
    found_a1 = find_email_by_subject(res_a1["data"].get("items", []), tag)
    strategy_a_results["trash_id"] = {
        "status": res_a1["status"],
        "found": found_a1 is not None,
        "email": found_a1,
        "total_items": len(res_a1["data"].get("items", [])),
    }
    print(f"  folder={trash_id}: status={res_a1['status']}, items={strategy_a_results['trash_id']['total_items']}, found={found_a1 is not None}")

    # Attempt 2: folder=TRASH
    res_a2 = await api(client, "GET", f"/api/v1/emails?account_id={OUTLOOK_ACCOUNT_ID}&folder=TRASH&limit=20")
    found_a2 = find_email_by_subject(res_a2["data"].get("items", []), tag)
    strategy_a_results["TRASH"] = {
        "status": res_a2["status"],
        "found": found_a2 is not None,
        "total_items": len(res_a2["data"].get("items", [])),
    }
    print(f"  folder=TRASH: status={res_a2['status']}, items={strategy_a_results['TRASH']['total_items']}, found={found_a2 is not None}")

    # Attempt 3: folder={trash_provider_id}
    trash_pid_encoded = quote(trash_provider_id, safe="")
    res_a3 = await api(client, "GET", f"/api/v1/emails?account_id={OUTLOOK_ACCOUNT_ID}&folder={trash_pid_encoded}&limit=20")
    found_a3 = find_email_by_subject(res_a3["data"].get("items", []), tag)
    strategy_a_results["trash_provider_id"] = {
        "status": res_a3["status"],
        "found": found_a3 is not None,
        "total_items": len(res_a3["data"].get("items", [])),
    }
    print(f"  folder={trash_provider_id}: status={res_a3['status']}, items={strategy_a_results['trash_provider_id']['total_items']}, found={found_a3 is not None}")

    # Pick whichever found the email
    found_in_trash = found_a1 or found_a2 or found_a3
    strategy_a_found = found_in_trash is not None

    # -- Step 9: Strategy B - Search by subject --
    log("Step 9: Strategy B - Search by subject")

    strategy_b_results = {}

    # Attempt 1: query param
    encoded_subject = quote(subject, safe="")
    res_b1 = await api(client, "GET", f"/api/v1/emails?account_id={OUTLOOK_ACCOUNT_ID}&query={encoded_subject}")
    found_b1 = find_email_by_subject(res_b1["data"].get("items", []), tag)
    strategy_b_results["query"] = {
        "status": res_b1["status"],
        "found": found_b1 is not None,
        "total_items": len(res_b1["data"].get("items", [])),
    }
    print(f"  query={subject[:40]}...: status={res_b1['status']}, items={strategy_b_results['query']['total_items']}, found={found_b1 is not None}")

    # Attempt 2: q param
    res_b2 = await api(client, "GET", f"/api/v1/emails?account_id={OUTLOOK_ACCOUNT_ID}&q={encoded_subject}")
    found_b2 = find_email_by_subject(res_b2["data"].get("items", []), tag)
    strategy_b_results["q"] = {
        "status": res_b2["status"],
        "found": found_b2 is not None,
        "total_items": len(res_b2["data"].get("items", [])),
    }
    print(f"  q={subject[:40]}...: status={res_b2['status']}, items={strategy_b_results['q']['total_items']}, found={found_b2 is not None}")

    strategy_b_found = found_b1 or found_b2
    found_after_move = found_in_trash or strategy_b_found

    new_id = None
    new_provider_id = None
    move_back_status = "SKIPPED"
    move_back_body = "N/A"
    email_back_in_inbox = "UNKNOWN"

    if found_after_move:
        new_id = found_after_move["id"]
        new_provider_id = found_after_move.get("provider_id", "")
        print(f"\nFound email with NEW ids:")
        print(f"  new id:          {new_id}")
        print(f"  new provider_id: {new_provider_id}")

        # -- Step 10: Move back to inbox --
        log("Step 10: Moving back to inbox using new provider_id")
        move_back_res = await api(
            client, "PUT",
            f"/api/v1/emails/{new_provider_id}?account_id={OUTLOOK_ACCOUNT_ID}",
            {"folders": [inbox_id]},
        )
        move_back_status = move_back_res["status"]
        move_back_body = move_back_res["data"]
        print(f"Move back result: status={move_back_status}, ok={move_back_res['ok']}")
        print(f"Response: {move_back_body}")

        # Wait and check inbox
        print("Waiting 5s to check if email returned to inbox...")
        await asyncio.sleep(5)

        check_res = await api(client, "GET", f"/api/v1/emails?account_id={OUTLOOK_ACCOUNT_ID}&limit=30")
        check_email = find_email_by_subject(check_res["data"].get("items", []), tag)
        email_back_in_inbox = "YES" if check_email else "NO"
        print(f"Email back in inbox: {email_back_in_inbox}")
    else:
        print("\nCould not find email after move -- skipping move-back test")

    # -- Step 11: Summary --
    print("\n" + "=" * 70)
    print("=== OUTLOOK REFIND AFTER MOVE - SUMMARY ===")
    print("=" * 70)
    print(f"Original: id={old_id}, provider_id={old_provider_id}")
    print(f"After move to trash:")
    print(f"  Strategy A (list trash folder): {'FOUND' if strategy_a_found else 'NOT FOUND'}")
    print(f"    - tried folder={trash_id}: status={strategy_a_results['trash_id']['status']} found={'yes' if strategy_a_results['trash_id']['found'] else 'no'}")
    print(f"    - tried folder=TRASH: status={strategy_a_results['TRASH']['status']} found={'yes' if strategy_a_results['TRASH']['found'] else 'no'}")
    print(f"    - tried folder={trash_provider_id}: status={strategy_a_results['trash_provider_id']['status']} found={'yes' if strategy_a_results['trash_provider_id']['found'] else 'no'}")
    print(f"  Strategy B (search by subject): {'FOUND' if strategy_b_found else 'NOT FOUND'}")
    print(f"    - tried query=...: status={strategy_b_results['query']['status']} found={'yes' if strategy_b_results['query']['found'] else 'no'}")
    print(f"    - tried q=...: status={strategy_b_results['q']['status']} found={'yes' if strategy_b_results['q']['found'] else 'no'}")
    print(f"New IDs: id={new_id}, provider_id={new_provider_id}")
    print(f"Move back to inbox: {move_back_status} {move_back_body}")
    print(f"Email back in inbox: {email_back_in_inbox}")


# ============================================================================
# TEST 2: GMAIL - ARCHIVE INVESTIGATION
# ============================================================================


async def test_gmail_archive(client: httpx.AsyncClient):
    """
    Test Gmail archive behavior: does PUT {"folders": []} actually archive?
    If not, what alternatives work?
    """
    print("\n" + "=" * 70)
    print("TEST 2: GMAIL - ARCHIVE INVESTIGATION")
    print("=" * 70)

    # -- Step 1: List folders --
    log("Step 1: Listing Gmail folders")
    folders_res = await api(client, "GET", f"/api/v1/folders?account_id={GMAIL_ACCOUNT_ID}")
    if not folders_res["ok"]:
        print(f"FAILED to list folders: {folders_res['status']}")
        return

    folders = folders_res["data"].get("items", [])
    inbox_folder = next((f for f in folders if f.get("role") == "inbox"), None)

    if not inbox_folder:
        print("No inbox folder found!")
        return

    inbox_id = inbox_folder["id"]
    inbox_provider_id = inbox_folder.get("provider_id", "")
    inbox_pid_encoded = quote(inbox_provider_id, safe="")
    print(f"Inbox: id={inbox_id}, provider_id={inbox_provider_id}")

    # Print all folders for reference
    print("\nAll Gmail folders:")
    for f in folders:
        print(f"  id={f['id']} provider_id={f.get('provider_id', '')} role={f.get('role', '')} name={f.get('name', '')}")

    # -- Step 2: Send a test email to self --
    timestamp = int(time.time())
    tag = f"Gmail archive {timestamp}"
    subject = f"[test-archive] {tag}"

    log("Step 2: Sending test email to self (Gmail)")
    print(f"Subject: {subject}")

    send_res = await api(client, "POST", "/api/v1/emails", {
        "account_id": GMAIL_ACCOUNT_ID,
        "to": [{"identifier": GMAIL_EMAIL}],
        "subject": subject,
        "body": "test body for Gmail archive investigation",
    })
    print(f"Send result: status={send_res['status']}, ok={send_res['ok']}")

    if not send_res["ok"]:
        print(f"FAILED to send email: {send_res['data']}")
        return

    # -- Step 3: Wait and find in inbox (retry up to 60s) --
    log("Step 3: Waiting for email to arrive in inbox")
    await asyncio.sleep(15)
    email = None
    for attempt in range(6):
        list_res = await api(client, "GET", f"/api/v1/emails?account_id={GMAIL_ACCOUNT_ID}&limit=30")
        items = list_res["data"].get("items", [])
        if attempt == 0:
            print(f"  Inbox has {len(items)} emails, first 3 subjects: {[i.get('subject','?')[:50] for i in items[:3]]}")
        email = find_email_by_subject(items, tag)
        if email:
            break
        print(f"  Not found (attempt {attempt+1}/6), waiting 10s...")
        await asyncio.sleep(10)

    if not email:
        print("FAILED: Could not find test email in inbox after 75s")
        return

    original_id = email["id"]
    original_provider_id = email.get("provider_id", "")
    print(f"Found email: id={original_id}, provider_id={original_provider_id}")

    # -- Step 4: GET the email to see current folders --
    log("Step 4: GET email to inspect current folders")
    get_res = await api(client, "GET", f"/api/v1/emails/{original_id}?account_id={GMAIL_ACCOUNT_ID}")
    if get_res["ok"]:
        email_data = get_res["data"]
        print(f"  folders: {email_data.get('folders', 'NOT PRESENT')}")
        print(f"  labels:  {email_data.get('labels', 'NOT PRESENT')}")
        print(f"  keys:    {list(email_data.keys()) if isinstance(email_data, dict) else 'N/A'}")
    else:
        print(f"GET by id failed: {get_res['status']}")
        # Try provider_id
        get_res2 = await api(client, "GET", f"/api/v1/emails/{original_provider_id}?account_id={GMAIL_ACCOUNT_ID}")
        print(f"GET by provider_id: status={get_res2['status']}")
        if get_res2["ok"]:
            email_data = get_res2["data"]
            print(f"  folders: {email_data.get('folders', 'NOT PRESENT')}")

    # -- Step 5: Try archive with PUT {"folders": []} --
    log("Step 5: Attempting archive with PUT {\"folders\": []}")
    archive_res = await api(
        client, "PUT",
        f"/api/v1/emails/{original_provider_id}?account_id={GMAIL_ACCOUNT_ID}",
        {"folders": []},
    )
    archive_status = archive_res["status"]
    archive_body = archive_res["data"]
    print(f"Archive result: status={archive_status}, ok={archive_res['ok']}")
    print(f"Response: {archive_body}")

    await asyncio.sleep(5)

    # Check if still in inbox
    check_res = await api(client, "GET", f"/api/v1/emails?account_id={GMAIL_ACCOUNT_ID}&limit=10&folder={inbox_pid_encoded}")
    still_in_inbox = find_email_by_subject(check_res["data"].get("items", []), tag) is not None
    print(f"Still in inbox after empty folders PUT: {still_in_inbox}")

    # -- Results tracking --
    archive_empty_worked = not still_in_inbox

    # -- Step 6: If still in inbox, try alternatives --
    alt_category_status = "SKIPPED"
    alt_category_result = "N/A"
    alt_delete_status = "SKIPPED"
    alt_delete_result = "N/A"
    email_after_delete_location = "N/A"

    if still_in_inbox:
        # Alternative A: Move to a non-inbox folder
        log("Step 6A: Trying PUT with CATEGORY_FORUMS folder")
        cat_res = await api(
            client, "PUT",
            f"/api/v1/emails/{original_provider_id}?account_id={GMAIL_ACCOUNT_ID}",
            {"folders": ["CATEGORY_FORUMS"]},
        )
        alt_category_status = cat_res["status"]
        alt_category_result = cat_res["data"]
        print(f"CATEGORY_FORUMS result: status={alt_category_status}, ok={cat_res['ok']}")
        print(f"Response: {alt_category_result}")

        await asyncio.sleep(3)

        check_res2 = await api(client, "GET", f"/api/v1/emails?account_id={GMAIL_ACCOUNT_ID}&limit=10&folder={inbox_pid_encoded}")
        still_in_inbox_2 = find_email_by_subject(check_res2["data"].get("items", []), tag) is not None
        print(f"Still in inbox after CATEGORY_FORUMS PUT: {still_in_inbox_2}")

        # Alternative B: DELETE the email
        log("Step 6B: Trying DELETE")
        del_res = await api(
            client, "DELETE",
            f"/api/v1/emails/{original_id}?account_id={GMAIL_ACCOUNT_ID}",
        )
        alt_delete_status = del_res["status"]
        alt_delete_result = del_res["data"]
        print(f"DELETE result: status={alt_delete_status}, ok={del_res['ok']}")
        print(f"Response: {alt_delete_result}")

        await asyncio.sleep(3)

        # Check inbox
        check_res3 = await api(client, "GET", f"/api/v1/emails?account_id={GMAIL_ACCOUNT_ID}&limit=10&folder={inbox_pid_encoded}")
        still_in_inbox_3 = find_email_by_subject(check_res3["data"].get("items", []), tag) is not None

        if not still_in_inbox_3:
            # Try to find where it went (trash?)
            trash_folder = next((f for f in folders if f.get("role") == "trash"), None)
            if trash_folder:
                trash_pid = quote(trash_folder.get("provider_id", ""), safe="")
                trash_res = await api(client, "GET", f"/api/v1/emails?account_id={GMAIL_ACCOUNT_ID}&folder={trash_pid}&limit=10")
                in_trash = find_email_by_subject(trash_res["data"].get("items", []), tag) is not None
                email_after_delete_location = "TRASH" if in_trash else "UNKNOWN"
            else:
                email_after_delete_location = "no trash folder found"
        else:
            email_after_delete_location = "STILL_IN_INBOX"

        print(f"Email location after DELETE: {email_after_delete_location}")
    else:
        # Archive worked -- try to GET the email to see what happened to it
        log("Step 6: Archive worked! Checking email state")
        get_after = await api(client, "GET", f"/api/v1/emails/{original_id}?account_id={GMAIL_ACCOUNT_ID}")
        print(f"GET after archive: status={get_after['status']}")
        if get_after["ok"]:
            print(f"  folders: {get_after['data'].get('folders', 'NOT PRESENT')}")

    # -- Summary --
    print("\n" + "=" * 70)
    print("=== GMAIL ARCHIVE INVESTIGATION - SUMMARY ===")
    print("=" * 70)
    print(f"Original: id={original_id}, provider_id={original_provider_id}")
    print(f"PUT {{\"folders\": []}}: status={archive_status}, removed from inbox={'YES' if archive_empty_worked else 'NO'}")
    if still_in_inbox:
        print(f"PUT {{\"folders\": [\"CATEGORY_FORUMS\"]}}: status={alt_category_status}")
        print(f"DELETE: status={alt_delete_status}, email went to={email_after_delete_location}")
    else:
        print("Archive with empty folders worked -- no alternatives needed")


# ============================================================================
# ENTRY POINT
# ============================================================================


async def main():
    """Run both Outlook refind and Gmail archive tests."""
    async with httpx.AsyncClient() as client:
        await test_outlook_refind_after_move(client)
        print("\n\n")
        await test_gmail_archive(client)


if __name__ == "__main__":
    asyncio.run(main())
