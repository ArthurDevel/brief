# Outlook Unipile 404 Investigation

## Goal

Figure out why Outlook Unipile mutation tests (archive, delete, move) fail with 404 on `getRfcMessageId`.

## Root Cause

**Unipile's search API (`/api/v1/emails?q=...`) ignores the query parameter for Outlook accounts.** It returns the same 100 emails in the same order regardless of what you search for.

This means `findEmailBySubject` -> `client.searchEmails(subject)` -> `emails[0].id` always returns the **same email ID** for every pool key.

Evidence from diagnostic:

```
"[e2e-ts] Seed email"           -> 100 results, first: "Re: [e2e-ts] Thread test"
"[e2e-ts] Pool deleteRecipe"    -> 100 results, first: "Re: [e2e-ts] Thread test"
"[e2e-ts] Pool archiveForward"  -> 100 results, first: "Re: [e2e-ts] Thread test"
"[e2e-ts] Pool moveUndo"        -> 100 results, first: "Re: [e2e-ts] Thread test"
```

All 13 pool keys resolve to the same email. The seed cache confirms this: 9 out of 13 keys point to the same ID (`...CCUUAAAA=`).

### Why this causes 404s

When the first mutation test (e.g. `archiveForward`) runs on that shared email, it moves it out of the inbox. Now the email's Outlook provider_id changes (Outlook assigns new IDs on move). The next test (e.g. `archiveUndo`) tries to use the same cached ID, which no longer exists -- 404.

### Why the beforeAll doesn't catch this

The cache validation step calls `readEmail(id)` for each cached key. Since all 9 keys point to the same email, the validation succeeds for all of them (the email exists). The beforeAll thinks everything is fine and doesn't re-seed.

## What Was Tested

1. **Seed cache analysis**: Confirmed 9 pool keys map to 1 email ID
2. **Unipile search API**: Confirmed `?q=` parameter is ignored for Outlook -- returns same results regardless of query
3. **client.searchEmails simulation**: Confirmed the e2e code path hits the same bug -- all searches return the same first email
4. **404 email check**: Confirmed the failing email ID from test output no longer exists in Unipile

## Fix

`findEmailBySubject` needs to match the subject client-side after fetching results, not trust that the API filtered them. For Outlook Unipile specifically, the search results contain all emails, so the code must iterate and find the one with the matching subject.

Currently:
```ts
const emails = await client.searchEmails(subject);
if (emails.length > 0) return emails[0].id;  // WRONG: always returns same email
```

Should be:
```ts
const emails = await client.searchEmails(subject);
const found = emails.find(e => e.subject.includes(subject));
if (found) return found.id;
```

This is the same pattern that was originally used when it was `listInbox` based. The subject matching was dropped when switching to `searchEmails`.
