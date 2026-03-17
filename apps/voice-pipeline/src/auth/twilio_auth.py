"""
Twilio webhook authentication helpers for incoming voice calls.

Port of apps/voice-gateway/src/twilio-handler.ts.

- Look up a user by phone number
- Verify a DTMF PIN against a bcrypt hash
- Check monthly usage limits against the subscription plan
- Build TwiML XML responses for Gather, Connect, and Reject
"""

import logging
from datetime import datetime, timezone
from typing import Any, cast
from urllib.parse import quote

import bcrypt
from supabase import Client


logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

MAX_PIN_ATTEMPTS = 3
PIN_NUM_DIGITS = 6
SECONDS_PER_HOUR = 3600


# ============================================================================
# MAIN LOGIC
# ============================================================================

def lookup_user_by_phone(phone: str, supabase: Client) -> dict | None:
    """Look up a user in user_settings by phone number.

    Args:
        phone: The caller's phone number (E.164 format from Twilio).
        supabase: Supabase client for DB operations.

    Returns:
        Dict with user_id and pin_locked, or None if not found.
    """
    response = (
        supabase.table("user_settings")
        .select("user_id, pin_locked")
        .eq("phone_number", phone)
        .single()
        .execute()
    )

    if response.data is None:
        logger.info("[twilio_auth] No user found for %s", phone)
        return None

    data = cast(dict[str, Any], response.data)
    return {
        "user_id": data["user_id"],
        "pin_locked": data.get("pin_locked", False),
    }


def verify_pin(digits: str, pin_hash: str) -> bool:
    """Verify DTMF digits against a stored bcrypt PIN hash.

    Args:
        digits: The DTMF digits entered by the caller.
        pin_hash: The bcrypt hash stored in user_settings.

    Returns:
        True if the PIN matches, False otherwise.
    """
    return bcrypt.checkpw(
        digits.encode("utf-8"),
        pin_hash.encode("utf-8"),
    )


def check_usage_limit(user_id: str, supabase: Client) -> bool:
    """Check whether the user has remaining call time for the current month.

    Sums session durations for the current calendar month and compares
    against the subscription hours_limit. Defaults to 1 hour if no
    subscription found.

    Args:
        user_id: The user to check.
        supabase: Supabase client for DB operations.

    Returns:
        True if the user can start a new call, False if limit exceeded.
    """
    # Get the user's plan and derive hours limit
    PLAN_HOURS = {"free": 1, "pro": 10}

    sub_response = (
        supabase.table("subscriptions")
        .select("plan")
        .eq("user_id", user_id)
        .execute()
    )

    plan = "free"
    sub_data = cast(list[dict[str, Any]], sub_response.data or [])
    if sub_data:
        plan = sub_data[0].get("plan", "free")
    hours_limit = PLAN_HOURS.get(plan, 1)

    # Sum session durations for the current calendar month
    now = datetime.now(timezone.utc)
    period_start = datetime(now.year, now.month, 1, tzinfo=timezone.utc).isoformat()

    usage_response = (
        supabase.table("sessions")
        .select("duration_seconds")
        .eq("user_id", user_id)
        .gte("started_at", period_start)
        .not_.is_("duration_seconds", "null")
        .execute()
    )

    rows = cast(list[dict[str, Any]], usage_response.data or [])
    total_seconds = sum(row.get("duration_seconds", 0) for row in rows)
    hours_used = total_seconds / SECONDS_PER_HOUR

    return hours_used < hours_limit


# ============================================================================
# TWIML BUILDERS
# ============================================================================

def build_twiml_gather_pin(user_id: str, attempt: int) -> str:
    """Build TwiML XML that prompts the caller to enter their PIN via DTMF.

    Args:
        user_id: The user ID to pass in the verify-pin callback URL.
        attempt: Current attempt number (for retry tracking).

    Returns:
        TwiML XML string.
    """
    message = "Please enter your pin, then press pound." if attempt == 1 else "Incorrect pin. Please try again."
    action_url = f"/twilio/verify-pin?userId={quote(user_id)}&amp;attempt={attempt}"

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<Response>\n"
        f'  <Gather numDigits="{PIN_NUM_DIGITS}" action="{action_url}" method="POST">\n'
        f"    <Say>{message}</Say>\n"
        "  </Gather>\n"
        "  <Say>No input received. Goodbye.</Say>\n"
        "</Response>"
    )


def build_twiml_connect(stream_url: str, user_id: str) -> str:
    """Build TwiML XML that starts a bidirectional media stream.

    Args:
        stream_url: WebSocket URL for the media stream connection.
        user_id: User ID to pass as a custom parameter.

    Returns:
        TwiML XML string.
    """
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<Response>\n"
        "  <Connect>\n"
        f'    <Stream url="{stream_url}">\n'
        f'      <Parameter name="userId" value="{user_id}" />\n'
        "    </Stream>\n"
        "  </Connect>\n"
        "</Response>"
    )


def build_twiml_reject(message: str) -> str:
    """Build TwiML XML that plays a rejection message and hangs up.

    Args:
        message: The message to speak before hanging up.

    Returns:
        TwiML XML string.
    """
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<Response>\n"
        f"  <Say>{message}</Say>\n"
        "</Response>"
    )
