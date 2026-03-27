# IMAP UID Enrichment Bug

Debugging why `fetchEmailMetaBatch` in `packages/email/src/imap-client.ts` returned 0 results when fetching email metadata by UID for the end-of-session summary email enrichment.

## Root Cause

The bug was in `fetchMetaByUidBatch` (line 609 of `imap-client.ts`).

ImapFlow's `fetch(range, fields, options)` only treats the range as UIDs when `{ uid: true }` is passed as the **3rd argument** (options). The code had it in the **2nd argument** (fields), which just means "include the UID value in the response data":

```typescript
// BUGGY: uid:true in fields -- "include UID in response"
client.fetch(uidSet, { envelope: true, uid: true })

// FIXED: uid:true in options -- "treat range as UIDs"
client.fetch(uidSet, { envelope: true }, { uid: true })
```

The UID strings (e.g. "17115") were interpreted as sequence numbers. Since the inbox only had ~150 messages, sequence 17115 didn't exist, returning 0 results.

## Test Script

`test.ts` connects to a real Gmail IMAP account:

1. Lists inbox, records UIDs
2. Disconnects
3. Opens a new IMAP connection (simulating the end-of-session hook scenario)
4. Tries fetching metadata with both the buggy and fixed approaches
5. Confirms: buggy approach returns 0 results, fixed approach returns all results

## Fix

One-line change in `packages/email/src/imap-client.ts` -- moved `uid: true` from fetch fields to fetch options.

A regression test was added to `packages/email/src/__tests__/imap-client.test.ts`: "fetches metadata by UID when UIDs exceed the message count" -- exploits UID gaps created by earlier archive/delete tests to ensure UIDs are treated as UIDs, not sequence numbers.
