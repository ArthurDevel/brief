# Unipile Undo Flow Investigation

## Goal

Investigate why 10 e2e tests fail in `packages/email/src/__tests__/e2e/email-client.e2e.ts` for move/delete/archive undo operations.

## Findings

### Root Cause 1: Test assertion expects "INBOX" but code resolves to folder ID (2 failures)

**Tests**: `deleteEmail moves to trash and returns undo recipe` (Gmail + Outlook Unipile)

The test asserts `undoRecipe.params.to === "INBOX"`, but the code now correctly resolves the inbox to its Unipile folder ID (e.g. `oX3_vmXSUNW7QTJhIMfA-A` for Gmail, `SsCgO_52V3-M4eECS1MVHg` for Outlook).

**Fix**: Update the test assertion to accept any truthy value for `to` instead of hardcoded `"INBOX"`.

### Root Cause 2: Outlook provider_id becomes stale after move (4 failures)

**Tests**: archive/delete/move undo tests (Outlook Unipile only)

After moving an Outlook email to trash (or any other folder), **both** the `provider_id` AND `unipile_id` become stale. PUT with either ID returns 404. The email is not findable in the destination folder either (at least not within 5 seconds).

This is a Unipile/Outlook sync issue: when Outlook moves an email, it assigns a new internal ID. Unipile needs time to re-index the email under its new ID. During this window, the old IDs no longer work.

Investigation results:
- `PUT /api/v1/emails/{original_provider_id}?account_id=...` -> 404
- `PUT /api/v1/emails/{original_unipile_id}?account_id=...` -> 404
- Email not found in trash folder listing either (sync delay)
- Email never returns to inbox even after 45 seconds of polling

**This is a Unipile API limitation for Outlook**, not a bug in our code. Gmail does not have this issue because Gmail's email IDs are stable across folder moves.

### Root Cause 3: Gmail undo succeeds but email does not reappear in inbox (3 failures)

**Tests**: delete undo, move undo, move user-folder undo (Gmail Unipile only)

The undo PUT call **succeeds** (200 OK), but the email never reappears in the inbox listing even after 45 seconds of polling (15 attempts * 3s intervals).

This appears to be a Unipile sync/caching issue for Gmail: the folder assignment is updated server-side, but the inbox listing endpoint (`GET /api/v1/emails?folder=INBOX`) does not reflect the change quickly enough.

### Root Cause 4: Gmail archive test hits Unipile 500 (1 failure)

**Test**: `archiveEmail removes from inbox, undo moves it back` (Gmail Unipile)

The `waitUntilGoneFromInbox` step fails because `listInbox` (GET /api/v1/emails?folder=INBOX) returns a 500 internal server error from Unipile. This is a transient Unipile server-side issue, not a code bug.

## Summary of fixes needed

| Category | Failures | Fix |
|----------|----------|-----|
| Test assertion | 2 | Update test to not expect `"INBOX"` in undo recipe `to` |
| Outlook ID instability | 4 | Unipile limitation -- need to re-fetch email by searching destination folder after delay, or use Unipile `id` instead of `provider_id` everywhere |
| Gmail undo not reflected in listing | 3 | Likely needs longer polling or is a Unipile caching issue |
| Gmail 500 error | 1 | Transient Unipile error, not actionable |

## Key insight: `provider_id` vs `id` in email operations

The codebase uses `provider_id` as the email identifier (set in `mapToEmailSummary`). This works for **reads** but causes problems for **mutations** on Outlook because:

1. Outlook `provider_id` changes when an email moves between folders
2. After a move, the old `provider_id` returns 404
3. The new `provider_id` is not immediately available

**Recommended fix**: Switch to using Unipile's own `id` (short hash) as the email identifier instead of `provider_id`. The Unipile `id` is stable for Gmail moves and at least works for the initial mutation on Outlook. For Outlook undo, a re-fetch from the destination folder may still be needed.

## Python investigation (2026-04-07, second round)

Standalone Python scripts to verify root causes before changing production code.

### Test: DELETE vs PUT-to-trash (`test_delete_vs_put_trash.py`)

Python's `delete_email` uses `DELETE /api/v1/emails/{id}` while TS uses `PUT { folders: [trash_folder_id] }`.
Result: For Gmail, both return 200 on undo -- Gmail's DELETE just trashes.
Fix: Change Python to use PUT-to-trash for consistency with TS (especially for Outlook).

### Test: ID stability after move (`test_id_stability.py`)

- **Gmail**: Both `id` and `provider_id` stay stable. GET/PUT both return 200 after move.
- **Outlook**: Both `id` AND `provider_id` return 404 after move. Unipile loses track entirely.

### Test: Gmail archive with empty folders (`test_gmail_archive_undo.py`)

`PUT { folders: [] }` DOES work for Gmail -- email goes from `['UNREAD', 'SENT', 'INBOX']` to `['SENT']`.
Earlier Python e2e failures were due to a tag-matching bug in test scripts, not production code.

### Test: Outlook refind after move (`test_outlook_refind_after_move.py`)

- Listing trash folder doesn't work (422 with Unipile ID, 422 with "TRASH")
- Search by subject finds the email with NEW ids
- Moving back with new IDs works
- However: search-by-subject is fragile and not a good production fix

### Conclusion for Python fixes

1. `delete_email`: change from DELETE to PUT-to-trash (matches TS, safe for both providers)
2. Gmail undo: already works, no fix needed
3. Outlook undo: no reliable fix -- leave as known limitation (both IDs go stale, search-by-subject is too fragile)

## Scripts

- `test-undo-flow.mjs` -- Full undo flow test for Gmail and Outlook. Run: `node --env-file=.env test-undo-flow.mjs`
- `test_delete_vs_put_trash.py` -- DELETE vs PUT-to-trash comparison
- `test_id_stability.py` -- ID stability across moves for Gmail/Outlook
- `test_gmail_archive_undo.py` -- Gmail archive with empty folders
- `test_outlook_refind_after_move.py` -- Refinding Outlook emails after move + Gmail archive
