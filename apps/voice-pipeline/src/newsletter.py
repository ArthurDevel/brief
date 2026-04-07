"""
Newsletter summary background job (provider-aware).

Fetches newsletters via IMAP or Unipile for each opted-in user, generates
an LLM summary using OpenRouter, and stores it in the database.

Responsibilities:
- Query opted-in users with valid newsletter config from user_settings
- Resolve mailbox access from user_email_accounts (custom or Unipile)
- Fetch newsletter emails by sender + date using the active provider
- Generate LLM-powered summaries with Langfuse tracing
- Upsert daily summaries into the newsletter_summaries table
- Orchestrate the full daily job with per-user error isolation
"""

from __future__ import annotations

import asyncio
import email
import email.policy
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, cast

import aiohttp
from imapclient import IMAPClient
from markdownify import markdownify

from src.config import NEWSLETTER_LLM_MODEL
from langfuse import propagate_attributes
from src.langfuse_client import get_langfuse_client
from src.session import EmailAccount, ImapConfig, build_email_account, _timezone_from_country_code
from src.tools.email_client import (
    close_imap_connection,
    create_imap_connection,
    with_reconnect,
)

from supabase import Client
from zoneinfo import ZoneInfo


logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

NO_NEWSLETTERS_MESSAGE = "No newsletters were received yesterday from your configured senders."

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"

SUMMARY_SYSTEM_PROMPT = """\
You are a newsletter summarizer. You receive the full text of one or more newsletter emails and produce a concise, informative summary suitable for being read aloud.

Rules:
- Combine all newsletters into a single cohesive summary
- Lead with the most important or interesting items
- Use short, clear sentences optimized for spoken delivery
- Skip ads, promotions, unsubscribe links, and boilerplate footers
- Do not mention that you are summarizing or that these are newsletters
- Keep the total length under 2 minutes when read aloud (roughly 300 words)
"""


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class NewsletterConfig:
    """User's newsletter preferences from user_settings.newsletter_config."""

    enabled: bool
    newsletters: list[str]
    summary_prompt: str | None


@dataclass
class NewsletterEmail:
    """A single fetched newsletter email."""

    subject: str
    body: str
    from_addr: str
    date: str
    message_id: str


@dataclass
class OptedInUser:
    """A user who has opted in to newsletter summaries with a valid email account."""

    user_id: str
    email_account: EmailAccount
    newsletter_config: NewsletterConfig
    timezone: str


# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

async def run_daily_newsletter_job(supabase: Client, api_key: str) -> int:
    """Top-level entry point for the daily newsletter background job.

    Gets opted-in users, generates a daily summary for each, and returns the
    count of summaries generated. Each user is processed independently so one
    failure does not block others.

    Args:
        supabase: Supabase client with service role permissions.
        api_key: OpenRouter API key for LLM calls.

    Returns:
        Number of summaries successfully generated.
    """
    users = get_opted_in_users(supabase)
    if not users:
        logger.info("[newsletter] No opted-in users found, skipping")
        return 0

    logger.info("[newsletter] Processing %d opted-in user(s)", len(users))
    generated = 0
    skipped = 0

    for user in users:
        try:
            # Determine "yesterday" in the user's local timezone
            tz = ZoneInfo(user.timezone)
            now_local = datetime.now(tz)
            target_date = (now_local - timedelta(days=1)).date()

            result = await generate_daily_summary_for_user(user, target_date, api_key, supabase)
            if result is None:
                skipped += 1
            else:
                generated += 1
        except Exception as exc:
            logger.error(
                "[newsletter] Failed to generate summary for user %s: %s",
                user.user_id, exc,
            )

    logger.info("[newsletter] Generated %d, skipped %d", generated, skipped)
    return generated


def generate_on_demand_for_user(
    supabase: Client,
    user_id: str,
    target_date: date,
    api_key: str,
) -> None:
    """Generate a newsletter summary on-demand for a single user (sync, blocking).

    Queries user_settings for the user's newsletter config and resolves
    mailbox access from user_email_accounts. Runs the full summary generation
    pipeline. The async LLM call is handled internally via asyncio.run().

    Designed to be called from asyncio.to_thread() so it does not block the
    event loop.

    Args:
        supabase: Supabase client with service role permissions.
        user_id: The user to generate a summary for.
        target_date: The calendar date to summarize.
        api_key: OpenRouter API key for LLM calls.
    """
    try:
        user = _build_opted_in_user(supabase, user_id)
        if user is None:
            logger.warning(
                "[newsletter] On-demand generation skipped for user %s: missing config or credentials",
                user_id,
            )
            return

        import asyncio as _asyncio
        _asyncio.run(generate_daily_summary_for_user(user, target_date, api_key, supabase))
        logger.info(
            "[newsletter] On-demand summary generated for user %s, date %s",
            user_id, target_date.isoformat(),
        )
    except Exception as exc:
        logger.error(
            "[newsletter] On-demand generation failed for user %s: %s",
            user_id, exc,
        )


# ============================================================================
# MAIN LOGIC
# ============================================================================

def get_opted_in_users(supabase: Client) -> list[OptedInUser]:
    """Query users who have newsletter_config.enabled = true and a valid email account.

    Newsletter opt-in state comes from user_settings. Mailbox access is resolved
    from user_email_accounts. For custom accounts, Vault secrets are retrieved
    for IMAP config. For Unipile accounts, only the account_id is needed.

    Resolves each user's timezone using the same chain as session.py:
    1. call_schedule.timezone (explicit IANA timezone)
    2. _timezone_from_country_code(phone.countryCode) (fallback)
    3. "UTC" (last resort)

    Args:
        supabase: Supabase client with service role permissions.

    Returns:
        List of OptedInUser objects with resolved email accounts and timezones.
    """
    # Step 1: Get all users with newsletter_config from user_settings
    response = (
        supabase.table("user_settings")
        .select("user_id, newsletter_config, call_schedule, phone")
        .not_.is_("newsletter_config", "null")
        .execute()
    )

    rows = cast(list[dict[str, Any]], response.data or [])
    users: list[OptedInUser] = []

    for row in rows:
        newsletter_config_raw = row.get("newsletter_config")
        if not newsletter_config_raw or not newsletter_config_raw.get("enabled"):
            continue

        user_id = row["user_id"]

        # Step 2: Resolve email account from user_email_accounts
        email_account = _load_active_email_account(supabase, user_id)
        if email_account is None:
            logger.warning(
                "[newsletter] User %s has newsletter enabled but no active email account, skipping",
                user_id,
            )
            continue

        newsletter_config = NewsletterConfig(
            enabled=True,
            newsletters=newsletter_config_raw.get("newsletters", []),
            summary_prompt=newsletter_config_raw.get("summary_prompt"),
        )

        # Resolve timezone: call_schedule.timezone > phone.countryCode > "UTC"
        call_schedule = row.get("call_schedule")
        user_timezone: str | None = call_schedule.get("timezone") if call_schedule else None
        if user_timezone is None:
            phone = row.get("phone")
            if phone and phone.get("countryCode"):
                user_timezone = _timezone_from_country_code(phone["countryCode"])
        if user_timezone is None:
            user_timezone = "UTC"

        users.append(OptedInUser(
            user_id=user_id,
            email_account=email_account,
            newsletter_config=newsletter_config,
            timezone=user_timezone,
        ))

    return users


def _build_opted_in_user(supabase: Client, user_id: str) -> OptedInUser | None:
    """Build an OptedInUser for a single user.

    Reads newsletter config from user_settings and resolves mailbox access
    from user_email_accounts. Returns None if the user has no valid newsletter
    config or no active email account.

    Args:
        supabase: Supabase client with service role permissions.
        user_id: The user ID to look up.

    Returns:
        An OptedInUser instance, or None if config/account are missing.
    """
    response = (
        supabase.table("user_settings")
        .select("user_id, newsletter_config, call_schedule, phone")
        .eq("user_id", user_id)
        .single()
        .execute()
    )

    row = cast(dict[str, Any] | None, response.data)
    if row is None:
        return None

    newsletter_config_raw = row.get("newsletter_config")
    if not newsletter_config_raw or not newsletter_config_raw.get("enabled"):
        return None

    # Resolve email account from user_email_accounts
    email_account = _load_active_email_account(supabase, user_id)
    if email_account is None:
        return None

    newsletter_config = NewsletterConfig(
        enabled=True,
        newsletters=newsletter_config_raw.get("newsletters", []),
        summary_prompt=newsletter_config_raw.get("summary_prompt"),
    )

    # Resolve timezone: call_schedule.timezone > phone.countryCode > "UTC"
    call_schedule = row.get("call_schedule")
    user_timezone: str | None = call_schedule.get("timezone") if call_schedule else None
    if user_timezone is None:
        phone = row.get("phone")
        if phone and phone.get("countryCode"):
            user_timezone = _timezone_from_country_code(phone["countryCode"])
    if user_timezone is None:
        user_timezone = "UTC"

    return OptedInUser(
        user_id=user_id,
        email_account=email_account,
        newsletter_config=newsletter_config,
        timezone=user_timezone,
    )


def fetch_newsletters_for_date(
    account: EmailAccount,
    senders: list[str],
    target_date: date,
    user_timezone: str,
) -> list[NewsletterEmail]:
    """Fetch newsletter emails from specific senders for a given date.

    Dispatches to IMAP or Unipile based on the account's connection_type.

    Args:
        account: The user's active email account.
        senders: List of sender email addresses to search for.
        target_date: The calendar date to fetch newsletters for.
        user_timezone: IANA timezone string for date comparison.

    Returns:
        List of NewsletterEmail objects found for the target date.
    """
    if not senders:
        return []

    if account.connection_type == "unipile":
        return _fetch_newsletters_via_unipile(account, senders, target_date, user_timezone)
    else:
        return _fetch_newsletters_via_imap(account, senders, target_date, user_timezone)


async def generate_summary(
    email_bodies: list[str],
    summary_prompt: str | None,
    api_key: str,
    user_id: str,
) -> str:
    """Generate an LLM summary of newsletter email bodies via OpenRouter.

    Logs the generation to Langfuse for observability.

    Args:
        email_bodies: List of email body strings to summarize.
        summary_prompt: Optional custom instructions from the user (appended to system prompt).
        api_key: OpenRouter API key.
        user_id: User ID for Langfuse tracing.

    Returns:
        The generated summary text.

    Raises:
        RuntimeError: If the LLM call fails.
    """
    # Build the system prompt, optionally with user's custom instructions
    system_content = SUMMARY_SYSTEM_PROMPT
    if summary_prompt:
        system_content += f"\n\nAdditional instructions from the user:\n{summary_prompt}"

    # Combine all email bodies into a single user message
    combined = "\n\n---\n\n".join(email_bodies)

    messages = [
        {"role": "system", "content": system_content},
        {"role": "user", "content": combined},
    ]

    # Call OpenRouter
    async with aiohttp.ClientSession() as session:
        async with session.post(
            OPENROUTER_CHAT_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": NEWSLETTER_LLM_MODEL,
                "messages": messages,
            },
        ) as resp:
            if resp.status != 200:
                body = await resp.text()
                raise RuntimeError(f"OpenRouter API error {resp.status}: {body}")

            data = await resp.json()

    # Extract the summary text
    choices = data.get("choices", [])
    if not choices:
        raise RuntimeError("OpenRouter returned no choices")

    summary_text = choices[0]["message"]["content"]

    # Extract token usage for Langfuse
    usage = data.get("usage", {})
    input_tokens = usage.get("prompt_tokens", 0)
    output_tokens = usage.get("completion_tokens", 0)

    # Log to Langfuse
    _log_to_langfuse(user_id, messages, summary_text, input_tokens, output_tokens)

    return summary_text


async def generate_daily_summary_for_user(
    user: OptedInUser,
    target_date: date,
    api_key: str,
    supabase: Client,
) -> str | None:
    """Orchestrate the full newsletter summary flow for one user.

    Fetches newsletters for the target date, generates an LLM summary if any
    are found, or uses a fixed "no newsletters" message if none found.
    Always upserts a row into newsletter_summaries.

    Args:
        user: The opted-in user to generate a summary for.
        target_date: The calendar date to summarize.
        api_key: OpenRouter API key for LLM calls.
        supabase: Supabase client for DB operations.

    Returns:
        The summary string, or None if a summary already existed (skipped).
    """
    # Skip if a summary already exists for this user + date
    existing = (
        supabase.table("newsletter_summaries")
        .select("id")
        .eq("user_id", user.user_id)
        .eq("summary_date", target_date.isoformat())
        .execute()
    )
    if existing.data:
        logger.info(
            "[newsletter] Summary already exists for user %s, date %s, skipping",
            user.user_id, target_date.isoformat(),
        )
        return None

    newsletters = fetch_newsletters_for_date(
        user.email_account,
        user.newsletter_config.newsletters,
        target_date,
        user.timezone,
    )

    if not newsletters:
        summary = NO_NEWSLETTERS_MESSAGE
        email_count = 0
    else:
        email_bodies = [
            f"Subject: {nl.subject}\nFrom: {nl.from_addr}\n\n{nl.body}"
            for nl in newsletters
        ]
        summary = await generate_summary(
            email_bodies,
            user.newsletter_config.summary_prompt,
            api_key,
            user.user_id,
        )
        email_count = len(newsletters)

        # Append source references so the LLM can find original emails
        source_lines = [f"- {nl.subject} (from: {nl.from_addr}, id: {nl.message_id})" for nl in newsletters]
        summary += "\n\n---\nSources:\n" + "\n".join(source_lines)

    # Upsert into newsletter_summaries (idempotent via unique constraint)
    supabase.table("newsletter_summaries").upsert(
        {
            "user_id": user.user_id,
            "summary_date": target_date.isoformat(),
            "summary": summary,
            "email_count": email_count,
            "listened": False,
            "listened_at": None,
        },
        on_conflict="user_id,summary_date",
    ).execute()

    logger.info(
        "[newsletter] Stored summary for user %s, date %s, %d email(s)",
        user.user_id, target_date.isoformat(), email_count,
    )

    return summary


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _load_active_email_account(supabase: Client, user_id: str) -> EmailAccount | None:
    """Load the active email account for a user from user_email_accounts.

    For custom accounts, resolves IMAP/SMTP passwords from Vault.
    For Unipile accounts, only the account_id is needed.

    Args:
        supabase: Supabase client with service role permissions.
        user_id: The user ID to look up.

    Returns:
        EmailAccount if found and valid, None otherwise.
    """
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
        return None

    try:
        return build_email_account(account_rows[0], supabase)
    except Exception as exc:
        logger.error(
            "[newsletter] Failed to build email account for user %s: %s",
            user_id, exc,
        )
        return None


def _fetch_newsletters_via_imap(
    account: EmailAccount,
    senders: list[str],
    target_date: date,
    user_timezone: str,
) -> list[NewsletterEmail]:
    """Fetch newsletter emails via IMAP for a custom account.

    Uses the overfetch + client-side filter strategy:
    1. IMAP SEARCH with a 3-day window (target_date-1 to target_date+2) per sender
    2. FETCH INTERNALDATE for each match
    3. Client-side filter: keep only emails whose INTERNALDATE falls on target_date
       in the user's timezone

    Results from multiple senders are merged and deduplicated by UID.

    Args:
        account: Custom email account (must have imap_config).
        senders: List of sender email addresses to search for.
        target_date: The calendar date to fetch newsletters for.
        user_timezone: IANA timezone string for date comparison.

    Returns:
        List of NewsletterEmail objects found for the target date.

    Raises:
        RuntimeError: If the account has no IMAP config.
    """
    if not account.imap_config:
        raise RuntimeError("Custom account has no IMAP config for newsletter fetch")

    imap_config = account.imap_config

    imap_holder: dict[str, Any] = {
        "client": create_imap_connection(imap_config),
        "config": imap_config,
    }

    try:
        # Build the 3-day search window for IMAP
        since_date = target_date - timedelta(days=1)
        before_date = target_date + timedelta(days=2)

        seen_uids: set[int] = set()
        emails: list[NewsletterEmail] = []
        tz = ZoneInfo(user_timezone)

        for sender in senders:
            try:
                fetched = _fetch_sender_emails(
                    imap_holder, imap_config, sender, since_date, before_date, target_date, tz
                )
                for uid, newsletter_email in fetched:
                    if uid not in seen_uids:
                        seen_uids.add(uid)
                        emails.append(newsletter_email)
            except Exception as exc:
                logger.error(
                    "[newsletter] Failed to fetch emails from sender '%s': %s",
                    sender, exc,
                )

        return emails

    finally:
        try:
            close_imap_connection(imap_holder["client"])
        except Exception:
            pass


def _fetch_newsletters_via_unipile(
    account: EmailAccount,
    senders: list[str],
    target_date: date,
    user_timezone: str,
) -> list[NewsletterEmail]:
    """Fetch newsletter emails via Unipile API.

    Searches for emails from each sender using the Unipile search API,
    then filters client-side by date in the user's timezone.

    Args:
        account: Unipile email account (must have unipile_account_id).
        senders: List of sender email addresses to search for.
        target_date: The calendar date to fetch newsletters for.
        user_timezone: IANA timezone string for date comparison.

    Returns:
        List of NewsletterEmail objects found for the target date.

    Raises:
        RuntimeError: If the account has no unipile_account_id.
    """
    if not account.unipile_account_id:
        raise RuntimeError("Unipile account has no unipile_account_id for newsletter fetch")

    return asyncio.run(_fetch_newsletters_via_unipile_async(
        account.unipile_account_id, senders, target_date, user_timezone
    ))


async def _fetch_newsletters_via_unipile_async(
    account_id: str,
    senders: list[str],
    target_date: date,
    user_timezone: str,
) -> list[NewsletterEmail]:
    """Async implementation of Unipile newsletter fetching.

    Searches for emails from each sender, filters by date, and extracts content.

    Args:
        account_id: The Unipile account ID.
        senders: List of sender email addresses to search for.
        target_date: The calendar date to fetch newsletters for.
        user_timezone: IANA timezone string for date comparison.

    Returns:
        List of NewsletterEmail objects found for the target date.
    """
    from src.tools.unipile_client import _request

    tz = ZoneInfo(user_timezone)
    seen_ids: set[str] = set()
    emails: list[NewsletterEmail] = []

    for sender in senders:
        try:
            # Search for emails from this sender
            params: dict[str, Any] = {
                "account_id": account_id,
                "q": f"from:{sender}",
                "limit": 20,
            }
            data = await _request("GET", "/api/v1/emails", params=params)
            items = data.get("items", [])

            for item in items:
                email_id = str(item.get("provider_id", item.get("id", "")))
                if email_id in seen_ids:
                    continue

                # Client-side date filter
                date_str = item.get("date", "")
                if date_str:
                    try:
                        item_dt = datetime.fromisoformat(date_str)
                        if item_dt.tzinfo is None:
                            item_dt = item_dt.replace(tzinfo=timezone.utc)
                        local_date = item_dt.astimezone(tz).date()
                        if local_date != target_date:
                            continue
                    except ValueError:
                        continue
                else:
                    continue

                seen_ids.add(email_id)

                # Extract email content -- fetch full email for body
                full_email = await _request("GET", f"/api/v1/emails/{email_id}", params={"account_id": account_id})

                from_obj = full_email.get("from", {})
                from_addr = sender
                if isinstance(from_obj, dict):
                    identifier = from_obj.get("identifier", "")
                    display_name = from_obj.get("display_name", "")
                    if display_name and identifier:
                        from_addr = f"{display_name} <{identifier}>"
                    elif identifier:
                        from_addr = identifier

                body = str(full_email.get("body", full_email.get("text_body", "")))
                subject = str(full_email.get("subject", ""))
                message_id = str(full_email.get("message_id", email_id))

                emails.append(NewsletterEmail(
                    subject=subject,
                    body=body,
                    from_addr=from_addr,
                    date=date_str,
                    message_id=message_id,
                ))

        except Exception as exc:
            logger.error(
                "[newsletter] Failed to fetch Unipile emails from sender '%s': %s",
                sender, exc,
            )

    return emails


def _fetch_sender_emails(
    imap_holder: dict[str, Any],
    imap_config: ImapConfig,
    sender: str,
    since_date: date,
    before_date: date,
    target_date: date,
    tz: ZoneInfo,
) -> list[tuple[int, NewsletterEmail]]:
    """Fetch and filter emails from a single sender within the search window.

    Searches IMAP with a 3-day window, fetches INTERNALDATE + RFC822 for matches,
    and filters client-side to keep only emails on the target_date in the user's timezone.

    Args:
        imap_holder: Mutable dict with "client" and "config" keys for with_reconnect.
        imap_config: IMAP connection parameters for reconnection.
        sender: Sender email address to search for.
        since_date: Start of the IMAP search window (inclusive).
        before_date: End of the IMAP search window (exclusive).
        target_date: The actual date to match after client-side filtering.
        tz: User's timezone for date comparison.

    Returns:
        List of (uid, NewsletterEmail) tuples for emails matching the target date.
    """
    def _search_and_fetch(client: IMAPClient) -> list[tuple[int, NewsletterEmail]]:
        client.select_folder("INBOX", readonly=True)

        # IMAP SEARCH with overfetch window
        criteria = [
            "FROM", sender,
            "SINCE", since_date,
            "BEFORE", before_date,
        ]
        uids = client.search(criteria)  # type: ignore[arg-type]
        if not uids:
            return []

        # Fetch INTERNALDATE and RFC822 for filtering and body extraction
        fetch_data = client.fetch(uids, ["INTERNALDATE", "RFC822", "ENVELOPE"])

        results: list[tuple[int, NewsletterEmail]] = []
        for uid in uids:
            data = fetch_data.get(uid)
            if not data:
                continue

            # Client-side date filter using INTERNALDATE
            internal_date: datetime | None = data.get(b"INTERNALDATE")  # type: ignore[assignment]
            if internal_date is None:
                continue

            # Convert INTERNALDATE to user's timezone and check date match
            if internal_date.tzinfo is None:
                internal_date = internal_date.replace(tzinfo=timezone.utc)
            local_date = internal_date.astimezone(tz).date()

            if local_date != target_date:
                continue

            # Extract email content
            envelope: Any = data.get(b"ENVELOPE")
            raw_source: bytes = data.get(b"RFC822", b"")  # type: ignore[assignment]
            body = _extract_newsletter_body(raw_source)

            subject = ""
            from_addr = sender
            email_date = internal_date.isoformat()

            if envelope:
                subject = _decode_envelope_subject(envelope.subject)
                if envelope.from_:
                    addr = envelope.from_[0]
                    mailbox = _decode_bytes_safe(addr.mailbox) if addr.mailbox else ""
                    host = _decode_bytes_safe(addr.host) if addr.host else ""
                    from_addr = f"{mailbox}@{host}" if mailbox and host else sender
                if envelope.date:
                    email_date = envelope.date.isoformat()

            # Extract Message-ID from envelope (globally unique, survives folder moves)
            message_id = ""
            if envelope and envelope.message_id:
                message_id = _decode_bytes_safe(envelope.message_id)

            results.append((uid, NewsletterEmail(
                subject=subject,
                body=body,
                from_addr=from_addr,
                date=email_date,
                message_id=message_id,
            )))

        return results

    return with_reconnect(imap_holder, imap_config, _search_and_fetch)


def _extract_newsletter_body(raw_source: bytes) -> str:
    """Extract the plain-text body from a raw RFC822 email source.

    Prefers plain text; falls back to HTML-to-markdown via markdownify.
    Same approach as email_client._extract_body but defined here to avoid
    coupling to a private function.

    Args:
        raw_source: Raw email source bytes.

    Returns:
        Cleaned plain text body content.
    """
    if not raw_source:
        return ""

    msg = email.message_from_bytes(raw_source, policy=email.policy.default)

    body = ""

    # Try plain text first
    plain_part = msg.get_body(preferencelist=("plain",))
    if plain_part:
        content = plain_part.get_content()
        if isinstance(content, str) and content.strip():
            body = content.strip()

    # Fall back to HTML converted to markdown
    if not body:
        html_part = msg.get_body(preferencelist=("html",))
        if html_part:
            html_content = html_part.get_content()
            if isinstance(html_content, str) and html_content.strip():
                body = markdownify(html_content, strip=["img"]).strip()

    # Normalize line endings and strip zero-width characters
    body = body.replace("\r\n", "\n").replace("\r", "\n")
    import re
    body = re.sub(r"[\u200b\u200c\u200d\ufeff\u00ad]", "", body)
    body = re.sub(r"  +", " ", body)

    return body.strip()


def _decode_envelope_subject(value: bytes | str | None) -> str:
    """Decode an email envelope subject, handling RFC 2047 encoding.

    Args:
        value: Raw subject bytes, string, or None.

    Returns:
        Decoded subject string.
    """
    if value is None:
        return "(no subject)"

    raw = _decode_bytes_safe(value) if isinstance(value, bytes) else value
    if not raw:
        return "(no subject)"

    # Handle RFC 2047 encoded words
    from email.header import decode_header
    parts = decode_header(raw)
    decoded_parts: list[str] = []
    for part, charset in parts:
        if isinstance(part, bytes):
            decoded_parts.append(part.decode(charset or "utf-8", errors="replace"))
        else:
            decoded_parts.append(part)

    return " ".join(decoded_parts)


def _decode_bytes_safe(value: bytes | str) -> str:
    """Decode bytes to string, handling encoding errors gracefully.

    Args:
        value: Bytes or string to decode.

    Returns:
        Decoded string.
    """
    if isinstance(value, str):
        return value
    return value.decode("utf-8", errors="replace")


def _log_to_langfuse(
    user_id: str,
    messages: list[dict[str, str]],
    output: str,
    input_tokens: int,
    output_tokens: int,
) -> None:
    """Log a newsletter summary LLM generation to Langfuse.

    Creates a trace with a generation span for observability.

    Args:
        user_id: User ID for the trace.
        messages: Input messages sent to the LLM.
        output: Generated summary text.
        input_tokens: Number of input tokens consumed.
        output_tokens: Number of output tokens generated.
    """
    try:
        langfuse = get_langfuse_client()

        with propagate_attributes(
            trace_name="newsletter-summary",
            user_id=user_id,
        ):
            span = langfuse.start_observation(
                name="newsletter-summary",
                input={"model": NEWSLETTER_LLM_MODEL},
            )

            generation = span.start_observation(
                as_type="generation",
                name="summarize",
                model=NEWSLETTER_LLM_MODEL,
                input=messages,
                output=output,
                usage_details={"input": input_tokens, "output": output_tokens},
            )
            generation.end()

            span.end()
    except Exception as exc:
        logger.warning("[newsletter] Failed to log to Langfuse: %s", exc)
