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
from typing import Any, Literal

from supabase import Client

from src.tools.vault import retrieve_secret


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
    transcript: list[TranscriptEntry] = field(default_factory=list)
    tokens_in: int = 0
    tokens_out: int = 0


@dataclass
class UserContext:
    """Full user context loaded from DB + Vault, needed to set up the pipeline."""

    user_id: str
    imap_config: ImapConfig
    smtp_config: SmtpConfig
    voice_preference: str
    voice_speed: float
    tool_approval_config: dict[str, str]
    memory_entries: list[MemoryEntry]


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

    session_id = response.data[0]["id"]

    logger.info("[session] Started session %s for user %s", session_id, user_id)

    return ActiveSession(
        session_id=session_id,
        user_id=user_id,
        started_at=started_at,
    )


def add_transcript_entry(session: ActiveSession, role: Literal["user", "assistant"], text: str) -> None:
    """Append a transcript entry with an ISO timestamp to the in-memory session.

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

def load_user_context(user_id: str, supabase: Client) -> UserContext:
    """Load full user context from DB and Vault (settings, memory, credentials).

    Args:
        user_id: The user ID to load context for.
        supabase: Supabase client for DB + Vault operations.

    Returns:
        UserContext with IMAP/SMTP configs, preferences, and memory.

    Raises:
        RuntimeError: If user settings are missing or credentials are not configured.
    """
    # Load user settings
    settings_response = (
        supabase.table("user_settings")
        .select("*")
        .eq("user_id", user_id)
        .single()
        .execute()
    )

    if settings_response.data is None:
        raise RuntimeError(f"User settings not found for {user_id}")

    settings = settings_response.data

    # Validate credential references exist
    if not settings.get("imap_password_secret_id"):
        raise RuntimeError(f"IMAP credentials not configured for user {user_id}")

    if not settings.get("smtp_password_secret_id"):
        raise RuntimeError(f"SMTP credentials not configured for user {user_id}")

    # Retrieve IMAP and SMTP passwords from Vault
    imap_password = retrieve_secret(supabase, settings["imap_password_secret_id"])
    smtp_password = retrieve_secret(supabase, settings["smtp_password_secret_id"])

    # Load user memory entries
    memory_response = (
        supabase.table("user_memory")
        .select("id, content")
        .eq("user_id", user_id)
        .execute()
    )

    if memory_response.data is None:
        raise RuntimeError(f"Failed to load memory for {user_id}")

    memory_entries = [
        MemoryEntry(id=row["id"], content=row["content"])
        for row in memory_response.data
    ]

    imap_config = ImapConfig(
        host=settings["imap_host"],
        port=settings["imap_port"],
        user=settings["imap_user"],
        password=imap_password,
    )

    smtp_config = SmtpConfig(
        host=settings["smtp_host"],
        port=settings["smtp_port"],
        user=settings["smtp_user"],
        password=smtp_password,
    )

    return UserContext(
        user_id=user_id,
        imap_config=imap_config,
        smtp_config=smtp_config,
        voice_preference=(settings.get("voice_config") or {}).get("voice", "aura-2-helena-en"),
        voice_speed=float((settings.get("voice_config") or {}).get("speed", 1.0)),
        tool_approval_config=settings.get("tool_approval_config") or {},
        memory_entries=memory_entries,
    )
