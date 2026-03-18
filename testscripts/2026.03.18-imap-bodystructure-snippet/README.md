# IMAP BODYSTRUCTURE Snippet Extraction Test

Tests whether we can extract email snippets efficiently using IMAP BODYSTRUCTURE.

## Approach

Instead of downloading full email bodies to generate snippets, this script:

1. Fetches ENVELOPE + BODYSTRUCTURE for recent emails (lightweight metadata)
2. Walks the BODYSTRUCTURE tree to find the `text/plain` part (falls back to `text/html`)
3. Fetches only that specific MIME part with a byte limit (`BODY.PEEK[part]<0.500>`)

This should be significantly faster than downloading and parsing full emails.

## Usage

```bash
# From this directory, using the voice-pipeline venv:
../../apps/voice-pipeline/.venv/bin/python3 test_bodystructure.py
```

Requires `TEST_IMAP_USER` and `TEST_IMAP_PASSWORD` in the voice-pipeline `.env` file.
