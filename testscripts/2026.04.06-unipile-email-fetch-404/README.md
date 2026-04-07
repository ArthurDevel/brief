# Unipile Email Fetch 404 Investigation

## Goal

Figure out why `GET /api/v1/emails/{id}` returns 404 for emails that were just listed via `GET /api/v1/emails?account_id=X`.

## What we tested

### test.mjs - Initial investigation

Tested various ways to fetch individual emails for account `hvrrj_AQQJCQhLzJp2Eq2g` (arthur.stockman.other@gmail.com):

| Method | Result |
|--------|--------|
| `GET /emails/{id}` | 404 |
| `GET /emails/{id}?account_id=X` | 404 |
| `GET /emails/{provider_id}?account_id=X` | **200** |
| `GET /emails/{encoded_id}` | 404 |
| `GET /emails/{deprecated_id}` | 404 |

### test2.mjs - Cross-account comparison

Tested all 5 Unipile accounts to see which ones have the 404 issue:

| Account | Email | Fetch by `id` | Fetch by `provider_id + account_id` |
|---------|-------|---------------|-------------------------------------|
| DMTYkh6uSWuy-M0MAOPTDg | me@gmail.com | 200 | 200 |
| firCn_btQWmPxq9LtLvhng | me@gmail.com | 200 | 200 |
| z1UoyN6hR9KZpZaA94mhuQ | me@gmail.com | 200 | 200 |
| bPXHbAKDSsyrV7FtralSfw | other@gmail.com | **404** | 200 |
| hvrrj_AQQJCQhLzJp2Eq2g | other@gmail.com | **404** | 200 |

## Root cause

Unipile's `GET /api/v1/emails/{id}` is unreliable for some accounts. The `id` field returned in list responses does not resolve when used as a path parameter. This appears to be an account-specific Unipile backend issue (possibly related to how the account was provisioned or synced).

The voice pipeline appeared to work because it was running against `arthur.stockman.me@gmail.com` accounts, which don't have this issue.

## Solution

Use `provider_id` + `account_id` query param instead of the Unipile `id` for all single-email fetches. Verified working in test4.mjs -- all 5 emails fetch successfully:

```
GET /api/v1/emails/{provider_id}?account_id={account_id}
```

This requires:
1. Storing `provider_id` as the email identifier (instead of `id`) in both TS and Python clients
2. Passing `account_id` as a query param on all individual email fetches (already available in both clients)
