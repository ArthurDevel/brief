# Unipile Message-ID Investigation

Investigates whether RFC Message-ID can solve the Outlook undo problem (issue #168).

## Context

After moving an Outlook email via Unipile, both `id` and `provider_id` return 404. This breaks undo because the stored email ID is stale. Gmail IDs stay stable, so this is Outlook-only.

## What We Tested

### Test 1: `include_headers` on GET -- can we get the RFC Message-ID?

**Result: YES, works for both Gmail and Outlook.**

`GET /api/v1/emails/{provider_id}?account_id=X&include_headers=true` returns the full email headers. The `Message-ID` header is present in both providers.

- Gmail: 10 headers, `Message-Id` present
- Outlook: 74 headers, `Message-ID` present

Important: GET only works with `provider_id`, not Unipile's internal `id`.

### Test 2: `message_id` filter on GET /api/v1/emails -- can we re-find by RFC Message-ID?

**Result: Works for Outlook, does NOT work for Gmail.**

`GET /api/v1/emails?account_id=X&message_id=<RFC-Message-ID>`:
- Outlook: returns the email with its NEW id and provider_id (after the old ones went stale)
- Gmail: returns 0 results regardless of format (with/without angle brackets, URL-encoded)

This is acceptable because Gmail doesn't need this -- its IDs stay stable after moves.

### Test 3: PUT response body -- does it return useful data?

**Result: No. Returns only `{"object": "EmailUpdated"}`.**

No new ID, no new provider_id, no message_id. The PUT response is useless for getting the new identifier.

### Test 4: Full RFC Message-ID undo flow

**Result: Full undo flow works end-to-end for Outlook.**

Flow:
1. Fetch email with `include_headers=true` to get RFC Message-ID
2. Move email to trash via PUT (using `provider_id`)
3. Old provider_id returns 404 (confirmed -- IDs go stale)
4. Re-find email via `GET /api/v1/emails?message_id=<RFC-Message-ID>` -- gets new IDs
5. Move back to inbox via PUT using the NEW id
6. Email reappears in inbox

## Conclusion

The RFC Message-ID approach is viable for Outlook undo:

1. **Before move**: fetch headers to get the RFC Message-ID
2. **Store in undo recipe**: the `message_id` alongside the email_id
3. **On undo**: use `message_id` filter to re-find the email, then PUT with new ID

For Gmail: the existing approach works (IDs are stable), but the `message_id` filter does not work. The undo code should branch: use `message_id` re-find for Outlook, use direct ID for Gmail. Alternatively, always try direct ID first, fall back to `message_id` re-find on 404.

## Scripts

- `test_message_id_approach.py` -- Full investigation script covering all 4 tests
