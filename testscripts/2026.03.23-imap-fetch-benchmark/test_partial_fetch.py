"""
Test: verify partial fetch (8KB) produces identical snippets to full fetch.

Fetches the 25 most recent emails twice:
1. Full body fetch (current production approach)
2. Partial fetch with 8KB limit (proposed fix)

Compares the resulting snippets side-by-side and reports any differences.
"""

import email
import email.policy
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from imapclient import IMAPClient
from markdownify import markdownify
from supabase import create_client


# ============================================================================
# CONSTANTS
# ============================================================================

SNIPPET_LENGTH = 100
PARTIAL_BYTES = 8192
TEST_COUNT = 100
OUTPUT_DIR = Path(__file__).parent / "output"
REPORT_FILE = OUTPUT_DIR / "partial_fetch_test.md"


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _load_env() -> dict:
    """Load IMAP credentials from Supabase Vault."""
    env_path = Path(__file__).parents[2] / "apps" / "voice-pipeline" / ".env"
    load_dotenv(env_path)

    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        raise ValueError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")

    supabase = create_client(supabase_url, supabase_key)
    result = supabase.table("user_settings").select(
        "imap_host, imap_port, imap_user, imap_password_secret_id"
    ).limit(1).execute()

    if not result.data:
        raise RuntimeError("No user_settings found")

    settings: dict[str, Any] = dict(result.data[0])  # type: ignore[arg-type]
    secret_result = supabase.rpc(
        "vault_retrieve_secret",
        {"secret_id": str(settings["imap_password_secret_id"])},
    ).execute()

    if secret_result.data is None:
        raise RuntimeError("Failed to retrieve IMAP password from Vault")

    return {
        "host": str(settings["imap_host"]),
        "port": int(settings["imap_port"]),
        "user": str(settings["imap_user"]),
        "password": str(secret_result.data),
    }


def _build_content_type_string(bodystructure: Any) -> str:
    """Build a Content-Type header string from BODYSTRUCTURE."""
    if isinstance(bodystructure[0], list):
        subtype = bodystructure[1]
        if isinstance(subtype, bytes):
            subtype = subtype.decode("ascii", errors="replace").lower()
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

    main_type = bodystructure[0]
    sub_type = bodystructure[1]
    if isinstance(main_type, bytes):
        main_type = main_type.decode("ascii", errors="replace").lower()
    if isinstance(sub_type, bytes):
        sub_type = sub_type.decode("ascii", errors="replace").lower()
    ct = f"{main_type}/{sub_type}"
    params = bodystructure[2] if len(bodystructure) > 2 else None
    if params:
        param_list = list(params) if isinstance(params, tuple) else params
        for j in range(0, len(param_list) - 1, 2):
            key = param_list[j]
            if isinstance(key, bytes):
                key = key.decode("ascii", errors="replace")
            if key.upper() == "CHARSET":
                val = param_list[j + 1]
                if isinstance(val, bytes):
                    val = val.decode("ascii", errors="replace")
                ct += f"; charset={val}"
    return ct


def _extract_snippet(raw_text: bytes, bodystructure: Any, subject_fallback: str = "") -> tuple[str, str]:
    """Extract a clean snippet using MIME parsing (mirrors production code).

    Returns:
        Tuple of (snippet, source) where source is "body" or "subject".
    """
    if not raw_text:
        return (subject_fallback or "(no body)", "subject")

    content_type = _build_content_type_string(bodystructure)
    header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
    mime_bytes = header + raw_text
    msg = email.message_from_bytes(mime_bytes, policy=email.policy.default)

    text = ""
    plain_part = msg.get_body(preferencelist=("plain",))
    if plain_part is not None:
        try:
            content = plain_part.get_content()
            if isinstance(content, str) and content.strip() and not content.strip().startswith("<"):
                text = content.strip()
        except Exception:
            pass

    if not text:
        html_part = msg.get_body(preferencelist=("html",))
        if html_part is not None:
            try:
                html_content = html_part.get_content()
                if isinstance(html_content, str) and html_content.strip():
                    text = markdownify(
                        html_content,
                        strip=["img", "table", "tr", "td", "th", "thead", "tbody"],
                    ).strip()
            except Exception:
                pass

    if not text:
        return (subject_fallback or "(could not parse)", "subject")

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\u200b\u200c\u200d\ufeff\u00ad]", "", text)
    return (text[:SNIPPET_LENGTH].replace("\n", " ").strip(), "body")


def _get_subject(envelope: Any) -> str:
    """Extract subject from ENVELOPE."""
    if envelope is None or envelope.subject is None:
        return "(no subject)"
    if isinstance(envelope.subject, bytes):
        return envelope.subject.decode("utf-8", errors="replace")
    return str(envelope.subject)


# ============================================================================
# MAIN
# ============================================================================

def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    creds = _load_env()
    client = IMAPClient(creds["host"], port=creds["port"], ssl=True)
    client.login(creds["user"], creds["password"])
    client.select_folder("INBOX", readonly=True)

    all_uids = client.search("ALL")
    uids = all_uids[-TEST_COUNT:]
    print(f"Testing {len(uids)} emails\n")

    # Fetch B first to avoid cache advantage for A
    t0 = time.perf_counter()
    data_partial = client.fetch(uids, ["ENVELOPE", "BODYSTRUCTURE", f"BODY.PEEK[TEXT]<0.{PARTIAL_BYTES}>"])
    time_partial = time.perf_counter() - t0

    # Fetch A: full body (benefits from server cache now)
    t0 = time.perf_counter()
    data_full = client.fetch(uids, ["ENVELOPE", "BODYSTRUCTURE", "BODY.PEEK[TEXT]"])
    time_full = time.perf_counter() - t0

    print(f"Partial fetch: {time_partial:.3f}s")
    print(f"Full fetch:    {time_full:.3f}s")
    print(f"Speedup:       {time_full / time_partial:.1f}x\n")

    # Compare snippets
    lines = [
        "# Partial Fetch (8KB) vs Full Fetch -- Snippet Comparison",
        "",
        f"Emails tested: {len(uids)}",
        f"Full fetch: {time_full:.3f}s | Partial fetch: {time_partial:.3f}s | Speedup: {time_full / time_partial:.1f}x",
        "",
    ]

    identical = 0
    different = 0

    for uid in uids:
        entry_full = data_full.get(uid, {})
        entry_partial = data_partial.get(uid, {})

        envelope = entry_full.get(b"ENVELOPE")
        subject = _get_subject(envelope)
        bs = entry_full.get(b"BODYSTRUCTURE")

        body_full = entry_full.get(b"BODY[TEXT]", b"")
        body_partial = entry_partial.get(b"BODY[TEXT]<0>", None)
        if body_partial is None:
            body_partial = entry_partial.get(b"BODY[TEXT]", b"")

        raw_full = bytes(body_full) if isinstance(body_full, (bytes, bytearray)) else b""
        raw_partial = bytes(body_partial) if isinstance(body_partial, (bytes, bytearray)) else b""

        if bs:
            full_text, full_src = _extract_snippet(raw_full, bs, subject)
            partial_text, partial_src = _extract_snippet(raw_partial, bs, subject)
        else:
            full_text, full_src = subject, "subject"
            partial_text, partial_src = subject, "subject"

        match = full_text == partial_text
        if match:
            identical += 1
        else:
            different += 1

        status = "MATCH" if match else "DIFF"
        src_label = f" [from {partial_src}]" if partial_src == "subject" and full_src == "body" else ""
        lines.append(f"## [{status}] UID {uid}: {subject}")
        lines.append("")

        if match:
            lines.append(f"```")
            lines.append(f"{full_text}")
            lines.append(f"```")
            if partial_src == "subject":
                lines.append("*(subject fallback)*")
        else:
            lines.append(f"**Full ({full_src}):**")
            lines.append(f"```")
            lines.append(f"{full_text}")
            lines.append(f"```")
            lines.append(f"**Partial ({partial_src}):**")
            lines.append(f"```")
            lines.append(f"{partial_text}")
            lines.append(f"```")

        lines.append("")
        lines.append("---")
        lines.append("")

    lines.insert(4, f"Identical: {identical}/{len(uids)} | Different: {different}/{len(uids)}")

    report = "\n".join(lines)
    with open(REPORT_FILE, "w") as f:
        f.write(report)

    print(f"Identical: {identical}/{len(uids)}")
    print(f"Different: {different}/{len(uids)}")
    print(f"\nReport: {REPORT_FILE}")

    client.logout()


if __name__ == "__main__":
    main()
