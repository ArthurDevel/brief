# IMAP readThread Self-Reply Investigation

## Goal
Figure out why `readThread` in `imap-client.ts` fails to find replies when a Gmail account replies to itself (or receives a reply). The E2E tests showed `readThread` returning 1 message instead of 2 after a reply was sent.

## Root Cause
**Gmail does not support IMAP HEADER search on the `References` header.**

The current `readThread` implementation searches All Mail by:
1. `HEADER message-id <id>` -- finds the original message (works)
2. `HEADER references <id>` -- should find replies that reference the original (**returns 0 results on Gmail**)

The reply IS in All Mail (confirmed by SUBJECT search finding both messages), and it DOES have the correct `References` header (confirmed by fetching the raw envelope). Gmail simply does not index the `References` header for IMAP HEADER search.

## Fix
Search by `HEADER in-reply-to <id>` in addition to `HEADER references <id>`. Gmail DOES support IMAP HEADER search on `In-Reply-To`, and this correctly finds the reply.

## Test Results

| Search strategy | Mailbox | Found |
|---|---|---|
| `HEADER message-id` (original's ID) | All Mail | 1 (original) |
| `HEADER references` (original's ID) | All Mail | **0** |
| `HEADER references` (original's ID) | Sent Mail | **0** |
| `HEADER in-reply-to` (original's ID) | All Mail | **1 (reply found)** |
| `SUBJECT` search | All Mail | 2 (both found) |

## Files
- `investigate.ts` -- standalone script that sends an email, sends a self-reply, then searches by different IMAP HEADER strategies
- `output/results.txt` -- full output of the investigation
