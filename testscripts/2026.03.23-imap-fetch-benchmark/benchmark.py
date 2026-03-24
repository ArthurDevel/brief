"""
IMAP Fetch Strategy Benchmark

Compares four IMAP fetch strategies for listing inbox emails with a preview snippet.
The goal is to find a faster alternative to fetching the full text body of every email.

Strategies tested:
  A) Full fetch: ENVELOPE + BODYSTRUCTURE + BODY.PEEK[TEXT] (current production approach)
  B) Partial fetch: ENVELOPE + BODY.PEEK[TEXT]<0.1024> (first 1024 bytes only)
  C) Envelope first, then individual partial fetches per email
  D) Metadata only: ENVELOPE + BODYSTRUCTURE (no body snippet at all)
"""

import email
import email.policy
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from imapclient import IMAPClient
from markdownify import markdownify
from supabase import create_client


# ============================================================================
# CONSTANTS
# ============================================================================

BATCH_SIZES = [10, 25, 50, 100]
SNIPPET_LENGTH = 100
PARTIAL_FETCH_BYTES = 8192
INDIVIDUAL_PARTIAL_BYTES = 512
OUTPUT_DIR = Path(__file__).parent / "output"
OUTPUT_FILE = OUTPUT_DIR / "results.txt"


# ============================================================================
# DATA CLASSES
# ============================================================================

@dataclass
class BenchmarkResult:
    """Result of a single strategy + batch size run."""
    strategy: str
    batch_size: int
    elapsed_seconds: float
    emails_fetched: int
    sample_snippet: str
    error: str = ""

COMPARISON_FILE = OUTPUT_DIR / "snippet_comparison.md"
COMPARISON_COUNT = 5


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _load_env() -> dict:
    """Load IMAP credentials from Supabase Vault via the voice-pipeline .env.

    Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the voice-pipeline
    .env, then fetches the first user's IMAP settings + decrypted password
    from the database.

    Returns:
        dict with keys: host, port, user, password
    """
    env_path = Path(__file__).parents[2] / "apps" / "voice-pipeline" / ".env"
    if not env_path.exists():
        raise FileNotFoundError(f"Voice-pipeline .env not found at {env_path}")

    load_dotenv(env_path)

    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not supabase_url or not supabase_key:
        raise ValueError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in voice-pipeline .env")

    supabase = create_client(supabase_url, supabase_key)

    # Fetch the first user's IMAP settings
    result = supabase.table("user_settings").select(
        "imap_host, imap_port, imap_user, imap_password_secret_id"
    ).limit(1).execute()

    if not result.data:
        raise RuntimeError("No user_settings found in database")

    settings: dict = dict(result.data[0])  # type: ignore[arg-type]

    # Decrypt password from Vault
    secret_result = supabase.rpc(
        "vault_retrieve_secret",
        {"secret_id": settings["imap_password_secret_id"]},
    ).execute()

    if secret_result.data is None:
        raise RuntimeError("Failed to retrieve IMAP password from Vault")

    return {
        "host": str(settings["imap_host"]),
        "port": int(settings["imap_port"]),
        "user": str(settings["imap_user"]),
        "password": str(secret_result.data),
    }


def _connect(creds: dict) -> IMAPClient:
    """Connect and authenticate to the IMAP server.

    Args:
        creds: dict with host, port, user, password

    Returns:
        Authenticated IMAPClient instance
    """
    client = IMAPClient(creds["host"], port=creds["port"], ssl=True)
    client.login(creds["user"], creds["password"])
    client.select_folder("INBOX", readonly=True)
    return client


def _get_latest_uids(client: IMAPClient, count: int) -> list:
    """Get the UIDs of the most recent N emails in the inbox.

    Args:
        client: authenticated IMAPClient
        count: number of UIDs to retrieve

    Returns:
        List of UIDs (most recent first)
    """
    all_uids = client.search("ALL")
    latest = all_uids[-count:] if len(all_uids) >= count else all_uids
    return latest


def _extract_snippet(raw_body: object) -> str:
    """Extract a short text snippet from raw bytes without MIME parsing.

    Used by strategy C which fetches a single MIME part directly.

    Args:
        raw_body: raw body value from imapclient fetch (bytes, str, or None)

    Returns:
        Cleaned snippet string, truncated to SNIPPET_LENGTH chars
    """
    if raw_body is None:
        return "(no body)"

    if isinstance(raw_body, bytes):
        text = raw_body.decode("utf-8", errors="replace")
    elif isinstance(raw_body, str):
        text = raw_body
    else:
        text = str(raw_body)

    # Collapse whitespace into single spaces
    cleaned = " ".join(text.split())
    return cleaned[:SNIPPET_LENGTH]


def _extract_snippet_with_bodystructure(raw_text: bytes, bodystructure: Any) -> str:
    """Extract a clean text snippet using BODYSTRUCTURE for MIME parsing.

    Mirrors the production _extract_snippet_from_raw_text logic.

    Args:
        raw_text: Raw bytes from BODY.PEEK[TEXT]
        bodystructure: Parsed BODYSTRUCTURE from imapclient

    Returns:
        Clean text snippet, max SNIPPET_LENGTH chars
    """
    if not raw_text:
        return "(no body)"

    content_type = _build_content_type_string(bodystructure)

    header = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
    mime_bytes = header + raw_text
    msg = email.message_from_bytes(mime_bytes, policy=email.policy.default)

    text = ""
    plain_part = msg.get_body(preferencelist=("plain",))
    if plain_part is not None:
        try:
            content = plain_part.get_content()
            # Skip "plain" parts that are actually HTML (buggy senders)
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
        return "(could not parse)"

    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[\u200b\u200c\u200d\ufeff\u00ad]", "", text)
    return text[:SNIPPET_LENGTH].replace("\n", " ").strip()


def _build_content_type_string(bodystructure: Any) -> str:
    """Build a Content-Type header string from BODYSTRUCTURE.

    Args:
        bodystructure: Parsed BODYSTRUCTURE from imapclient

    Returns:
        Content-Type string
    """
    # Multipart: first element is a list of child parts
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

    # Simple: (type, subtype, params, ...)
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


def _extract_subject(envelope) -> str:
    """Extract the subject line from an ENVELOPE response.

    Args:
        envelope: imapclient Envelope object

    Returns:
        Subject string or "(no subject)"
    """
    if envelope.subject is None:
        return "(no subject)"

    if isinstance(envelope.subject, bytes):
        return envelope.subject.decode("utf-8", errors="replace")
    return str(envelope.subject)


def _format_results_table(results: list[BenchmarkResult]) -> str:
    """Format all benchmark results into a readable summary table.

    Args:
        results: list of BenchmarkResult objects

    Returns:
        Formatted table string
    """
    header = f"{'Strategy':<12} {'Batch':<8} {'Time (s)':<12} {'Fetched':<10} {'Status'}"
    separator = "-" * 70
    lines = [separator, header, separator]

    for r in results:
        if r.error:
            status = f"ERROR: {r.error[:40]}"
        else:
            status = "OK"
        line = f"{r.strategy:<12} {r.batch_size:<8} {r.elapsed_seconds:<12.3f} {r.emails_fetched:<10} {status}"
        lines.append(line)

    lines.append(separator)
    return "\n".join(lines)


def _write_output(text: str) -> None:
    """Write text to both stdout and the output file.

    Args:
        text: text to write
    """
    print(text)
    with open(OUTPUT_FILE, "a") as f:
        f.write(text + "\n")


# ============================================================================
# STRATEGIES
# ============================================================================

def strategy_a(client: IMAPClient, uids: list) -> BenchmarkResult:
    """Strategy A: Full fetch (current production approach).

    Fetches ENVELOPE + BODYSTRUCTURE + full BODY.PEEK[TEXT] for every email.

    Args:
        client: authenticated IMAPClient
        uids: list of UIDs to fetch

    Returns:
        BenchmarkResult with timing and sample data
    """
    start = time.perf_counter()
    data = client.fetch(uids, ["ENVELOPE", "BODYSTRUCTURE", "BODY.PEEK[TEXT]"])
    elapsed = time.perf_counter() - start

    # Get sample snippet from first email
    first_uid = uids[0]
    first = data.get(first_uid, {})
    body = first.get(b"BODY[TEXT]", None)
    snippet = _extract_snippet(body)

    return BenchmarkResult(
        strategy="A (full)",
        batch_size=len(uids),
        elapsed_seconds=elapsed,
        emails_fetched=len(data),
        sample_snippet=snippet,
    )


def strategy_b(client: IMAPClient, uids: list) -> BenchmarkResult:
    """Strategy B: Partial fetch with byte limit.

    Fetches ENVELOPE + first 1024 bytes of BODY.PEEK[TEXT].

    Args:
        client: authenticated IMAPClient
        uids: list of UIDs to fetch

    Returns:
        BenchmarkResult with timing and sample data
    """
    start = time.perf_counter()
    data = client.fetch(uids, ["ENVELOPE", f"BODY.PEEK[TEXT]<0.{PARTIAL_FETCH_BYTES}>"])
    elapsed = time.perf_counter() - start

    first_uid = uids[0]
    first = data.get(first_uid, {})
    # Partial fetch response key includes the byte range
    body_key = f"BODY[TEXT]<0>".encode()
    body = first.get(body_key, None)
    # Fallback: try without the range marker in case imapclient normalizes it
    if body is None:
        body = first.get(b"BODY[TEXT]", None)

    snippet = _extract_snippet(body)

    return BenchmarkResult(
        strategy="B (partial)",
        batch_size=len(uids),
        elapsed_seconds=elapsed,
        emails_fetched=len(data),
        sample_snippet=snippet,
    )


def strategy_c(client: IMAPClient, uids: list) -> BenchmarkResult:
    """Strategy C: Envelope first, then individual partial fetches.

    First fetches all envelopes in batch, then fetches first 512 bytes of
    part 1 individually for each email.

    Args:
        client: authenticated IMAPClient
        uids: list of UIDs to fetch

    Returns:
        BenchmarkResult with timing and sample data
    """
    start = time.perf_counter()

    # Step 1: batch fetch envelopes
    envelope_data = client.fetch(uids, ["ENVELOPE"])

    # Step 2: individual partial body fetches
    first_snippet = "(no body)"
    for i, uid in enumerate(uids):
        body_data = client.fetch([uid], [f"BODY.PEEK[1]<0.{INDIVIDUAL_PARTIAL_BYTES}>"])
        if i == 0:
            first = body_data.get(uid, {})
            body_key = b"BODY[1]<0>"
            body = first.get(body_key, None)
            if body is None:
                body = first.get(b"BODY[1]", None)
            first_snippet = _extract_snippet(body)

    elapsed = time.perf_counter() - start

    return BenchmarkResult(
        strategy="C (indiv)",
        batch_size=len(uids),
        elapsed_seconds=elapsed,
        emails_fetched=len(envelope_data),
        sample_snippet=first_snippet,
    )


def strategy_d(client: IMAPClient, uids: list) -> BenchmarkResult:
    """Strategy D: Metadata only, no body snippet.

    Fetches ENVELOPE + BODYSTRUCTURE only. Uses subject as the preview.

    Args:
        client: authenticated IMAPClient
        uids: list of UIDs to fetch

    Returns:
        BenchmarkResult with timing and sample data
    """
    start = time.perf_counter()
    data = client.fetch(uids, ["ENVELOPE", "BODYSTRUCTURE"])
    elapsed = time.perf_counter() - start

    first_uid = uids[0]
    first = data.get(first_uid, {})
    envelope = first.get(b"ENVELOPE", None)
    snippet = _extract_subject(envelope) if envelope else "(no envelope)"

    return BenchmarkResult(
        strategy="D (meta)",
        batch_size=len(uids),
        elapsed_seconds=elapsed,
        emails_fetched=len(data),
        sample_snippet=snippet,
    )


# ============================================================================
# SNIPPET COMPARISON
# ============================================================================

def _collect_all_snippets_a(client: IMAPClient, uids: list) -> dict[int, str]:
    """Collect snippets for all UIDs using strategy A (with MIME parsing)."""
    data = client.fetch(uids, ["ENVELOPE", "BODYSTRUCTURE", "BODY.PEEK[TEXT]"])
    result = {}
    for uid in uids:
        entry = data.get(uid, {})
        body = entry.get(b"BODY[TEXT]", b"")
        bodystructure = entry.get(b"BODYSTRUCTURE")
        raw_body = bytes(body) if isinstance(body, (bytes, bytearray)) else b""
        if bodystructure and raw_body:
            result[uid] = _extract_snippet_with_bodystructure(raw_body, bodystructure)
        else:
            result[uid] = _extract_snippet(body)
    return result


def _collect_all_snippets_b(client: IMAPClient, uids: list) -> dict[int, str]:
    """Collect snippets for all UIDs using strategy B (with MIME parsing)."""
    data = client.fetch(uids, ["ENVELOPE", "BODYSTRUCTURE", f"BODY.PEEK[TEXT]<0.{PARTIAL_FETCH_BYTES}>"])
    result = {}
    for uid in uids:
        entry = data.get(uid, {})
        body = entry.get(b"BODY[TEXT]<0>", None)
        if body is None:
            body = entry.get(b"BODY[TEXT]", b"")
        bodystructure = entry.get(b"BODYSTRUCTURE")
        raw_body = bytes(body) if isinstance(body, (bytes, bytearray)) else b""
        if bodystructure and raw_body:
            result[uid] = _extract_snippet_with_bodystructure(raw_body, bodystructure)
        else:
            result[uid] = _extract_snippet(body)
    return result


def _collect_all_snippets_c(client: IMAPClient, uids: list) -> dict[int, str]:
    """Collect snippets for all UIDs using strategy C."""
    result = {}
    for uid in uids:
        body_data = client.fetch([uid], [f"BODY.PEEK[1]<0.{INDIVIDUAL_PARTIAL_BYTES}>"])
        entry = body_data.get(uid, {})
        body = entry.get(b"BODY[1]<0>", None)
        if body is None:
            body = entry.get(b"BODY[1]", None)
        result[uid] = _extract_snippet(body)
    return result


def _collect_all_snippets_d(client: IMAPClient, uids: list) -> dict[int, str]:
    """Collect snippets for all UIDs using strategy D (subject only)."""
    data = client.fetch(uids, ["ENVELOPE"])
    result = {}
    for uid in uids:
        entry = data.get(uid, {})
        envelope = entry.get(b"ENVELOPE", None)
        result[uid] = _extract_subject(envelope) if envelope else "(no envelope)"
    return result


def _get_subjects(client: IMAPClient, uids: list) -> dict[int, str]:
    """Get subject lines for UIDs."""
    data = client.fetch(uids, ["ENVELOPE"])
    result = {}
    for uid in uids:
        entry = data.get(uid, {})
        envelope = entry.get(b"ENVELOPE", None)
        result[uid] = _extract_subject(envelope) if envelope else "(no subject)"
    return result


def _write_snippet_comparison(client: IMAPClient, uids: list) -> None:
    """Write a markdown file comparing snippet output across all strategies.

    Args:
        client: authenticated IMAPClient
        uids: UIDs to compare (should be small, e.g. 5)
    """
    subjects = _get_subjects(client, uids)
    snippets_a = _collect_all_snippets_a(client, uids)
    snippets_b = _collect_all_snippets_b(client, uids)
    snippets_c = _collect_all_snippets_c(client, uids)
    snippets_d = _collect_all_snippets_d(client, uids)

    lines = [
        "# Snippet Comparison",
        "",
        f"Comparing {len(uids)} emails across all four strategies.",
        "",
    ]

    for uid in uids:
        subj = subjects.get(uid, "(unknown)")
        lines.append(f"## Email UID {uid}: {subj}")
        lines.append("")
        lines.append(f"**A (full body):**")
        lines.append(f"```")
        lines.append(snippets_a.get(uid, "(none)"))
        lines.append(f"```")
        lines.append("")
        lines.append(f"**B (partial 1KB):**")
        lines.append(f"```")
        lines.append(snippets_b.get(uid, "(none)"))
        lines.append(f"```")
        lines.append("")
        lines.append(f"**C (individual partial):**")
        lines.append(f"```")
        lines.append(snippets_c.get(uid, "(none)"))
        lines.append(f"```")
        lines.append("")
        lines.append(f"**D (subject only):**")
        lines.append(f"```")
        lines.append(snippets_d.get(uid, "(none)"))
        lines.append(f"```")
        lines.append("")
        lines.append("---")
        lines.append("")

    md = "\n".join(lines)
    with open(COMPARISON_FILE, "w") as f:
        f.write(md)
    print(f"\nSnippet comparison written to {COMPARISON_FILE}")


# ============================================================================
# MAIN
# ============================================================================

STRATEGIES = [
    ("A", strategy_a),
    ("B", strategy_b),
    ("C", strategy_c),
    ("D", strategy_d),
]


def main():
    """Run all benchmark strategies across all batch sizes and print results."""
    # Reset output file
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if OUTPUT_FILE.exists():
        OUTPUT_FILE.unlink()

    _write_output("IMAP Fetch Strategy Benchmark")
    _write_output(f"Started at: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    _write_output("")

    # Load credentials and connect
    creds = _load_env()
    _write_output(f"Connecting to {creds['host']}:{creds['port']} as {creds['user']}...")
    client = _connect(creds)
    _write_output("Connected.\n")

    # Get the largest batch of UIDs we will need
    max_batch = max(BATCH_SIZES)
    all_uids = _get_latest_uids(client, max_batch)
    _write_output(f"Available UIDs in inbox: {len(all_uids)} (requested up to {max_batch})\n")

    all_results: list[BenchmarkResult] = []

    for batch_size in BATCH_SIZES:
        uids = all_uids[-batch_size:] if len(all_uids) >= batch_size else all_uids
        actual_count = len(uids)

        _write_output(f"--- Batch size: {batch_size} (actual: {actual_count}) ---")

        for name, strategy_fn in STRATEGIES:
            _write_output(f"  Running strategy {name}...")

            try:
                result = strategy_fn(client, uids)
                all_results.append(result)
                _write_output(f"    Time: {result.elapsed_seconds:.3f}s | Fetched: {result.emails_fetched}")
                _write_output(f"    Sample: {result.sample_snippet[:80]}...")
            except Exception as e:
                error_result = BenchmarkResult(
                    strategy=name,
                    batch_size=actual_count,
                    elapsed_seconds=0.0,
                    emails_fetched=0,
                    sample_snippet="",
                    error=str(e),
                )
                all_results.append(error_result)
                _write_output(f"    ERROR: {e}")

        _write_output("")

    # Print summary table
    _write_output("\n=== SUMMARY ===\n")
    table = _format_results_table(all_results)
    _write_output(table)

    # Side-by-side snippet comparison for the most recent N emails
    _write_output(f"\nGenerating snippet comparison for {COMPARISON_COUNT} emails...")
    comparison_uids = all_uids[-COMPARISON_COUNT:]
    _write_snippet_comparison(client, comparison_uids)

    # Cleanup
    client.logout()
    _write_output(f"\nResults saved to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
