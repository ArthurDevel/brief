"""
Test script: BODYSTRUCTURE-based snippet extraction from IMAP emails.

Connects to an IMAP inbox and uses the BODYSTRUCTURE command to identify
the text/plain (or text/html) MIME part for each email, then fetches only
that part with a size limit to extract a snippet.

This avoids downloading full email bodies just to get a preview.
"""

import base64
import os
import quopri
import sys
from pathlib import Path

from dotenv import load_dotenv
from imapclient import IMAPClient


# ============================================================================
# CONSTANTS
# ============================================================================

SNIPPET_BYTE_LIMIT = 500
NUM_EMAILS = 5
ENV_FILE = Path(__file__).resolve().parents[2] / "apps" / "voice-pipeline" / ".env"


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _find_text_part(bodystructure, path=None):
    """Walk BODYSTRUCTURE to find the best text part (text/plain preferred, text/html fallback).

    imapclient parses BODYSTRUCTURE into:
    - Leaf part: tuple starting with bytes type, e.g. (b'TEXT', b'PLAIN', ...)
    - Multipart: tuple where first element is a list of child parts,
      e.g. ([child1, child2], b'ALTERNATIVE', ...)

    Args:
        bodystructure: Parsed BODYSTRUCTURE from imapclient.
        path: Current MIME part path (e.g. [1], [1, 2]).

    Returns:
        Tuple of (mime_type, part_path, encoding, charset) or None if no text part found.
    """
    if path is None:
        path = []

    # Check if this is a multipart: first element is a list of children
    if isinstance(bodystructure[0], list):
        children = bodystructure[0]
        plain_result = None
        html_result = None
        for i, child in enumerate(children):
            part_num = i + 1
            result = _find_text_part(child, path + [part_num])
            if result:
                mime = result[0]
                if mime == "text/plain" and plain_result is None:
                    plain_result = result
                elif mime == "text/html" and html_result is None:
                    html_result = result
        return plain_result or html_result
    else:
        # Leaf part: (type, subtype, params, id, desc, encoding, size, ...)
        mime_type = _to_str(bodystructure[0]).lower()
        mime_subtype = _to_str(bodystructure[1]).lower()
        full_type = f"{mime_type}/{mime_subtype}"
        encoding = _to_str(bodystructure[5]).lower() if bodystructure[5] else "7bit"

        # Extract charset from params (index 2), which is a tuple like (b'CHARSET', b'utf-8', ...)
        charset = "utf-8"
        params = bodystructure[2]
        if params:
            param_list = list(params) if isinstance(params, tuple) else params
            for j in range(0, len(param_list) - 1, 2):
                if _to_str(param_list[j]).upper() == "CHARSET":
                    charset = _to_str(param_list[j + 1]).lower()

        # Use current path, or [1] if at the root (single-part message)
        part_path = path if path else [1]

        if full_type == "text/plain":
            return ("text/plain", part_path, encoding, charset)
        elif full_type == "text/html":
            return ("text/html", part_path, encoding, charset)
        return None


def _to_str(value):
    """Convert bytes to str if needed."""
    if isinstance(value, bytes):
        return value.decode("ascii", errors="replace")
    return str(value)


def _decode_snippet(raw_bytes, encoding="7bit", charset="utf-8"):
    """Decode raw email body bytes into a readable snippet string.

    Handles content-transfer-encoding (base64, quoted-printable) and charset.

    Args:
        raw_bytes: Raw bytes from IMAP BODY fetch.
        encoding: Content-Transfer-Encoding (e.g. 'base64', 'quoted-printable', '7bit').
        charset: Character set (e.g. 'utf-8', 'iso-8859-1').

    Returns:
        Decoded and cleaned-up text string.
    """
    if not raw_bytes:
        return "(empty)"

    # Step 1: Decode content-transfer-encoding
    if encoding == "base64":
        decoded_bytes = base64.b64decode(raw_bytes)
    elif encoding == "quoted-printable":
        decoded_bytes = quopri.decodestring(raw_bytes)
    else:
        decoded_bytes = raw_bytes

    # Step 2: Decode charset to string
    try:
        text = decoded_bytes.decode(charset)
    except (UnicodeDecodeError, LookupError):
        text = decoded_bytes.decode("latin-1")

    # Step 3: Collapse whitespace for readability
    lines = text.strip().splitlines()
    cleaned = " ".join(line.strip() for line in lines if line.strip())
    return cleaned[:300]


def _extract_subject(envelope):
    """Extract subject string from IMAP ENVELOPE.

    Args:
        envelope: ENVELOPE object from imapclient.

    Returns:
        Subject as a string.
    """
    subject = envelope.subject
    if isinstance(subject, bytes):
        try:
            subject = subject.decode("utf-8")
        except UnicodeDecodeError:
            subject = subject.decode("latin-1")
    return subject or "(no subject)"


# ============================================================================
# MAIN LOGIC
# ============================================================================

def main():
    # Load env vars from voice-pipeline .env
    if ENV_FILE.exists():
        load_dotenv(ENV_FILE)
        print(f"Loaded env from: {ENV_FILE}")
    else:
        print(f"WARNING: .env file not found at {ENV_FILE}")

    host = os.environ.get("TEST_IMAP_HOST", "imap.gmail.com")
    port = int(os.environ.get("TEST_IMAP_PORT", "993"))
    user = os.environ.get("TEST_IMAP_USER")
    password = os.environ.get("TEST_IMAP_PASSWORD")

    if not user or not password:
        print("ERROR: TEST_IMAP_USER and TEST_IMAP_PASSWORD must be set.")
        sys.exit(1)

    print(f"Connecting to {host}:{port} as {user}...")
    client = IMAPClient(host, port=port, ssl=True)
    client.login(user, password)
    print("Logged in successfully.\n")

    # Select INBOX
    client.select_folder("INBOX", readonly=True)

    # Get the most recent N message UIDs
    uids = client.search(["ALL"])
    recent_uids = uids[-NUM_EMAILS:]
    print(f"Fetching {len(recent_uids)} most recent emails (UIDs: {recent_uids})\n")

    # Fetch ENVELOPE + BODYSTRUCTURE for those UIDs
    fetch_data = client.fetch(recent_uids, ["ENVELOPE", "BODYSTRUCTURE"])

    for uid in recent_uids:
        msg_data = fetch_data.get(uid, {})
        envelope = msg_data.get(b"ENVELOPE")
        bodystructure = msg_data.get(b"BODYSTRUCTURE")

        subject = _extract_subject(envelope) if envelope else "(no envelope)"
        print(f"--- UID {uid} ---")
        print(f"Subject: {subject}")

        if not bodystructure:
            print("Snippet: (no BODYSTRUCTURE)")
            print()
            continue

        result = _find_text_part(bodystructure)
        if not result:
            print("Snippet: (no text part found in BODYSTRUCTURE)")
            print(f"BODYSTRUCTURE: {bodystructure}")
            print()
            continue

        mime_type, part_path, encoding, charset = result
        part_spec = ".".join(str(p) for p in part_path)
        print(f"Text part: {mime_type} at BODY[{part_spec}] (encoding={encoding}, charset={charset})")

        # Fetch just that part (no byte range -- Gmail can reject partial on nested parts)
        fetch_key = f"BODY.PEEK[{part_spec}]"
        part_data = client.fetch([uid], [fetch_key])

        # imapclient returns the key as bytes like b'BODY[1.1]'
        snippet_bytes = None
        for key, value in part_data.get(uid, {}).items():
            key_str = _to_str(key) if isinstance(key, bytes) else str(key)
            if "BODY" in key_str.upper() and part_spec in key_str:
                snippet_bytes = value
                break

        snippet = _decode_snippet(snippet_bytes, encoding, charset)
        print(f"Snippet: {snippet}")
        print()

    client.logout()
    print("Done.")


if __name__ == "__main__":
    main()
