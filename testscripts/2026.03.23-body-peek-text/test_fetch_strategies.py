"""
Compares different IMAP fetch strategies for extracting email text snippets.

Tests three approaches against 5 email types (plain, HTML-only, multipart
alternative, multipart mixed, nested multipart) to determine which strategy
can batch-fetch text in a single call vs requiring N+1 round trips.

Strategies:
  A. Current N+1 approach: batch ENVELOPE+BODYSTRUCTURE, then individual part fetches
  B. BODY.PEEK[TEXT]: fetch the TEXT body for all emails in one call
  C. BODY.PEEK[1]: fetch MIME part 1 for all emails in one call

Run from the apps/voice-pipeline directory:
  python ../../testscripts/2026.03.23-body-peek-text/test_fetch_strategies.py
"""

import os
import subprocess
import sys
from typing import cast

from imapclient import IMAPClient

# ============================================================================
# CONSTANTS
# ============================================================================

IMAP_PORT = 14_251
SNIPPET_DISPLAY_LEN = 80


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================


def start_hoodiecrow() -> subprocess.Popen:
    """Start Hoodiecrow IMAP server as a subprocess. Waits for the READY line.

    Returns:
        The subprocess handle (caller must kill it when done).

    Raises:
        RuntimeError: If the server fails to start or doesn't print READY.
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    proc = subprocess.Popen(
        ["node", os.path.join(script_dir, "_start_hoodiecrow.cjs")],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    if proc.stdout is None or proc.stderr is None:
        proc.kill()
        raise RuntimeError("Hoodiecrow subprocess has no stdout/stderr pipes")

    line = proc.stdout.readline().decode().strip()
    if not line.startswith("READY"):
        proc.kill()
        stderr_output = proc.stderr.read().decode()
        raise RuntimeError(
            f"Hoodiecrow failed to start. stdout={line!r} stderr={stderr_output!r}"
        )

    return proc


def create_counting_client(host: str, port: int) -> tuple[IMAPClient, list[int]]:
    """Create an IMAPClient with a wrapped fetch method that counts calls.

    Args:
        host: IMAP server hostname.
        port: IMAP server port.

    Returns:
        Tuple of (client, fetch_count) where fetch_count is a mutable [int].
    """
    client = IMAPClient(host, port=port, ssl=False)
    client.login("testuser", "testpass")

    original_fetch = client.fetch
    fetch_count = [0]

    def counting_fetch(*args, **kwargs):
        fetch_count[0] += 1
        return original_fetch(*args, **kwargs)

    client.fetch = counting_fetch
    return client, fetch_count


def get_subject(envelope) -> str:
    """Extract the subject string from an ENVELOPE response.

    Args:
        envelope: The ENVELOPE object from imapclient.

    Returns:
        The decoded subject string.
    """
    subject = envelope.subject
    if isinstance(subject, bytes):
        return subject.decode("utf-8", errors="replace")
    return str(subject)


def decode_body(raw: bytes | None) -> str:
    """Decode raw body bytes to a UTF-8 string.

    Args:
        raw: The raw bytes from the IMAP fetch response, or None.

    Returns:
        Decoded text string, or "(no data)" if raw is None.
    """
    if raw is None:
        return "(no data)"
    return raw.decode("utf-8", errors="replace")


def find_body_key(msg_data: dict, keyword: bytes) -> bytes | None:
    """Find a response key containing the given keyword (e.g. b"BODY" and b"TEXT").

    Args:
        msg_data: The dict of response keys for a single UID.
        keyword: Bytes to look for in the key name.

    Returns:
        The matching key, or None if not found.
    """
    for key in msg_data:
        if isinstance(key, bytes) and keyword in key:
            return key
    return None


def find_text_part_spec(bodystructure) -> str:
    """Walk a BODYSTRUCTURE to find the first text/plain part spec.

    Falls back to text/html if no text/plain is found.
    Falls back to "1" if nothing is recognized.

    Args:
        bodystructure: The parsed BODYSTRUCTURE from imapclient.

    Returns:
        The MIME part specifier string (e.g. "1", "1.1", "2").
    """
    # imapclient returns bodystructure as nested tuples
    # For simple messages: (content_type, subtype, params, id, desc, encoding, size)
    # For multipart: ([part1, part2, ...], content_type)

    return _walk_bodystructure(bodystructure, "")


def _walk_bodystructure(bs, prefix: str) -> str:
    """Recursively walk bodystructure to find the first text/plain part.

    Args:
        bs: A bodystructure node (could be a list for multipart or a single part).
        prefix: The current MIME part number prefix.

    Returns:
        The part spec string for the first text/plain (or text/html as fallback).
    """
    # Check if this is a multipart structure
    if hasattr(bs, "__iter__") and not isinstance(bs, (str, bytes)):
        # imapclient BodyData objects have attributes
        if hasattr(bs, "content_type"):
            # Single part
            main_type = bs.content_type.maintype if hasattr(bs.content_type, "maintype") else ""
            sub_type = bs.content_type.subtype if hasattr(bs.content_type, "subtype") else ""

            if main_type == "text" and sub_type == "plain":
                return prefix or "1"
            if main_type == "text" and sub_type == "html":
                return prefix or "1"
            return prefix or "1"

        if hasattr(bs, "is_multipart") and bs.is_multipart:
            # Walk child parts
            html_spec = None
            for i, part in enumerate(bs, start=1):
                part_prefix = f"{prefix}.{i}" if prefix else str(i)
                if hasattr(part, "content_type"):
                    main_type = part.content_type.maintype if hasattr(part.content_type, "maintype") else ""
                    sub_type = part.content_type.subtype if hasattr(part.content_type, "subtype") else ""

                    if main_type == "text" and sub_type == "plain":
                        return part_prefix
                    if main_type == "text" and sub_type == "html":
                        html_spec = part_prefix

                # Check if child is also multipart
                if hasattr(part, "is_multipart") and part.is_multipart:
                    result = _walk_bodystructure(part, part_prefix)
                    if result:
                        return result

            if html_spec:
                return html_spec

    # Fallback
    return prefix or "1"


# ============================================================================
# STRATEGIES
# ============================================================================


def run_strategy_a(host: str, port: int) -> tuple[int, list[dict]]:
    """Strategy A: Current N+1 approach -- batch headers, then individual snippet fetches.

    Args:
        host: IMAP server hostname.
        port: IMAP server port.

    Returns:
        Tuple of (fetch_call_count, list of result dicts per email).
    """
    client, fetch_count = create_counting_client(host, port)
    client.select_folder("INBOX", readonly=True)
    uids = client.search("ALL")

    # Step 1: batch fetch headers + bodystructure
    batch_data = client.fetch(uids, ["ENVELOPE", "BODYSTRUCTURE"])

    results = []
    for uid in sorted(batch_data.keys()):
        msg = batch_data[uid]
        subject = get_subject(msg[b"ENVELOPE"])
        bodystructure = msg[b"BODYSTRUCTURE"]
        part_spec = find_text_part_spec(bodystructure)

        # Step 2: individual fetch for the text part
        part_data = client.fetch([uid], [f"BODY.PEEK[{part_spec}]"])
        body_key = find_body_key(part_data[uid], b"BODY")
        raw = cast(bytes | None, part_data[uid][body_key] if body_key else None)
        text = decode_body(raw)

        results.append({
            "uid": uid,
            "subject": subject,
            "part_spec": part_spec,
            "text": text,
            "raw_len": len(raw) if raw else 0,
        })

    client.logout()
    return fetch_count[0], results


def run_strategy_b(host: str, port: int) -> tuple[int, list[dict]]:
    """Strategy B: BODY.PEEK[TEXT] -- fetch text body for all emails in one call.

    Args:
        host: IMAP server hostname.
        port: IMAP server port.

    Returns:
        Tuple of (fetch_call_count, list of result dicts per email).
    """
    client, fetch_count = create_counting_client(host, port)
    client.select_folder("INBOX", readonly=True)
    uids = client.search("ALL")

    # Single batch fetch: envelope + text body
    data = client.fetch(uids, ["ENVELOPE", "BODY.PEEK[TEXT]"])

    results = []
    for uid in sorted(data.keys()):
        msg = data[uid]
        subject = get_subject(msg[b"ENVELOPE"])

        # The response key is something like b"BODY[TEXT]"
        body_key = find_body_key(msg, b"TEXT")
        raw = cast(bytes | None, msg[body_key] if body_key else None)
        text = decode_body(raw)

        # Flag if this looks like raw MIME (contains boundaries)
        is_mime = "--" in text[:200] if raw else False

        results.append({
            "uid": uid,
            "subject": subject,
            "text": text,
            "raw_len": len(raw) if raw else 0,
            "is_mime": is_mime,
        })

    client.logout()
    return fetch_count[0], results


def run_strategy_c(host: str, port: int) -> tuple[int, list[dict]]:
    """Strategy C: BODY.PEEK[1] -- fetch MIME part 1 for all emails in one call.

    Args:
        host: IMAP server hostname.
        port: IMAP server port.

    Returns:
        Tuple of (fetch_call_count, list of result dicts per email).
    """
    client, fetch_count = create_counting_client(host, port)
    client.select_folder("INBOX", readonly=True)
    uids = client.search("ALL")

    # Single batch fetch: envelope + part 1
    data = client.fetch(uids, ["ENVELOPE", "BODY.PEEK[1]"])

    results = []
    for uid in sorted(data.keys()):
        msg = data[uid]
        subject = get_subject(msg[b"ENVELOPE"])

        # The response key is something like b"BODY[1]"
        body_key = find_body_key(msg, b"BODY")
        raw = cast(bytes | None, msg[body_key] if body_key else None)
        text = decode_body(raw)

        results.append({
            "uid": uid,
            "subject": subject,
            "text": text,
            "raw_len": len(raw) if raw else 0,
        })

    client.logout()
    return fetch_count[0], results


# ============================================================================
# OUTPUT
# ============================================================================


def print_strategy_results(
    name: str,
    fetch_calls: int,
    results: list[dict],
    total_emails: int,
) -> bool:
    """Print results for one strategy and return whether it worked for all email types.

    Args:
        name: Strategy name (e.g. "A: Current N+1 approach").
        fetch_calls: Number of IMAP fetch calls made.
        results: List of result dicts from the strategy.
        total_emails: Total number of emails tested.

    Returns:
        True if the strategy produced usable text for all emails.
    """
    print("=" * 70)
    print(f"STRATEGY {name}")
    print("=" * 70)

    batch_count = 1
    individual_count = fetch_calls - batch_count if fetch_calls > 1 else 0
    if individual_count > 0:
        print(f"  Fetch calls: {fetch_calls} (1 batch + {individual_count} individual)")
    else:
        print(f"  Fetch calls: {fetch_calls}")
    print()

    all_worked = True
    for r in results:
        subject = r["subject"]
        text = r["text"]
        raw_len = r["raw_len"]
        snippet = text[:SNIPPET_DISPLAY_LEN].replace("\n", "\\n").replace("\r", "\\r")

        print(f'  [UID {r["uid"]}] "{subject}"')

        if "part_spec" in r:
            print(f"    Part spec: {r['part_spec']}")

        print(f"    Raw bytes: {raw_len}")

        if r.get("is_mime"):
            print(f"    NOTE: Contains raw MIME boundaries (not clean text)")

        if raw_len == 0:
            print("    Text: (no data)")
            all_worked = False
        else:
            print(f"    Text: {snippet!r}")

        print()

    return all_worked


# ============================================================================
# ENTRY POINT
# ============================================================================


def main():
    proc = start_hoodiecrow()

    try:
        host = "127.0.0.1"

        print()
        print("=" * 70)
        print("IMAP FETCH STRATEGY COMPARISON")
        print("=" * 70)
        print()
        print("Testing 5 email types: plain text, HTML-only, multipart/alternative,")
        print("multipart/mixed (with attachment), nested multipart")
        print()

        # -- Strategy A --
        a_calls, a_results = run_strategy_a(host, IMAP_PORT)
        a_ok = print_strategy_results("A: Current N+1 approach", a_calls, a_results, len(a_results))

        # -- Strategy B --
        b_calls, b_results = run_strategy_b(host, IMAP_PORT)
        b_ok = print_strategy_results("B: BODY.PEEK[TEXT] (single batch)", b_calls, b_results, len(b_results))

        # -- Strategy C --
        c_calls, c_results = run_strategy_c(host, IMAP_PORT)
        c_ok = print_strategy_results("C: BODY.PEEK[1] (single batch)", c_calls, c_results, len(c_results))

        # -- Comparison --
        print("=" * 70)
        print("COMPARISON")
        print("=" * 70)
        print(f"  Strategy A: {a_calls} fetch calls, works for all types: {'YES' if a_ok else 'NO'}")
        print(f"  Strategy B: {b_calls} fetch calls, works for all types: {'YES' if b_ok else 'NO'}")
        print(f"  Strategy C: {c_calls} fetch calls, works for all types: {'YES' if c_ok else 'NO'}")
        print()

        # Note about BODY.PEEK[TEXT] on multipart
        has_mime_in_b = any(r.get("is_mime") for r in b_results)
        if has_mime_in_b:
            print("  NOTE: Strategy B returns raw MIME body (with boundaries) for multipart")
            print("  emails. This means you would need to parse MIME in Python to extract")
            print("  the text/plain part, but it avoids N+1 round trips.")
            print()

    finally:
        proc.kill()
        proc.wait()

    print("Done.")


if __name__ == "__main__":
    main()
