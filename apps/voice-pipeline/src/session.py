"""
Session lifecycle management for voice calls.

Port of apps/voice-gateway/src/session-manager.ts.

Tracks active call sessions including transcripts and token usage.
Creates session rows in the database at call start and finalizes
them with duration, cost, and transcript data at call end.

- start_session: create a session row and return an in-memory tracker
- add_transcript_entry: append transcript lines during the call
- add_token_usage: accumulate token counts from LLM responses
- end_session: write duration, transcript, tokens, and cost to DB
- load_user_context: load user settings, memory, and credentials from DB + Vault
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, cast


EmailProvider = Literal["gmail", "outlook", "custom"]

from supabase import Client

from src.tools.vault import retrieve_secret
from src.user_settings_defaults import (
    get_default_tool_approval_config,
    get_default_voice_config,
)


logger = logging.getLogger(__name__)


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class TranscriptEntry:
    """A single entry in the call transcript."""

    role: Literal["user", "assistant"]
    text: str
    timestamp: str  # ISO 8601


@dataclass
class ImapConfig:
    """IMAP connection parameters."""

    host: str
    port: int
    user: str
    password: str


@dataclass
class SmtpConfig:
    """SMTP connection parameters."""

    host: str
    port: int
    user: str
    password: str


@dataclass
class MemoryEntry:
    """A single user memory entry."""

    id: str
    content: str


@dataclass
class ActiveSession:
    """In-memory tracker for an active voice call session."""

    session_id: str
    user_id: str
    started_at: datetime
    supabase: Client
    transcript: list[TranscriptEntry] = field(default_factory=list)
    tokens_in: int = 0
    tokens_out: int = 0


@dataclass
class EmailAccount:
    """Active email account resolved from user_email_accounts.

    Attributes:
        provider: The email provider type ("gmail", "outlook", "custom").
        connection_type: How the account connects ("unipile" or "imap_smtp").
        email_address: The user's email address (if known).
        unipile_account_id: Unipile account ID (only for unipile accounts).
        status: Account connection status.
        imap_config: IMAP config (only for custom/imap_smtp accounts).
        smtp_config: SMTP config (only for custom/imap_smtp accounts).
    """

    provider: str  # "gmail" | "outlook" | "custom"
    connection_type: str  # "unipile" | "imap_smtp"
    email_address: str | None
    unipile_account_id: str | None
    status: str
    imap_config: ImapConfig | None
    smtp_config: SmtpConfig | None


@dataclass
class UserContext:
    """Full user context loaded from DB + Vault, needed to set up the pipeline."""

    user_id: str
    email_account: EmailAccount
    voice_preference: str
    voice_speed: float
    tool_approval_config: dict[str, str]
    memory_entries: list[MemoryEntry]
    email_provider: EmailProvider
    timezone: str | None = None


@dataclass
class SessionMetadata:
    """Metadata about the current session, injected into the system prompt."""

    current_datetime: str      # ISO 8601 formatted current date/time (with timezone)
    user_email: str            # The user's email address
    last_call_datetime: str | None  # ISO 8601 datetime of last call end, or None for first call


# ============================================================================
# MAIN LOGIC
# ============================================================================

def start_session(user_id: str, supabase: Client) -> ActiveSession:
    """Create a new session row in the database and return an in-memory tracker.

    Args:
        user_id: The ID of the user starting the call.
        supabase: Supabase client for DB operations.

    Returns:
        ActiveSession tracker for the call duration.

    Raises:
        RuntimeError: If the database insert fails.
    """
    started_at = datetime.now(timezone.utc)

    response = (
        supabase.table("sessions")
        .insert({
            "user_id": user_id,
            "started_at": started_at.isoformat(),
        })
        .execute()
    )

    if not response.data:
        raise RuntimeError("Failed to create session: no data returned")

    data = cast(list[dict[str, Any]], response.data)
    session_id = data[0]["id"]

    logger.info("[session] Started session %s for user %s", session_id, user_id)

    return ActiveSession(
        session_id=session_id,
        user_id=user_id,
        started_at=started_at,
        supabase=supabase,
    )


def get_last_session_end_time(user_id: str, supabase: Client) -> datetime | None:
    """Get the end time of the user's most recent completed session.

    Args:
        user_id: The user to look up.
        supabase: Supabase client for DB operations.

    Returns:
        The ended_at datetime of the last completed session, or None if no sessions exist.
    """
    response = (
        supabase.table("sessions")
        .select("ended_at")
        .eq("user_id", user_id)
        .not_.is_("ended_at", "null")
        .order("ended_at", desc=True)
        .limit(1)
        .execute()
    )

    if not response.data:
        return None

    data = cast(list[dict[str, Any]], response.data)
    ended_at_str = str(data[0]["ended_at"])

    logger.debug("[session] Last session end time for user %s: %s", user_id, ended_at_str)

    return datetime.fromisoformat(ended_at_str)


def add_transcript_entry(session: ActiveSession, role: Literal["user", "assistant"], text: str) -> None:
    """Append a transcript entry and immediately flush the full transcript to the database.

    Args:
        session: The active session to update.
        role: Either "user" or "assistant".
        text: The transcribed or generated text.
    """
    entry = TranscriptEntry(
        role=role,
        text=text,
        timestamp=datetime.now(timezone.utc).isoformat(),
    )
    session.transcript.append(entry)

    _flush_transcript(session)


def add_token_usage(session: ActiveSession, tokens_in: int, tokens_out: int) -> None:
    """Accumulate token usage from an LLM response.

    Args:
        session: The active session to update.
        tokens_in: Number of input tokens from this response.
        tokens_out: Number of output tokens from this response.
    """
    session.tokens_in += tokens_in
    session.tokens_out += tokens_out


def end_session(session: ActiveSession, cost_summary: Any, supabase: Client) -> None:
    """Finalize a session: calculate duration, write cost and transcript to DB.

    Uses token counts and total cost from the CostSummary provided by cost_tracker.py.

    Args:
        session: The active session to finalize.
        cost_summary: A CostSummary instance from cost_tracker.py with fields:
            llm_input_tokens, llm_output_tokens, total_cost.
        supabase: Supabase client for DB operations.

    Raises:
        RuntimeError: If the database update fails.
    """
    ended_at = datetime.now(timezone.utc)
    duration_seconds = round((ended_at - session.started_at).total_seconds())

    # Serialize transcript entries for JSON storage
    transcript_data = [
        {"role": entry.role, "text": entry.text, "timestamp": entry.timestamp}
        for entry in session.transcript
    ]

    response = (
        supabase.table("sessions")
        .update({
            "ended_at": ended_at.isoformat(),
            "duration_seconds": duration_seconds,
            "transcript": transcript_data,
            "tokens_in": cost_summary.llm_input_tokens,
            "tokens_out": cost_summary.llm_output_tokens,
            "cost_usd": round(cost_summary.total_cost, 4),
        })
        .eq("id", session.session_id)
        .execute()
    )

    if not response.data:
        raise RuntimeError(f"Failed to end session {session.session_id}: no data returned")

    logger.info(
        "[session] Ended %s: %ds, %d tokens in, %d tokens out, $%.4f",
        session.session_id,
        duration_seconds,
        cost_summary.llm_input_tokens,
        cost_summary.llm_output_tokens,
        cost_summary.total_cost,
    )


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

_COUNTRY_CODE_TO_TIMEZONE: dict[str, str] = {
    "US": "America/New_York",
    "BE": "Europe/Brussels",
    "GB": "Europe/London",
    "NL": "Europe/Amsterdam",
    "DE": "Europe/Berlin",
    "FR": "Europe/Paris",
}


def _timezone_from_country_code(country_code: str) -> str | None:
    """Map an ISO 3166-1 alpha-2 country code to a default IANA timezone.

    Args:
        country_code: Two-letter country code (e.g. "US", "BE").

    Returns:
        IANA timezone string, or None if the country code is not mapped.
    """
    return _COUNTRY_CODE_TO_TIMEZONE.get(country_code)


def _flush_transcript(session: ActiveSession) -> None:
    """Write the current in-memory transcript to the database.

    Args:
        session: The active session whose transcript to flush.
    """
    transcript_data = [
        {"role": entry.role, "text": entry.text, "timestamp": entry.timestamp}
        for entry in session.transcript
    ]

    try:
        session.supabase.table("sessions").update(
            {"transcript": transcript_data}
        ).eq("id", session.session_id).execute()
    except Exception:
        logger.exception("[session] Failed to flush transcript for session %s", session.session_id)


def load_user_context(user_id: str, supabase: Client) -> UserContext:
    """Load full user context from DB and Vault (settings, memory, email account).

    Reads the active email account from user_email_accounts, resolves custom
    Vault secrets when needed, and loads voice/tool/memory/timezone from
    user_settings. If the user has no settings row yet, sensible defaults are
    used instead.

    Args:
        user_id: The user ID to load context for.
        supabase: Supabase client for DB + Vault operations.

    Returns:
        UserContext with email account, preferences, and memory.

    Raises:
        RuntimeError: If no active email account is found.
    """
    # Step 1: Load user settings (voice, tool approval, timezone -- no email fields)
    settings_response = (
        supabase.table("user_settings")
        .select("*")
        .eq("user_id", user_id)
        .maybe_single()
        .execute()
    )
    settings = cast(dict[str, Any], settings_response.data or {})

    # Step 2: Load active email account from user_email_accounts
    account_response = (
        supabase.table("user_email_accounts")
        .select("*")
        .eq("user_id", user_id)
        .eq("is_active", True)
        .limit(1)
        .execute()
    )

    account_rows = cast(list[dict[str, Any]], account_response.data or [])
    if not account_rows:
        raise RuntimeError(f"No active email account found for user {user_id}")

    account_row = account_rows[0]
    email_account = build_email_account(account_row, supabase)

    # Step 3: Load user memory entries
    memory_response = (
        supabase.table("user_memory")
        .select("id, content")
        .eq("user_id", user_id)
        .execute()
    )

    if memory_response.data is None:
        raise RuntimeError(f"Failed to load memory for {user_id}")

    memory_rows = cast(list[dict[str, Any]], memory_response.data)
    memory_entries = [
        MemoryEntry(id=str(row["id"]), content=str(row["content"]))
        for row in memory_rows
    ]

    default_voice_config = get_default_voice_config()
    voice_config = cast(dict[str, Any], settings.get("voice_config") or {})
    default_tool_approval_config = get_default_tool_approval_config()

    # Extract timezone: prefer call_schedule.timezone, fall back to phone country code
    call_schedule = settings.get("call_schedule")
    user_timezone: str | None = call_schedule.get("timezone") if call_schedule else None
    if user_timezone is None:
        phone = settings.get("phone")
        if phone and phone.get("countryCode"):
            user_timezone = _timezone_from_country_code(phone["countryCode"])

    # Derive email_provider directly from the account row's provider field
    email_provider = cast(EmailProvider, email_account.provider)

    return UserContext(
        user_id=user_id,
        email_account=email_account,
        voice_preference=str(voice_config.get("voice", default_voice_config["voice"])),
        voice_speed=float(voice_config.get("speed", default_voice_config["speed"])),
        tool_approval_config=cast(
            dict[str, str],
            settings.get("tool_approval_config") or default_tool_approval_config,
        ),
        memory_entries=memory_entries,
        email_provider=email_provider,
        timezone=user_timezone,
    )


def build_email_account(account_row: dict[str, Any], supabase: Client) -> EmailAccount:
    """Build an EmailAccount from a user_email_accounts DB row.

    For custom (imap_smtp) accounts, retrieves IMAP/SMTP passwords from Vault.
    For Unipile accounts, imap_config and smtp_config are left as None.

    Args:
        account_row: A row from user_email_accounts.
        supabase: Supabase client for Vault secret retrieval.

    Returns:
        Fully populated EmailAccount dataclass.

    Raises:
        RuntimeError: If a custom account is missing required credential references.
    """
    connection_type = str(account_row["connection_type"])
    imap_config: ImapConfig | None = None
    smtp_config: SmtpConfig | None = None

    if connection_type == "imap_smtp":
        # Custom account: resolve IMAP/SMTP credentials from Vault
        if not account_row.get("imap_password_secret_id"):
            raise RuntimeError(
                f"IMAP credentials not configured for email account {account_row['id']}"
            )
        if not account_row.get("smtp_password_secret_id"):
            raise RuntimeError(
                f"SMTP credentials not configured for email account {account_row['id']}"
            )

        imap_password = retrieve_secret(supabase, str(account_row["imap_password_secret_id"]))
        smtp_password = retrieve_secret(supabase, str(account_row["smtp_password_secret_id"]))

        imap_config = ImapConfig(
            host=str(account_row["imap_host"]),
            port=int(account_row["imap_port"]),
            user=str(account_row["imap_user"]),
            password=imap_password,
        )
        smtp_config = SmtpConfig(
            host=str(account_row["smtp_host"]),
            port=int(account_row["smtp_port"]),
            user=str(account_row["smtp_user"]),
            password=smtp_password,
        )

    return EmailAccount(
        provider=str(account_row["provider"]),
        connection_type=connection_type,
        email_address=account_row.get("email_address"),
        unipile_account_id=account_row.get("unipile_account_id"),
        status=str(account_row["status"]),
        imap_config=imap_config,
        smtp_config=smtp_config,
    )
