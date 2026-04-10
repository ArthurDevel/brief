# Gmail Unipile Undo Investigation

## Goal

Figure out why Gmail Unipile undo e2e tests were xfailed: the PUT succeeds (HTTP 200) but the email does not reappear in inbox listing within 30s.

## What was tested

Three undo flows via direct Unipile API calls (no app imports):
- **archive** (PUT folders=[]) -> undo (PUT folders=[INBOX])
- **delete** (PUT folders=[TRASH]) -> undo (PUT folders=[INBOX])
- **move_to_folder** (PUT folders=[TRASH]) -> undo (PUT folders=[INBOX])

## Findings

### The undo logic is correct

All three operations undo successfully. After undo, the email's folder state includes INBOX:
```
archive: ['SENT'] -> ['SENT'] -> ['SENT', 'INBOX']
delete:  ['SENT'] -> ['SENT', 'TRASH'] -> ['SENT', 'INBOX']
move:    ['SENT'] -> ['SENT', 'TRASH'] -> ['SENT', 'INBOX']
```

### Gmail does NOT change Unipile IDs after moves

Unlike Outlook, Gmail keeps the same Unipile internal ID after archive/delete/move. The `_refind_email_by_message_id` path (used for Outlook) is not needed for Gmail.

### The real problem: inbox listing sync delay

`GET /api/v1/emails?folder=INBOX` has severe sync delays for this Gmail account:
- Emails sent to self appear with `folders: ['SENT']` only
- The inbox listing never returns newly delivered emails within 60+ seconds
- But emails ARE accessible by provider_id immediately and by internal ID within ~15-25s
- After undo, the email's folder state correctly shows INBOX, but the listing endpoint does not reflect this quickly

### Root cause of e2e test failures

The e2e tests verified undo success by polling `list_inbox` (GET /emails?folder=INBOX). This listing has too much sync delay to be reliable for Gmail Unipile accounts. The undo itself works -- only the verification method was wrong.

## Fix applied

Changed the e2e test verification for Gmail Unipile undo tests:
- **Finding email**: Use `GET /api/v1/emails` (no folder filter) instead of `list_inbox`
- **Verify mutation worked**: Check email's `folders` array doesn't contain `INBOX` instead of polling inbox listing
- **Verify undo worked**: Fetch email by ID and check `"INBOX"` is in the `folders` array

Result: all 12 undo tests pass (4 Gmail Unipile + 4 Outlook Unipile + 4 Gmail IMAP).

## Files

- `investigate_undo.py` - v1: initial investigation, discovered listing sync issue
- `investigate_undo_v2.py` - v2: tried longer waits, confirmed listing never works
- `investigate_undo_v3.py` - v3: verified undo works by checking folder state directly
- `output/` - JSON dumps and logs from each run
