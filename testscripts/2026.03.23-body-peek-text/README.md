# BODY.PEEK[TEXT] fetch strategy comparison

## Goal

Determine if `BODY.PEEK[TEXT]` can replace the current N+1 IMAP round trip pattern in `_fetch_summaries`, which causes voice pipeline timeouts at scale.

## Setup

Hoodiecrow in-memory IMAP server with 5 email types:
1. Plain text (`text/plain`)
2. HTML-only (`text/html`)
3. Multipart alternative (`text/plain` + `text/html`)
4. Multipart mixed (text + attachment)
5. Nested multipart (`multipart/mixed` > `multipart/alternative` > text + html)

## Results

| Strategy | Fetch calls (5 emails) | Plain | HTML | Multipart alt | Mixed + attach | Nested |
|---|---|---|---|---|---|---|
| A: Current (batch headers + N individual) | 6 | OK | OK | OK | OK | FAIL |
| B: BODY.PEEK[TEXT] (single batch) | 1 | OK | OK | Raw MIME | Raw MIME | Raw MIME |
| C: BODY.PEEK[1] (single batch) | 1 | OK | OK | OK | OK | FAIL |

## Analysis

- **Strategy A** (current): 1 batch + N individual fetches. At 350ms/RT on Gmail, 20 emails = 21 round trips = 7.3s, hitting the 8s timeout. Also fails on nested multipart.
- **Strategy B** (`BODY.PEEK[TEXT]`): 1 fetch call regardless of email count. For simple emails returns clean text. For multipart emails returns raw MIME body with boundaries -- needs `email.message_from_bytes()` to extract the text/plain part. Handles all email types including nested.
- **Strategy C** (`BODY.PEEK[1]`): 1 fetch call but fails on nested multipart (part 1 is another multipart container, not the text).

## Conclusion

`BODY.PEEK[TEXT]` is the best option:
- Eliminates N+1 round trips entirely (1 call instead of N+1)
- Handles all email structures including nested multipart
- Trade-off: requires Python MIME parsing for multipart emails (trivial with `email` stdlib module)
- Strictly better than current approach, which both has N+1 AND fails on nested multipart

## How to run

```bash
cd apps/voice-pipeline
python3 ../../testscripts/2026.03.23-body-peek-text/test_fetch_strategies.py
```
