# Session-aware inbox filtering: overfetch bugs

## Goal

Investigate why `list_inbox` still fails in production after session-aware filtering + overfetch was added. Two issues surfaced from production logs:

1. March 20 log: `list_inbox` returns "0 emails" after queuing 5 deletions (overfetch not working)
2. March 23 log: `list_inbox` times out at 8 seconds after queuing ~10 deletions (performance regression)

## Findings

### Bug 1: Tests don't actually test overfetch

The existing tests mock `email_client.with_reconnect` with a fixed return value:

```python
mock_wr.return_value = list(all_emails)  # Returns ALL emails regardless of limit
```

In production, `list_inbox(client, limit)` returns only the N most recent emails. If the user asks for 5 and all 5 most recent have pending deletes, the overfetch should request 10 to backfill. But the mock always returns everything, so the test passes even without overfetch.

**Impact:** The overfetch code is never verified. A regression could ship without being caught.

**Fix for tests:** The mock needs to respect the limit parameter. Either:
- Use `side_effect` to execute the lambda and mock `list_inbox` separately
- Or simulate production behavior: `mock_wr.side_effect = lambda h, c, op: all_emails[-requested_limit:]`

### Bug 2: Timeout from IMAP overfetch

The Supabase queries are fast (milliseconds). The timeout is from the IMAP overfetch: with 10 pending actions and limit=10, we fetch 20 emails with full BODYSTRUCTURE parsing. This can push the IMAP operation past the 8-second voice pipeline timeout. Root cause needs further investigation -- could be IMAP server latency, reconnect retries, or the overfetch count being too aggressive.

## How to run

```bash
python3 testscripts/2026.03.23-session-filtering-overfetch/test_overfetch.py
```

No dependencies required. Standalone script.
