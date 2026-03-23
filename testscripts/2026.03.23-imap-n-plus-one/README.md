# N+1 IMAP round trip timeout

## Goal

Figure out why `list_inbox` times out (8s) after queuing ~10 emails for deletion.

## Root cause

`_fetch_summaries` in `email_client.py` has an N+1 query pattern:

1. **1 batch fetch** for ENVELOPE + BODYSTRUCTURE (all emails at once)
2. **1 individual fetch per email** for the text body snippet (`_extract_snippet_via_bodystructure` calls `client.fetch([uid], [fetch_key])`)

So N emails = N+1 IMAP round trips.

With the overfetch (limit + pending count), the numbers look like:

| Scenario | Emails fetched | IMAP round trips | Est. time @ 350ms/RT |
|----------|---------------|-----------------|---------------------|
| Normal (10) | 10 | 11 | 3.9s |
| Overfetch (10+5) | 15 | 16 | 5.6s |
| Overfetch (10+10) | 20 | 21 | 7.3s |

The voice pipeline timeout is 8.0s. At 10 pending deletes + limit 10, we're at 7.3s estimated -- one slow round trip and we timeout.

## How to reproduce

Run from `apps/voice-pipeline`:

```bash
python3 ../../testscripts/2026.03.23-imap-n-plus-one/test_imap_roundtrips.py
```

## Fix options

The N+1 is the core issue. The overfetch makes it worse but isn't the root cause. Options:

1. **Batch the snippet fetch**: fetch all text parts in one IMAP call instead of one per email. `client.fetch(uids, ["BODY.PEEK[1]"])` for all UIDs at once. This collapses N+1 to 2 round trips regardless of email count.
2. **Skip snippets during overfetch**: fetch snippets only for the emails that survive filtering, not for the ones we're about to discard.
3. **Cap the overfetch**: set a maximum overfetch (e.g. limit * 2) to avoid unbounded growth.
