"""
Compare two IMAP fetch strategies for email body snippets.

Starts a Hoodiecrow IMAP server with 5 test emails, then for each email:
- Strategy A: Uses the existing _extract_snippet_via_bodystructure (N+1 fetch per part)
- Strategy B: Fetches raw BODY.PEEK[TEXT] in one go

Writes a side-by-side markdown comparison to output/comparison.md.

- Starts/stops the Hoodiecrow subprocess
- Fetches email data using both strategies
- Generates a markdown comparison file
"""

from __future__ import annotations

import importlib
import os
import subprocess
import sys
import time
from typing import Any, cast

from imapclient import IMAPClient

# Allow imports from the voice-pipeline package
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "apps", "voice-pipeline"))

# Dynamic import to satisfy the type checker (src.tools.email_client is only
# on sys.path at runtime after the insert above).
_email_client_mod = importlib.import_module("src.tools.email_client")
_extract_snippet_via_bodystructure = _email_client_mod._extract_snippet_via_bodystructure


# ============================================================================
# CONSTANTS
# ============================================================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
HOODIECROW_SCRIPT = os.path.join(SCRIPT_DIR, "_start_hoodiecrow.cjs")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "comparison.md")

IMAP_HOST = "127.0.0.1"
IMAP_PORT = 14251
IMAP_USER = "testuser"
IMAP_PASS = "testpass"

READY_TIMEOUT_SECONDS = 10


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _start_hoodiecrow() -> subprocess.Popen[str]:
    """Start the Hoodiecrow IMAP server and wait for READY signal.

    Returns:
        The running subprocess handle.
    """
    proc = subprocess.Popen(
        ["node", HOODIECROW_SCRIPT],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    assert proc.stdout is not None
    assert proc.stderr is not None

    # Wait for the "READY:<port>" line
    start = time.time()
    while time.time() - start < READY_TIMEOUT_SECONDS:
        line = proc.stdout.readline().strip()
        if line.startswith("READY:"):
            return proc
        if proc.poll() is not None:
            raise RuntimeError(f"Hoodiecrow exited early: {proc.stderr.read()}")
        time.sleep(0.1)

    proc.kill()
    raise RuntimeError("Hoodiecrow did not become ready in time")


def _connect_imap() -> IMAPClient:
    """Connect and login to the local Hoodiecrow IMAP server.

    Returns:
        Authenticated IMAPClient instance with INBOX selected.
    """
    client = IMAPClient(IMAP_HOST, port=IMAP_PORT, ssl=False)
    client.login(IMAP_USER, IMAP_PASS)
    client.select_folder("INBOX")
    return client


def _fetch_body_peek_text(client: IMAPClient, uid: int) -> str:
    """Fetch raw BODY.PEEK[TEXT] for a single email.

    Args:
        client: Connected IMAPClient.
        uid: UID of the email.

    Returns:
        Decoded text content from BODY.PEEK[TEXT].
    """
    data = client.fetch([uid], ["BODY.PEEK[TEXT]"])
    uid_data: dict[Any, Any] = data.get(uid, {})

    raw_bytes: bytes = b""
    for key, value in uid_data.items():
        if isinstance(key, bytes) and b"BODY" in key and isinstance(value, bytes):
            raw_bytes = value
            break

    if not raw_bytes:
        return "(empty)"

    # Try UTF-8 first, fall back to latin-1
    try:
        return raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return raw_bytes.decode("latin-1")


def _has_mime_boundaries(text: str) -> bool:
    """Check if text contains MIME boundary markers.

    Args:
        text: The raw text to check.

    Returns:
        True if the text contains lines starting with '--'.
    """
    for line in text.splitlines():
        if line.strip().startswith("--"):
            return True
    return False


def _escape_md(text: str) -> str:
    """Escape text for use inside a markdown code block.

    Args:
        text: Raw text string.

    Returns:
        Text safe for markdown display (triple-backtick blocks handle most
        cases, but we ensure no premature block closing).
    """
    return text.replace("```", "` ` `")


def _build_comparison_md(results: list[dict[str, Any]]) -> str:
    """Build the markdown comparison document.

    Args:
        results: List of dicts with keys: subject, strategy_a, strategy_b, has_boundaries.

    Returns:
        Full markdown string.
    """
    lines = [
        "# BODY.PEEK[TEXT] vs BODYSTRUCTURE Snippet Comparison",
        "",
        "Generated: 2026-03-23",
        "",
        "For each of the 5 test emails, this shows:",
        "- **Strategy A** (current): `_extract_snippet_via_bodystructure` -- walks BODYSTRUCTURE, "
        "fetches only the text/plain (or text/html) MIME part, decodes, truncates to 100 chars.",
        "- **Strategy B** (proposed): `BODY.PEEK[TEXT]` -- fetches the raw TEXT section in one command.",
        "",
        "---",
        "",
    ]

    for i, r in enumerate(results, 1):
        lines.append(f"## Email {i}: {r['subject']}")
        lines.append("")

        # Strategy A
        lines.append("### Strategy A -- _extract_snippet_via_bodystructure")
        lines.append("")
        lines.append("```")
        lines.append(_escape_md(r["strategy_a"]))
        lines.append("```")
        lines.append("")

        # Strategy B
        lines.append("### Strategy B -- BODY.PEEK[TEXT]")
        lines.append("")
        lines.append("```")
        lines.append(_escape_md(r["strategy_b"]))
        lines.append("```")
        lines.append("")

        # MIME boundaries
        has_boundaries = "Yes" if r["has_boundaries"] else "No"
        lines.append(f"**Contains MIME boundaries:** {has_boundaries}")
        lines.append("")
        lines.append("---")
        lines.append("")

    return "\n".join(lines)


# ============================================================================
# MAIN
# ============================================================================

def main() -> None:
    """Run the comparison: start server, fetch with both strategies, write markdown."""
    print("Starting Hoodiecrow IMAP server...")
    proc = _start_hoodiecrow()

    try:
        client = _connect_imap()

        # Get all UIDs in INBOX
        uids = client.search("ALL")
        if not uids:
            raise RuntimeError("No emails found in INBOX")
        print(f"Found {len(uids)} emails in INBOX")

        # Fetch ENVELOPE + BODYSTRUCTURE for all emails at once
        fetch_data = client.fetch(uids, ["ENVELOPE", "BODYSTRUCTURE"])

        results: list[dict[str, Any]] = []
        for uid in uids:
            data: dict[Any, Any] = fetch_data.get(uid, {})
            envelope: Any = data.get(b"ENVELOPE")
            bodystructure: Any = data.get(b"BODYSTRUCTURE")

            subject = "(no subject)"
            if envelope is not None and hasattr(envelope, "subject") and envelope.subject:
                raw_subject: bytes = cast(bytes, envelope.subject)
                subject = raw_subject.decode("utf-8", errors="replace")

            # Strategy A: existing method
            snippet_a = ""
            if bodystructure is not None:
                snippet_a = _extract_snippet_via_bodystructure(client, uid, bodystructure)
            if not snippet_a:
                snippet_a = "(empty)"

            # Strategy B: raw BODY.PEEK[TEXT]
            snippet_b = _fetch_body_peek_text(client, uid)

            results.append({
                "subject": subject,
                "strategy_a": snippet_a,
                "strategy_b": snippet_b,
                "has_boundaries": _has_mime_boundaries(snippet_b),
            })

            print(f"  Processed: {subject}")

        client.logout()

        # Write comparison markdown
        os.makedirs(OUTPUT_DIR, exist_ok=True)
        md_content = _build_comparison_md(results)
        with open(OUTPUT_FILE, "w") as f:
            f.write(md_content)

        print(f"\nComparison written to: {OUTPUT_FILE}")

    finally:
        proc.kill()
        proc.wait()


if __name__ == "__main__":
    main()
