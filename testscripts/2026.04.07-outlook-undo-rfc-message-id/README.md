# Outlook Undo via RFC Message-ID - Debug Script

## Goal

Investigate why Outlook Unipile undo tests fail: after archiving an email and then undoing (PUT back to inbox folder), the email does not reappear in inbox listings.

## Background

Outlook/Exchange changes the email's internal ID when it is moved between folders. Our fix uses the stable RFC 2822 Message-ID header to re-find the email after a move, then PUTs with the new ID. The e2e tests show the undo PUT succeeds (no error), but the email still does not appear in inbox.

## How to run

```bash
cd testscripts/2026.04.07-outlook-undo-rfc-message-id
python3 debug_outlook_undo.py
```

Requires: `httpx`, `python-dotenv` (both already in the voice-pipeline venv).

## What it tests

1. Send a test email to ourselves
2. Find it in inbox
3. Fetch RFC Message-ID header before move
4. Archive the email (PUT with archive folder)
5. Re-find by Message-ID after move
6. Undo: PUT back to inbox folder using re-found ID
7. Check if email reappears in inbox (8 attempts, 5s apart)
8. If it fails: fetch email detail to see what folder it ended up in

## Results

### Finding: Wrong folder ID type in PUT requests

The root cause was NOT the stale email ID (though that is real for Outlook). The actual bug:

`_resolve_folder_by_role()` in `unipile_client.py` returned `f["id"]` (Unipile internal ID, e.g. `SsCgO_52V3-M4eECS1MVHg`), but the PUT `/api/v1/emails/{id}` endpoint's `folders` field needs the **`provider_id`** (the Exchange folder ID, e.g. `AQMkADAwATM3ZmY...`).

When using the Unipile internal ID:
- The PUT returns `{"object": "EmailUpdated"}` (200 OK -- no error)
- Unipile's metadata is updated (re-find shows `folders: ['<inbox_unipile_id>']`)
- But the email does NOT actually move in Exchange
- Inbox listing (which filters by `provider_id`) does not return it

When using the provider_id:
- The PUT actually moves the email in Exchange
- Email appears in inbox listing within 5 seconds

### Fix

Changed `_resolve_folder_by_role()` to return `f["provider_id"]` instead of `f["id"]`.
Also changed `list_folders()` to return `provider_id` in `FolderInfo.path` (used by `move_to_folder`).

### Verification

After the fix, all 4 Outlook Unipile undo e2e tests pass:
- `test_archive_undo_restores_to_inbox[Outlook (Unipile)]` -- PASSED
- `test_delete_undo_restores_to_inbox[Outlook (Unipile)]` -- PASSED
- `test_move_to_folder_undo_restores_to_inbox[Outlook (Unipile)]` -- PASSED
- `test_move_to_user_folder_undo_restores[Outlook (Unipile)]` -- PASSED
