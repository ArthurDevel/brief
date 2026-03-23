"""
Demonstrates the N+1 IMAP round trip problem in _fetch_summaries.

For each email, _fetch_summaries makes:
  - 1 batch IMAP fetch for ENVELOPE + BODYSTRUCTURE (all emails)
  - 1 individual IMAP fetch per email for the text snippet

With overfetch (e.g. 20 emails instead of 10), round trips double,
causing the 8-second voice pipeline timeout to be exceeded.

Run from the apps/voice-pipeline directory:
  python ../../testscripts/2026.03.23-imap-n-plus-one/test_imap_roundtrips.py
"""

import os
import subprocess
import sys
import time

# Add voice-pipeline to path so we can import email_client
sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), "..", "..", "apps", "voice-pipeline")
)

from imapclient import IMAPClient

from src.tools.email_client import list_inbox  # pyright: ignore[reportMissingImports]

# ============================================================================
# CONSTANTS
# ============================================================================

IMAP_PORT = 14_250
GMAIL_ROUNDTRIP_MS = 350  # Typical Gmail IMAP latency
VOICE_TIMEOUT_S = 8.0
HOODIECROW_STARTUP_WAIT_S = 0.5


# ============================================================================
# HELPERS
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


def measure_roundtrips(limit: int) -> tuple[int, float, int]:
    """Call list_inbox with the given limit and measure IMAP fetch calls.

    Args:
        limit: The limit parameter to pass to list_inbox.

    Returns:
        Tuple of (fetch_count, elapsed_ms, emails_returned).
    """
    client, fetch_count = create_counting_client("127.0.0.1", IMAP_PORT)

    start = time.perf_counter()
    emails = list_inbox(client, limit)
    elapsed_ms = (time.perf_counter() - start) * 1000

    count = fetch_count[0]
    client.logout()
    return count, elapsed_ms, len(emails)


# ============================================================================
# ENTRY POINT
# ============================================================================


def main():
    print("=" * 70)
    print("N+1 IMAP ROUND TRIP ANALYSIS")
    print("=" * 70)
    print()
    print(f"Gmail IMAP round trip estimate: {GMAIL_ROUNDTRIP_MS}ms")
    print(f"Voice pipeline timeout: {VOICE_TIMEOUT_S}s")
    print()

    proc = start_hoodiecrow()
    try:
        time.sleep(HOODIECROW_STARTUP_WAIT_S)

        # -- Table: fetch count per limit --
        print(
            f"{'Limit':>6} | {'Fetches':>8} | {'Local ms':>10} "
            f"| {'Est. Gmail':>12} | {'vs Timeout':>12}"
        )
        print("-" * 70)

        for limit in [5, 10, 15, 20]:
            fetches, local_ms, email_count = measure_roundtrips(limit)
            gmail_est_s = (fetches * GMAIL_ROUNDTRIP_MS) / 1000
            status = "OK" if gmail_est_s < VOICE_TIMEOUT_S else "TIMEOUT!"

            print(
                f"{limit:>6} | {fetches:>8} | {local_ms:>8.1f}ms "
                f"| {gmail_est_s:>10.1f}s | {status:>12}"
            )

        print()
        print("ANALYSIS:")
        print(
            "  Each email adds 1 extra IMAP round trip (individual snippet fetch)."
        )
        print(
            "  Formula: round_trips = 1 (batch ENVELOPE+BODYSTRUCTURE) "
            "+ N (individual snippet fetches)"
        )
        print()

        # -- Overfetch scenario --
        print("OVERFETCH SCENARIO:")
        print("  User asks for 10 emails, has 10 pending deletes.")
        print("  Overfetch limit = 10 + 10 = 20 emails.")
        fetches_20, _, _ = measure_roundtrips(20)
        gmail_20 = (fetches_20 * GMAIL_ROUNDTRIP_MS) / 1000
        print(f"  20 emails = {fetches_20} round trips = {gmail_20:.1f}s estimated")
        print(f"  Voice timeout = {VOICE_TIMEOUT_S}s")
        if gmail_20 >= VOICE_TIMEOUT_S:
            print(f"  --> EXCEEDS TIMEOUT by {gmail_20 - VOICE_TIMEOUT_S:.1f}s")
        print()

    finally:
        proc.kill()
        proc.wait()

    print("Done.")


if __name__ == "__main__":
    main()
