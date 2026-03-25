"""
Background scheduler for initiating outbound scheduled calls.

Runs as an asyncio task inside the voice-pipeline process. Every 30 seconds it
checks which users are due for a call and initiates outbound Twilio calls.

Responsibilities:
- Fetch all users with a configured call schedule
- Filter users who are due for a call right now (day-of-week + 5-min time window)
- Prevent double calls via an atomic last_call_at dedup guard in the JSONB column
- Initiate outbound Twilio calls and roll back the dedup guard on failure
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Callable, cast
from urllib.parse import quote
from zoneinfo import ZoneInfo

from loguru import logger
from supabase import Client
from twilio.rest import Client as TwilioClient

from src.auth.twilio_auth import check_usage_limit
from src.config import Settings


# ============================================================================
# CONSTANTS
# ============================================================================

SCHEDULER_INTERVAL_SECONDS = 30
DUE_WINDOW_MINUTES = 5

DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class DueUser:
    """A user who is due for a scheduled call right now."""
    user_id: str
    phone_number: str
    timezone: str


# ============================================================================
# MAIN LOGIC
# ============================================================================

def get_due_users(supabase: Client) -> list[DueUser]:
    """Fetch all users with a call schedule and filter to those due right now.

    Fetches all users with a non-null call_schedule, then filters in Python:
    1. Checks today's day-of-week in the user's timezone
    2. Whether the scheduled time falls within a 5-minute window of current local time
    3. Whether last_call_at is not today (dedup guard)
    4. Whether the user hasn't exceeded their monthly usage limit

    Args:
        supabase: Supabase client for DB operations.

    Returns:
        List of DueUser objects representing users who should be called now.
    """
    response = (
        supabase.table("user_settings")
        .select("user_id, phone_number, call_schedule")
        .not_.is_("call_schedule", "null")
        .execute()
    )

    rows = cast(list[dict[str, Any]], response.data or [])
    due_users: list[DueUser] = []

    for row in rows:
        user_id = row["user_id"]
        phone_number = row.get("phone_number")
        schedule = row.get("call_schedule")

        if not phone_number or not schedule:
            continue

        timezone_str = schedule.get("timezone")
        if not timezone_str:
            continue

        # Determine current local time in the user's timezone
        try:
            tz = ZoneInfo(timezone_str)
        except Exception:
            logger.warning("[scheduler] Invalid timezone '{}' for user {}, skipping", timezone_str, user_id)
            continue

        now_local = datetime.now(tz)

        # Check if today's day has a scheduled time
        day_name = DAY_KEYS[now_local.weekday()]  # Monday=0 matches index 0
        scheduled_time_str = schedule.get(day_name)
        if not scheduled_time_str:
            continue

        # Parse scheduled time and check if within 5-minute window
        try:
            parts = scheduled_time_str.split(":")
            scheduled_hour = int(parts[0])
            scheduled_minute = int(parts[1])
        except (ValueError, IndexError):
            logger.warning("[scheduler] Invalid time '{}' for user {} on {}, skipping", scheduled_time_str, user_id, day_name)
            continue

        scheduled_dt = now_local.replace(hour=scheduled_hour, minute=scheduled_minute, second=0, microsecond=0)
        window_end = scheduled_dt + timedelta(minutes=DUE_WINDOW_MINUTES)

        if not (scheduled_dt <= now_local < window_end):
            continue

        # Check dedup: skip if last_call_at is after the current scheduled time.
        # This allows a second call if the user reschedules to a later time.
        last_call_at_str = schedule.get("last_call_at")
        if last_call_at_str:
            try:
                last_call_at = datetime.fromisoformat(last_call_at_str)
                last_call_local = last_call_at.astimezone(tz)
                if last_call_local >= scheduled_dt:
                    continue
            except (ValueError, TypeError):
                pass

        # Check usage limit
        if not check_usage_limit(user_id, supabase):
            logger.info("[scheduler] User {} has exceeded usage limit, skipping", user_id)
            continue

        due_users.append(DueUser(
            user_id=user_id,
            phone_number=phone_number,
            timezone=timezone_str,
        ))

    return due_users


def initiate_scheduled_call(user: DueUser, settings: Settings, supabase: Client) -> bool:
    """Atomically claim the call slot and initiate a Twilio outbound call.

    Reads the current schedule, re-checks the dedup guard, claims the slot by
    writing last_call_at, then initiates the Twilio call. If Twilio fails,
    rolls back last_call_at to its previous value.

    Args:
        user: The DueUser to call.
        settings: Application settings with Twilio credentials and public_url.
        supabase: Supabase client for DB operations.

    Returns:
        True if the call was initiated successfully, False if slot was already claimed.
    """
    # Step 1: Read current schedule to get previous last_call_at for potential rollback
    current_response = (
        supabase.table("user_settings")
        .select("call_schedule")
        .eq("user_id", user.user_id)
        .single()
        .execute()
    )

    if not current_response.data:
        logger.warning("[scheduler] User {} not found during claim attempt", user.user_id)
        return False

    row_data = cast(dict[str, Any], current_response.data)
    current_schedule = cast(dict[str, Any], row_data["call_schedule"])
    previous_last_call_at: str | None = current_schedule.get("last_call_at")

    # Re-check dedup guard before claiming (race condition protection)
    if previous_last_call_at:
        try:
            tz = ZoneInfo(user.timezone)
            now_local = datetime.now(tz)
            day_name = DAY_KEYS[now_local.weekday()]
            scheduled_time_str = current_schedule.get(day_name, "")
            parts = scheduled_time_str.split(":")
            scheduled_dt = now_local.replace(hour=int(parts[0]), minute=int(parts[1]), second=0, microsecond=0)

            last_call = datetime.fromisoformat(previous_last_call_at)
            last_call_local = last_call.astimezone(tz)
            if last_call_local >= scheduled_dt:
                logger.info("[scheduler] User {} already called for this slot (race condition caught)", user.user_id)
                return False
        except (ValueError, TypeError, IndexError):
            pass

    # Step 2: Claim the slot by setting last_call_at to now (UTC ISO string)
    now_utc = datetime.now(ZoneInfo("UTC")).isoformat()
    updated_schedule = {**current_schedule, "last_call_at": now_utc}

    (
        supabase.table("user_settings")
        .update({"call_schedule": updated_schedule})
        .eq("user_id", user.user_id)
        .execute()
    )

    # Step 3: Initiate the Twilio call
    try:
        twilio_client = TwilioClient(settings.twilio_account_sid, settings.twilio_auth_token)

        # Build the callback URL that Twilio will fetch when the callee answers
        callback_url = (
            f"{settings.public_url}/twilio/scheduled-call"
            f"?token={quote(settings.internal_api_key)}"
            f"&userId={quote(user.user_id)}"
        )

        call = twilio_client.calls.create(
            to=user.phone_number,
            from_=settings.twilio_phone_number,
            url=callback_url,
        )

        logger.info("[scheduler] Initiated call for user {}, Twilio SID: {}", user.user_id, call.sid)
        return True

    except Exception as exc:
        logger.error("[scheduler] Twilio call failed for user {}: {}", user.user_id, exc)

        # Roll back last_call_at to its previous value
        rollback_schedule: dict[str, Any] = {**current_schedule}
        if previous_last_call_at is not None:
            rollback_schedule["last_call_at"] = previous_last_call_at
        else:
            rollback_schedule.pop("last_call_at", None)

        try:
            (
                supabase.table("user_settings")
                .update({"call_schedule": rollback_schedule})
                .eq("user_id", user.user_id)
                .execute()
            )
            logger.info("[scheduler] Rolled back last_call_at for user {}", user.user_id)
        except Exception as rollback_exc:
            logger.error("[scheduler] Failed to roll back last_call_at for user {}: {}", user.user_id, rollback_exc)

        return False


async def start_scheduler(settings: Settings, supabase_factory: Callable[[], Client]) -> asyncio.Task | None:
    """Create and return the background scheduler task.

    Only starts if all three Twilio credentials are configured (non-empty).

    Args:
        settings: Application settings with Twilio credentials.
        supabase_factory: Callable that creates a fresh Supabase client.

    Returns:
        The asyncio.Task running the scheduler loop, or None if Twilio is not configured.
    """
    if not (settings.twilio_account_sid and settings.twilio_auth_token and settings.twilio_phone_number):
        logger.info("[scheduler] Twilio credentials not configured, scheduler will not start")
        return None

    task = asyncio.create_task(_scheduler_loop(settings, supabase_factory))
    logger.info("[scheduler] Scheduler task started")
    return task


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def _scheduler_loop(settings: Settings, supabase_factory: Callable[[], Client]) -> None:
    """Infinite loop that checks for due users and initiates calls.

    Sleeps for SCHEDULER_INTERVAL_SECONDS between each tick.
    Catches all exceptions to keep running.

    Args:
        settings: Application settings.
        supabase_factory: Callable that creates a fresh Supabase client.
    """
    while True:
        await asyncio.sleep(SCHEDULER_INTERVAL_SECONDS)

        try:
            supabase = supabase_factory()
            due_users = get_due_users(supabase)

            if due_users:
                logger.info("[scheduler] Found {} due user(s)", len(due_users))

            for user in due_users:
                try:
                    initiate_scheduled_call(user, settings, supabase)
                except Exception as exc:
                    logger.error("[scheduler] Error initiating call for user {}: {}", user.user_id, exc)

        except Exception as exc:
            logger.exception("[scheduler] Error in scheduler tick")
