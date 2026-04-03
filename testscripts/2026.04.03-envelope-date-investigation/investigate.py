"""
Investigate Gmail IMAP envelope date timezone behavior.

We need to determine whether Gmail's IMAP ENVELOPE dates are:
- timezone-aware or naive
- in UTC or some other timezone

This matters because our _filter_uids_by_datetime code assumes naive dates are UTC,
and a production call with since="2026-04-03T08:47:57-07:00" returned 0 results
even though emails existed at 9:00 AM and 9:15 AM.

Responsibilities:
- Connect to Gmail IMAP and fetch recent envelope dates
- Print diagnostic info about each envelope date (type, tzinfo, raw value)
- Simulate the production filter logic to see which emails pass/fail
"""

import os
import sys
from datetime import datetime, timezone, timedelta

from dotenv import load_dotenv
from imapclient import IMAPClient
from supabase import create_client


# ============================================================================
# CONSTANTS
# ============================================================================

# The exact value the LLM passed in production
PRODUCTION_SINCE = datetime(2026, 4, 3, 8, 47, 57, 840710, tzinfo=timezone(timedelta(hours=-7)))

# How many days back to search
SEARCH_DAYS = 2


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _load_credentials() -> dict:
    """
    Load IMAP credentials from .env file.
    Fails fast if any required credential is missing or empty.

    Returns:
        dict with keys: host, port, user, password
    """
    # Only load the local .env (IMAP_HOST/USER/PASSWORD)
    load_dotenv()

    host = os.getenv("IMAP_HOST", "")
    port = os.getenv("IMAP_PORT", "")
    user = os.getenv("IMAP_USER", "")
    password = os.getenv("IMAP_PASSWORD", "")

    if not host or not port or not user or not password:
        missing = []
        if not host: missing.append("IMAP_HOST")
        if not port: missing.append("IMAP_PORT")
        if not user: missing.append("IMAP_USER")
        if not password: missing.append("IMAP_PASSWORD")
        raise ValueError(f"Missing or empty credentials in .env: {', '.join(missing)}")

    return {"host": host, "port": int(port), "user": user, "password": password}


# Default IMAP user for Supabase lookup
SUPABASE_IMAP_USER_FALLBACK = "arthur.stockman.me@gmail.com"


def _load_credentials_from_supabase() -> dict:
    """
    Load IMAP credentials from the production Supabase database.
    Uses the voice-pipeline .env for SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY,
    then queries user_settings + vault for the IMAP password.

    Returns:
        dict with keys: host, port, user, password
    """
    # Load Supabase credentials from the voice-pipeline .env
    pipeline_env = os.path.join(os.path.dirname(__file__), "../../apps/voice-pipeline/.env")
    load_dotenv(pipeline_env)

    supabase_url = os.getenv("SUPABASE_URL", "")
    supabase_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")

    if not supabase_url or not supabase_key:
        raise ValueError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in voice-pipeline .env")

    # Determine which IMAP user to look up
    imap_user = os.getenv("IMAP_USER", "") or SUPABASE_IMAP_USER_FALLBACK

    # Query user_settings for this IMAP user
    supabase = create_client(supabase_url, supabase_key)
    response = supabase.table("user_settings").select("*").eq("imap_user", imap_user).single().execute()
    settings: dict = response.data  # type: ignore[assignment]

    if not settings:
        raise ValueError(f"No user_settings found for imap_user={imap_user}")

    host: str = settings["imap_host"]
    port: int = settings["imap_port"]
    user: str = settings["imap_user"]

    # Retrieve the IMAP password from Supabase Vault
    secret_id: str = settings["imap_password_secret_id"]
    vault_response = supabase.rpc("vault_retrieve_secret", {"secret_id": secret_id}).execute()
    password = str(vault_response.data)

    if not password:
        raise ValueError(f"Vault returned empty password for secret_id={secret_id}")

    print(f"[Supabase] Loaded credentials for {user} from user_settings + vault")
    return {"host": host, "port": port, "user": user, "password": password}


def _connect(credentials: dict) -> IMAPClient:
    """
    Connect and authenticate to the IMAP server.

    Args:
        credentials: dict with host, port, user, password

    Returns:
        Authenticated IMAPClient instance
    """
    client = IMAPClient(credentials["host"], port=credentials["port"], ssl=True)
    client.login(credentials["user"], credentials["password"])
    return client


def _print_envelope_diagnostics(uid: int, envelope) -> None:
    """
    Print diagnostic info about a single envelope date.

    Args:
        uid: the email UID
        envelope: the ENVELOPE object from imapclient
    """
    env_date = envelope.date
    subject_raw = envelope.subject
    subject = subject_raw.decode("utf-8", errors="replace") if isinstance(subject_raw, bytes) else str(subject_raw)
    subject_short = subject[:50]

    tzinfo_str = str(env_date.tzinfo) if env_date.tzinfo is not None else "NAIVE"

    # Convert to UTC for display
    if env_date.tzinfo is not None:
        utc_equivalent = env_date.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    else:
        utc_equivalent = env_date.strftime("%Y-%m-%d %H:%M:%S") + " (assumed UTC)"

    print(f"  UID:            {uid}")
    print(f"  Subject:        {subject_short}")
    print(f"  envelope.date:  {env_date}")
    print(f"  type():         {type(env_date).__name__}")
    print(f"  tzinfo:         {tzinfo_str}")
    print(f"  UTC equivalent: {utc_equivalent}")
    print()


def _simulate_filter(uid: int, envelope, since: datetime) -> bool:
    """
    Simulate the production _filter_uids_by_datetime logic on a single email.

    This is the exact logic from production:
        if env_date.tzinfo is None:
            env_date = env_date.replace(tzinfo=timezone.utc)
        since_aware = since if since.tzinfo is not None else since.replace(tzinfo=timezone.utc)
        passes = env_date > since_aware

    Args:
        uid: the email UID
        envelope: the ENVELOPE object from imapclient
        since: the since datetime to filter against

    Returns:
        True if the email passes the filter (would be included)
    """
    env_date = envelope.date
    subject_raw = envelope.subject
    subject = subject_raw.decode("utf-8", errors="replace") if isinstance(subject_raw, bytes) else str(subject_raw)
    subject_short = subject[:50]

    # -- Fixed filter logic: compare as naive local times --
    since_naive = since.replace(tzinfo=None)
    env_naive = env_date.replace(tzinfo=None) if env_date.tzinfo is not None else env_date
    passes = env_naive > since_naive

    result_str = "PASS" if passes else "FAIL"
    print(f"  [{result_str}] UID {uid}: {subject_short}")
    print(f"         envelope (naive): {env_naive.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"         since    (naive): {since_naive.strftime('%Y-%m-%d %H:%M:%S')}")
    print(f"         env > since?      {passes}")
    print()

    return passes


# ============================================================================
# MAIN
# ============================================================================

def main():
    print("=" * 70)
    print("ENVELOPE DATE INVESTIGATION")
    print("=" * 70)
    print()

    # Step 1: Load credentials and connect
    # Try local .env first, fall back to Supabase vault for production credentials
    try:
        credentials = _load_credentials()
    except ValueError as e:
        print(f"Local credentials not available ({e}), trying Supabase vault...")
        credentials = _load_credentials_from_supabase()
    print(f"Connecting to {credentials['host']}:{credentials['port']} as {credentials['user']}...")
    client = _connect(credentials)
    print("Connected.")
    print()

    # Step 2: Select INBOX and search for recent emails
    client.select_folder("INBOX", readonly=True)

    since_date = (datetime.now() - timedelta(days=SEARCH_DAYS)).date()
    since_date_str = since_date.strftime("%d-%b-%Y")
    print(f"Searching for emails since {since_date} (IMAP SINCE)...")
    uids = client.search(f"SINCE {since_date_str}")
    print(f"Found {len(uids)} UIDs: {list(uids)}")
    print()

    if not uids:
        print("No emails found. Nothing to investigate.")
        client.logout()
        return

    # Step 3: Fetch envelopes
    fetched = client.fetch(uids, ["ENVELOPE"])

    # Step 4: Print diagnostic table
    print("=" * 70)
    print("ENVELOPE DATE DIAGNOSTICS")
    print("=" * 70)
    print()

    for uid in uids:
        envelope = fetched[uid][b"ENVELOPE"]
        _print_envelope_diagnostics(uid, envelope)

    # Step 5: Simulate production filter
    print("=" * 70)
    print("FILTER SIMULATION")
    print(f"Production since value: {PRODUCTION_SINCE}")
    print(f"Production since (UTC): {PRODUCTION_SINCE.astimezone(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 70)
    print()

    pass_count = 0
    fail_count = 0

    for uid in uids:
        envelope = fetched[uid][b"ENVELOPE"]
        if _simulate_filter(uid, envelope, PRODUCTION_SINCE):
            pass_count += 1
        else:
            fail_count += 1

    # Step 6: Summary
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    print(f"  Total emails: {len(uids)}")
    print(f"  Passed filter: {pass_count}")
    print(f"  Failed filter: {fail_count}")
    print()

    client.logout()
    print("Done.")


if __name__ == "__main__":
    main()
