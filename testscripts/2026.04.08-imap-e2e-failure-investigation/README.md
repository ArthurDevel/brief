# IMAP E2E Test Failure Investigation

## Goal

Figure out why the TypeScript IMAP e2e tests fail (Gmail IMAP specifically; Outlook IMAP is skipped due to missing password).

## Root Causes Found

There are **three compounding issues** that cause the Gmail IMAP beforeAll hook to exceed its 180s timeout:

### 1. No seed cache for IMAP account (primary cause)

The seed cache (`.seed-cache.json`) only has entries for `test-gmail-unipile` and `test-outlook-unipile`. There is **no cached entry for `test-gmail-imap`**, so every run triggers a full re-seed of all 13 pool emails.

Re-seeding requires:
- Sending 13 emails via SMTP: ~17s (1.3s each)
- Waiting for delivery: 15s
- Finding 13 emails via `listInbox(50)`: ~195s (15s each)

**Total: ~227s, which exceeds the 180s beforeAll timeout.**

### 2. `listInbox(50)` is extremely slow for IMAP

The IMAP `listInbox` implementation fetches envelope + bodyStructure, then makes a **separate IMAP call per email** to extract text snippets (`extractSnippetFromStructure`). This is an N+1 problem:

| Limit | Time    | Per email |
|-------|---------|-----------|
| 10    | 3.5s    | 350ms     |
| 20    | 6.2s    | 310ms     |
| 50    | 15.1s   | 302ms     |
| 100   | 31.8s   | 318ms     |

Each `findEmailBySubject` call does `listInbox(50)` = 15s. When finding 13 re-seeded emails sequentially, that's **13 x 15s = 195s** just for the find phase.

Even on the first attempt, the emails ARE in the top 50 (they were just sent), so it finds them -- but it takes 15s per find due to the N+1 snippet fetching.

### 3. Gmail daily sending limit hit

The test account (`brewdock.e2e.tests@gmail.com`) has **exceeded Gmail's daily sending limit** (500 emails/day for consumer accounts). The IMAP path sends 13 emails via SMTP for re-seeding, but the Unipile path also sends emails, and previous test runs have accumulated. This causes:

```
550-5.4.5 Daily user sending limit exceeded
```

Even if the timeout issue is fixed, re-seeding will fail when the sending limit is hit.

## Why the Cache is Empty for IMAP

The Gmail Unipile and Gmail IMAP accounts share the **same physical Gmail mailbox** (`brewdock.e2e.tests@gmail.com`), but the cache keys them separately by `record.id`:
- `test-gmail-unipile` -> uses Unipile provider_ids
- `test-gmail-imap` -> uses IMAP UIDs

These ID formats are incompatible (Unipile provider_ids vs IMAP UIDs), so they can't share cache entries. The IMAP account was never successfully seeded because it always times out, so the cache never gets populated.

## What Was Tested

1. **diagnose-imap.ts**: Tested raw IMAP operations independently. All 13 operations pass for Gmail IMAP (connect, list-mailboxes, open-inbox, list-inbox, read-email, search, folder resolution, archive+undo, disconnect). Individual operations take 0.1s - 1.6s each.

2. **simulate-beforeall.ts**: Reproduced the exact beforeAll logic. Confirmed 236s total duration, exceeding 180s timeout. Breakdown: 1.3s connect + 17s sending + 15s delivery wait + 195s finding = 228s.

3. **find-email-debug.ts**: Isolated the `listInbox` performance. Confirmed N+1 snippet fetching causes 300ms per email overhead. Also discovered Gmail sending limit is exhausted.

## Potential Fixes

1. **Use `searchEmails` instead of `listInbox` for finding seeded emails** -- `searchEmails("[e2e-ts] Seed email")` takes ~5-6s regardless of inbox size, vs 15s for `listInbox(50)`. This alone would reduce 13 finds from 195s to ~70s, fitting within 180s.

2. **Pre-populate the IMAP seed cache** -- Since both accounts share the same mailbox, send once via Unipile, then manually map the UIDs for the IMAP account. Or run a one-time seeding script.

3. **Fix the N+1 in `listInbox`** -- The snippet extraction makes one IMAP FETCH per email. Batch-fetching `BODY.PEEK[TEXT]` with the initial envelope fetch would eliminate 50 round-trips.

4. **Share seeded emails across accounts** -- Since gmail-unipile and gmail-imap share the same physical mailbox, seed once and resolve IDs per-provider rather than sending duplicate emails.
