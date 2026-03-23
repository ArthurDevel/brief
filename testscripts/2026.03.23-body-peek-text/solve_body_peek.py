"""
Prototype: batch-fetch snippets using BODY.PEEK[TEXT] instead of N+1 individual fetches.

Fetches all emails in 1 IMAP call (ENVELOPE + BODY.PEEK[TEXT]), parses multipart
MIME with Python's email stdlib to extract text/plain, and produces the same
clean snippet output as the existing _extract_snippet_via_bodystructure.

Run from apps/voice-pipeline:
  python3 ../../testscripts/2026.03.23-body-peek-text/solve_body_peek.py
"""

from __future__ import annotations

import email
import email.policy
import os
import re
import subprocess
import sys
import time
from typing import Any, cast

from imapclient import IMAPClient
from markdownify import markdownify

import importlib

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "apps", "voice-pipeline"))
_email_client = importlib.import_module("src.tools.email_client")
_extract_snippet_via_bodystructure = _email_client._extract_snippet_via_bodystructure


# ============================================================================
# CONSTANTS
# ============================================================================

SNIPPET_LENGTH = 100
IMAP_PORT = 14_251
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


# ============================================================================
# THE FIX
# ============================================================================

def extract_snippet_from_peek_text(
    raw_text: bytes, content_type: str, first_part_type: str
) -> str:
    """Extract a clean text snippet from BODY.PEEK[TEXT] raw bytes.

    For simple emails, raw_text is the body directly.
    For multipart emails, raw_text has MIME boundaries but parts lack Content-Type
    headers (IMAP TEXT section strips them). We split on the boundary and grab the
    first part, using BODYSTRUCTURE to know its type.

    Args:
        raw_text: Raw bytes from BODY.PEEK[TEXT].
        content_type: Top-level Content-Type (e.g. "multipart/alternative; boundary=xyz").
        first_part_type: MIME type of the first child part from BODYSTRUCTURE
            (e.g. "text/plain", "text/html", "multipart/alternative").

    Returns:
        Clean text snippet, max SNIPPET_LENGTH chars.
    """
    if not raw_text:
        return ""

    decoded = raw_text.decode("utf-8", errors="replace")
    text = ""

    if content_type.startswith("multipart/"):
        # Extract boundary from content_type
        boundary = _extract_boundary(content_type)
        if boundary:
            parts = _split_mime_parts(decoded, boundary)

            if first_part_type.startswith("multipart/"):
                # Nested: first "part" is itself multipart -- split again on inner boundary
                inner_ct = _find_inner_content_type(first_part_type, parts[0] if parts else "")
                inner_boundary = _extract_boundary(inner_ct)
                if inner_boundary:
                    parts = _split_mime_parts(parts[0] if parts else "", inner_boundary)

            if parts:
                text = parts[0]
                if first_part_type == "text/html" or (
                    first_part_type.startswith("multipart/") and "<html" in text.lower()
                ):
                    text = markdownify(
                        text, strip=["img", "table", "tr", "td", "th", "thead", "tbody"]
                    ).strip()
        else:
            text = decoded

    elif content_type.startswith("text/html"):
        text = markdownify(
            decoded, strip=["img", "table", "tr", "td", "th", "thead", "tbody"]
        ).strip()

    else:
        text = decoded

    # Same cleanup as the existing method
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\u200b\u200c\u200d\ufeff\u00ad]", "", text)
    return text[:SNIPPET_LENGTH].replace("\n", " ").strip()


def _extract_boundary(content_type: str) -> str:
    """Pull the boundary value out of a Content-Type string.

    Args:
        content_type: e.g. 'multipart/alternative; boundary="alt-001"'

    Returns:
        The boundary string, or empty if not found.
    """
    match = re.search(r'boundary="?([^";]+)"?', content_type, re.IGNORECASE)
    return match.group(1) if match else ""


def _split_mime_parts(text: str, boundary: str) -> list[str]:
    """Split raw MIME text on boundary markers and return the part bodies.

    Args:
        text: Raw MIME text with boundaries.
        boundary: The MIME boundary string.

    Returns:
        List of part body strings (stripped), excluding preamble and epilogue.
    """
    parts = text.split(f"--{boundary}")
    # parts[0] is preamble (empty), parts[-1] is closing marker "--"
    result = []
    for part in parts[1:]:
        stripped = part.strip()
        if stripped == "--" or stripped.startswith("--"):
            # Closing boundary
            if stripped == "--":
                continue
            # Could be "--\r\n..." (closing) -- skip
            if stripped.startswith("--") and len(stripped) <= 4:
                continue
        result.append(stripped)
    return result


def _find_inner_content_type(first_part_type: str, raw_part: str) -> str:
    """Build a Content-Type for a nested multipart from BODYSTRUCTURE info and raw text.

    Extracts the inner boundary from the raw part text.

    Args:
        first_part_type: e.g. "multipart/alternative"
        raw_part: The raw text of the outer part containing inner boundaries.

    Returns:
        Content-Type string with boundary, e.g. 'multipart/alternative; boundary="inner-001"'
    """
    # Find the first boundary-like line in the raw part
    for line in raw_part.splitlines():
        line = line.strip()
        if line.startswith("--") and not line.endswith("--"):
            boundary = line[2:]
            return f'{first_part_type}; boundary="{boundary}"'
    return first_part_type


def build_content_type_string(bodystructure: Any) -> str:
    """Build a Content-Type string from the top-level BODYSTRUCTURE.

    For multipart messages, includes the boundary parameter.
    For simple messages, returns type/subtype.

    Args:
        bodystructure: Parsed BODYSTRUCTURE from imapclient.

    Returns:
        Content-Type string (e.g. "multipart/alternative; boundary=xyz").
    """
    # Multipart: first element is a list of child parts
    if isinstance(bodystructure[0], list):
        subtype = bodystructure[1]
        if isinstance(subtype, bytes):
            subtype = subtype.decode("ascii", errors="replace").lower()

        # Boundary is in the params dict (index 2 for multipart)
        boundary = ""
        params = bodystructure[2] if len(bodystructure) > 2 else None
        if params:
            param_list = list(params) if isinstance(params, tuple) else params
            for j in range(0, len(param_list) - 1, 2):
                key = param_list[j]
                if isinstance(key, bytes):
                    key = key.decode("ascii", errors="replace")
                if key.upper() == "BOUNDARY":
                    val = param_list[j + 1]
                    if isinstance(val, bytes):
                        val = val.decode("ascii", errors="replace")
                    boundary = val

        ct = f"multipart/{subtype}"
        if boundary:
            ct += f'; boundary="{boundary}"'
        return ct

    # Simple: (type, subtype, ...)
    main = bodystructure[0]
    sub = bodystructure[1]
    if isinstance(main, bytes):
        main = main.decode("ascii", errors="replace").lower()
    if isinstance(sub, bytes):
        sub = sub.decode("ascii", errors="replace").lower()
    return f"{main}/{sub}"


def _get_first_part_type(bodystructure: Any) -> str:
    """Get the MIME type of the first child part from BODYSTRUCTURE.

    For multipart messages, returns the type of child[0]. If child[0] is itself
    multipart, returns "multipart/<subtype>" (does NOT recurse further).
    For simple messages, returns the top-level type.

    Args:
        bodystructure: Parsed BODYSTRUCTURE from imapclient.

    Returns:
        MIME type string (e.g. "text/plain", "multipart/alternative").
    """
    if not isinstance(bodystructure[0], list):
        # Simple message
        main = bodystructure[0]
        sub = bodystructure[1]
        if isinstance(main, bytes):
            main = main.decode("ascii", errors="replace").lower()
        if isinstance(sub, bytes):
            sub = sub.decode("ascii", errors="replace").lower()
        return f"{main}/{sub}"

    # Multipart: look at first child only
    first_child = bodystructure[0][0]
    if isinstance(first_child[0], list):
        # First child is also multipart
        sub = first_child[1]
        if isinstance(sub, bytes):
            sub = sub.decode("ascii", errors="replace").lower()
        return f"multipart/{sub}"

    main = first_child[0]
    sub = first_child[1]
    if isinstance(main, bytes):
        main = main.decode("ascii", errors="replace").lower()
    if isinstance(sub, bytes):
        sub = sub.decode("ascii", errors="replace").lower()
    return f"{main}/{sub}"


# ============================================================================
# HELPERS
# ============================================================================

def start_hoodiecrow() -> subprocess.Popen:
    proc = subprocess.Popen(
        ["node", os.path.join(SCRIPT_DIR, "_start_hoodiecrow.cjs")],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert proc.stdout is not None
    line = proc.stdout.readline().decode().strip()
    if not line.startswith("READY"):
        proc.kill()
        raise RuntimeError(f"Hoodiecrow failed: {line!r}")
    return proc


def decode_subject(envelope: Any) -> str:
    subject = envelope.subject
    if isinstance(subject, bytes):
        return subject.decode("utf-8", errors="replace")
    return str(subject) if subject else "(no subject)"


# ============================================================================
# MAIN
# ============================================================================

def main():
    proc = start_hoodiecrow()

    try:
        client = IMAPClient("127.0.0.1", port=IMAP_PORT, ssl=False)
        client.login("testuser", "testpass")
        client.select_folder("INBOX", readonly=True)

        uids = client.search("ALL")
        print(f"Found {len(uids)} emails\n")

        # -- One single batch fetch for everything --
        data = client.fetch(uids, ["ENVELOPE", "BODYSTRUCTURE", "BODY.PEEK[TEXT]"])

        print(f"{'Subject':<40} | {'Existing snippet':<50} | {'PEEK[TEXT] snippet':<50} | Match?")
        print("-" * 160)

        rows: list[dict[str, str]] = []
        all_match = True
        for uid in sorted(data.keys()):
            msg = data[uid]
            envelope = msg[b"ENVELOPE"]
            bodystructure = msg[b"BODYSTRUCTURE"]
            subject = decode_subject(envelope)

            # Existing method (N+1)
            existing = _extract_snippet_via_bodystructure(client, uid, bodystructure)

            # New method (from the batch fetch)
            raw_text: bytes = b""
            for key, value in msg.items():
                if isinstance(key, bytes) and b"TEXT" in key and isinstance(value, bytes):
                    raw_text = value
                    break

            content_type = build_content_type_string(bodystructure)
            first_part_type = _get_first_part_type(bodystructure)
            new_snippet = extract_snippet_from_peek_text(raw_text, content_type, first_part_type)

            match = existing == new_snippet
            if not match:
                all_match = False

            rows.append({
                "subject": subject,
                "content_type": content_type,
                "existing": existing,
                "new": new_snippet,
                "match": "OK" if match else "DIFF",
            })

            print(f"{subject:<40} | {existing:<50} | {new_snippet:<50} | {'OK' if match else 'DIFF'}")

        client.logout()

        # Write markdown output
        os.makedirs(os.path.join(SCRIPT_DIR, "output"), exist_ok=True)
        md_path = os.path.join(SCRIPT_DIR, "output", "solve_comparison.md")

        md = "# BODY.PEEK[TEXT] Solution Comparison\n\n"
        md += f"**Result:** {'ALL MATCH' if all_match else 'SOME DIFFER'}\n\n"
        md += f"**Fetch calls (new):** 1 batch (ENVELOPE + BODYSTRUCTURE + BODY.PEEK[TEXT])\n"
        md += f"**Fetch calls (existing):** 1 batch + {len(uids)} individual = {1 + len(uids)} calls\n\n"
        md += "| Subject | Content-Type | Existing snippet | PEEK[TEXT] snippet | Match |\n"
        md += "|---|---|---|---|---|\n"
        for r in rows:
            md += f"| {r['subject']} | `{r['content_type']}` | {r['existing']} | {r['new']} | {r['match']} |\n"

        with open(md_path, "w") as f:
            f.write(md)

        print(f"\nMarkdown written to: {md_path}")

    finally:
        proc.kill()
        proc.wait()


if __name__ == "__main__":
    main()
