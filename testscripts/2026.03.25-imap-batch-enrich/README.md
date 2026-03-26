# IMAP Batch Enrichment Benchmark

## Goal

Benchmark sequential vs batched IMAP metadata fetching for the end-of-session email enrichment step.

## Problem

The current enrichment flow iterates over ~170 email actions and for each one:
1. Acquires a mailbox lock on INBOX
2. Fetches the envelope (subject + from) for a single message
3. Releases the lock

This results in ~170 sequential lock acquire/release cycles plus 170 individual FETCH commands. With ~170 actions, this takes 10+ seconds and causes timeout failures.

## What we're testing

Three approaches:

**A: Sequential (current behavior)**
One lock acquisition and one `fetchOne` call per UID. This is the baseline we want to replace.

**B: Batched by UID**
A single lock acquisition followed by a single `client.fetch(allUids)` call that returns all envelopes at once. Expected to be significantly faster.

**C: Sequential by Message-ID under a single lock**
For cases where only Message-IDs are known (not UIDs). Searches for each Message-ID with `client.search()` then fetches the envelope -- but holds the lock open for the entire loop instead of re-acquiring per iteration. Tests whether eliminating lock overhead helps when the underlying search is still sequential.

## How to run

```bash
npm install
npx tsx benchmark.ts
```

Results are printed to the terminal and saved to `output/results.json`.

## Results

| Approach | Emails | Total (ms) | Avg per email (ms) |
|---|---|---|---|
| A: Sequential (lock-per-UID) | 50 | 11,846 | 236.9 |
| B: Batched (single FETCH) | 50 | 743 | 14.9 |
| C: Sequential by Message-ID (single lock) | 50 | 19,305 | 386.1 |

### Takeaways

- **Batched UID fetch is ~16x faster** than the current sequential approach (743ms vs 11,846ms for 50 emails).
- Holding a single lock while doing sequential Message-ID searches (Approach C) is still slow due to the per-message SEARCH round-trip, but it avoids the connection-drop issue seen when re-acquiring 50+ locks in rapid succession.
- For 170 actions at the current sequential rate (~237ms/email), that is ~40 seconds. Batched, it would be ~2.5 seconds.
- The main optimization to implement: group all UID-based lookups into a single `client.fetch(uidSet, { envelope: true })` call under one lock.
