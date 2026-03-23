"""
Standalone test script demonstrating two bugs in session-aware inbox filtering.

Bug 1: Existing tests use a mock that ignores the limit parameter,
       so overfetch logic is never actually verified.

Bug 2: Performance regression from 2 extra sequential Supabase queries
       that push list_inbox past the 8-second voice pipeline timeout.

Run: python3 test_overfetch.py
"""

import time
from dataclasses import dataclass
from typing import List, Set


# ============================================================================
# CONSTANTS
# ============================================================================

VOICE_PIPELINE_TIMEOUT = 8.0  # seconds -- the hard timeout for voice tool calls
SUPABASE_QUERY_DELAY = 2.0    # simulated Supabase round-trip time
IMAP_FETCH_DELAY = 3.0        # simulated IMAP fetch time


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class EmailSummary:
    """Minimal email representation for testing."""
    id: str
    subject: str


# ============================================================================
# SIMULATED IMAP BEHAVIOR
# ============================================================================

def list_inbox_production(all_emails: List[EmailSummary], limit: int) -> List[EmailSummary]:
    """
    Returns the last N emails (most recent), like real IMAP.
    This is how the production IMAP server behaves -- it respects the limit.
    """
    return all_emails[-limit:]


def list_inbox_flawed_mock(all_emails: List[EmailSummary], limit: int) -> List[EmailSummary]:
    """
    Returns ALL emails regardless of limit -- this is the bug in existing tests.
    The mock ignores the limit parameter, so overfetch is never actually needed.
    """
    return list(all_emails)


# ============================================================================
# FILTERING LOGIC (reproduced from action-queue.ts dispatchTool)
# ============================================================================

def filter_inbox(
    all_emails: List[EmailSummary],
    pending_delete_ids: Set[str],
    limit: int,
    list_inbox_fn,
    use_overfetch: bool,
) -> List[EmailSummary]:
    """
    Reproduces the session-aware inbox filtering logic from action-queue.ts.

    With overfetch: fetches limit + len(pending_delete_ids) emails, filters, slices.
    Without overfetch: fetches limit emails, filters (may return fewer than limit).

    Args:
        all_emails: the full mailbox (passed to the list_inbox function)
        pending_delete_ids: email IDs that are pending deletion
        limit: how many emails the user requested
        list_inbox_fn: the IMAP fetch function (production or flawed mock)
        use_overfetch: whether to add pending count to the fetch limit
    Returns:
        filtered list of emails, up to `limit` items
    """
    if use_overfetch:
        fetch_limit = limit + len(pending_delete_ids)
    else:
        fetch_limit = limit

    emails = list_inbox_fn(all_emails, fetch_limit)
    filtered = [e for e in emails if e.id not in pending_delete_ids]
    return filtered[:limit]


# ============================================================================
# SIMULATED SUPABASE QUERIES (for Bug 2 timing tests)
# ============================================================================

def simulate_supabase_query(name: str, delay: float = SUPABASE_QUERY_DELAY) -> dict:
    """Simulates a Supabase query with network latency."""
    time.sleep(delay)
    return {"data": [], "error": None}


def simulate_imap_fetch(delay: float = IMAP_FETCH_DELAY) -> list:
    """Simulates an IMAP inbox fetch with network latency."""
    time.sleep(delay)
    return []


# ============================================================================
# TEST HELPERS
# ============================================================================

def _make_emails(count: int) -> List[EmailSummary]:
    """Creates a list of emails with IDs email_1 through email_N."""
    return [EmailSummary(id=f"email_{i}", subject=f"Subject {i}") for i in range(1, count + 1)]


def _run_test(name: str, test_fn):
    """Runs a test function, catching assertion errors to show all results."""
    print(f"\n--- {name} ---")
    try:
        test_fn()
        print("PASS")
    except AssertionError as e:
        print(f"FAIL: {e}")


# ============================================================================
# BUG 1 TESTS: Flawed mock hides missing overfetch
# ============================================================================

def test_flawed_mock_hides_missing_overfetch():
    """
    Shows that the flawed mock (returns all emails regardless of limit)
    makes the filtering logic pass even WITHOUT overfetch.
    This is why the existing tests never caught the overfetch bug.
    """
    all_emails = _make_emails(10)
    # Mark the 5 most recent emails as pending deletion
    pending_ids = {f"email_{i}" for i in range(6, 11)}
    limit = 5

    # Without overfetch, using flawed mock -- still gets 5 results
    # because the mock returns ALL 10 emails regardless of limit=5
    result = filter_inbox(all_emails, pending_ids, limit, list_inbox_flawed_mock, use_overfetch=False)

    print(f"  Flawed mock, no overfetch: asked for {limit}, got {len(result)}")
    print(f"  Returned IDs: {[e.id for e in result]}")
    print(f"  The mock returned all 10 emails, so filtering still found 5 non-pending ones.")
    assert len(result) == limit, (
        f"Expected {limit} results but got {len(result)} -- "
        f"this should PASS with the flawed mock, proving it hides the bug"
    )


def test_production_mock_shows_bug_without_overfetch():
    """
    Shows that with production-like IMAP behavior (respects limit),
    NOT using overfetch causes us to return fewer emails than requested.
    """
    all_emails = _make_emails(10)
    # Mark the 5 most recent emails as pending deletion
    pending_ids = {f"email_{i}" for i in range(6, 11)}
    limit = 5

    # Without overfetch: fetch 5 most recent (email_6..10), all are pending, get 0
    result = filter_inbox(all_emails, pending_ids, limit, list_inbox_production, use_overfetch=False)

    print(f"  Production mock, no overfetch: asked for {limit}, got {len(result)}")
    print(f"  Fetched the 5 most recent emails, all were pending deletion -> 0 results")
    assert len(result) == 0, (
        f"Expected 0 results (all fetched emails are pending) but got {len(result)}"
    )


def test_production_mock_shows_overfetch_works():
    """
    Shows that with production-like IMAP behavior and overfetch enabled,
    we correctly compensate by fetching extra emails.
    """
    all_emails = _make_emails(10)
    # Mark the 5 most recent emails as pending deletion
    pending_ids = {f"email_{i}" for i in range(6, 11)}
    limit = 5

    # With overfetch: fetch 5 + 5 = 10 emails, filter out 5 pending, get 5
    result = filter_inbox(all_emails, pending_ids, limit, list_inbox_production, use_overfetch=True)

    print(f"  Production mock, with overfetch: asked for {limit}, got {len(result)}")
    print(f"  Fetched {limit + len(pending_ids)} emails, filtered out {len(pending_ids)} pending -> {len(result)} results")
    print(f"  Returned IDs: {[e.id for e in result]}")
    assert len(result) == limit, (
        f"Expected {limit} results with overfetch but got {len(result)}"
    )


# ============================================================================
# BUG 2 TESTS: Performance regression from sequential queries
# ============================================================================

def test_performance_regression():
    """
    Shows that the filtering code path makes 3 sequential operations
    (2 Supabase queries + 1 IMAP fetch) that approach the 8s timeout,
    while the non-filtering path makes only 1 operation (IMAP fetch).
    """
    # -- Non-filtered path (original behavior) --
    print("\n  Non-filtered path (no session filtering):")
    start = time.time()
    simulate_imap_fetch()
    non_filtered_time = time.time() - start
    print(f"    1 IMAP fetch: {non_filtered_time:.1f}s")
    print(f"    Well within {VOICE_PIPELINE_TIMEOUT}s timeout")

    # -- Filtered path (session-aware, 3 sequential operations) --
    print(f"\n  Filtered path (session-aware, sequential):")
    start = time.time()

    # Step 1: fetch pending email IDs from Supabase
    t1 = time.time()
    simulate_supabase_query("fetch_pending_email_ids")
    step1_time = time.time() - t1

    # Step 2: IMAP fetch with overfetch limit
    t2 = time.time()
    simulate_imap_fetch()
    step2_time = time.time() - t2

    # Step 3: fetch queued sends from Supabase
    t3 = time.time()
    simulate_supabase_query("fetch_queued_sends")
    step3_time = time.time() - t3

    filtered_time = time.time() - start

    print(f"    Step 1 - fetch_pending_email_ids (Supabase): {step1_time:.1f}s")
    print(f"    Step 2 - list_inbox with overfetch (IMAP):    {step2_time:.1f}s")
    print(f"    Step 3 - fetch_queued_sends (Supabase):       {step3_time:.1f}s")
    print(f"    Total: {filtered_time:.1f}s")
    print(f"    Timeout: {VOICE_PIPELINE_TIMEOUT}s")

    headroom = VOICE_PIPELINE_TIMEOUT - filtered_time
    print(f"    Headroom: {headroom:.1f}s {'(DANGER - too close or over!)' if headroom < 1.0 else ''}")

    # The filtered path should be dangerously close to (or over) the timeout
    assert filtered_time > (VOICE_PIPELINE_TIMEOUT - 1.5), (
        f"Expected filtered path ({filtered_time:.1f}s) to be within 1.5s of the "
        f"{VOICE_PIPELINE_TIMEOUT}s timeout, showing the performance regression"
    )

    # The non-filtered path should be comfortably within the timeout
    assert non_filtered_time < (VOICE_PIPELINE_TIMEOUT - 2.0), (
        f"Expected non-filtered path ({non_filtered_time:.1f}s) to be well within "
        f"the {VOICE_PIPELINE_TIMEOUT}s timeout"
    )


# ============================================================================
# ENTRY POINT
# ============================================================================

def main():
    print("=" * 70)
    print("TEST SCRIPT: Session-aware inbox filtering bugs")
    print("=" * 70)

    # Bug 1: Flawed mock hides the overfetch bug
    print("\n" + "=" * 70)
    print("BUG 1: Existing tests don't verify overfetch")
    print("=" * 70)

    _run_test(
        "Flawed mock hides missing overfetch (passes without overfetch)",
        test_flawed_mock_hides_missing_overfetch,
    )
    _run_test(
        "Production mock shows bug: no overfetch -> 0 results",
        test_production_mock_shows_bug_without_overfetch,
    )
    _run_test(
        "Production mock shows overfetch works correctly",
        test_production_mock_shows_overfetch_works,
    )

    # Bug 2: Performance regression
    print("\n" + "=" * 70)
    print("BUG 2: Performance regression from sequential Supabase queries")
    print("=" * 70)

    _run_test(
        "Sequential queries approach 8s timeout",
        test_performance_regression,
    )

    print("\n" + "=" * 70)
    print("Done.")
    print("=" * 70)


if __name__ == "__main__":
    main()
