"""
Markdown formatting functions for email tool results.

Converts structured email data into compact markdown strings for LLM consumption.

- Formats inbox/search listings as bullet lists with snippets
- Formats full emails with inline bold metadata and body
- Formats thread conversations with --- separators between messages
"""

from __future__ import annotations

from src.tools.email_client import Email, EmailSummary, ThreadMessage


# ============================================================================
# MAIN HANDLERS
# ============================================================================

def format_email_summaries(emails: list[EmailSummary], title: str) -> str:
    """Format a list of email summaries as a markdown bullet list with snippets.

    Used by list_inbox and search_emails.

    Args:
        emails: List of email summaries to format.
        title: Header title (e.g. "Inbox" or "Search Results").

    Returns:
        Markdown string with header and bullet list.
    """
    lines: list[str] = []

    lines.append(f"## {title} ({len(emails)} emails)")
    lines.append("")

    for email in emails:
        lines.append(f"- **[id:{email.id}]** From: {email.from_addr} | {email.date}")
        lines.append(f"  **{email.subject}**")
        lines.append(f"  > {email.snippet}")
        lines.append("")

    return "\n".join(lines)


def format_email(email: Email) -> str:
    """Format a single full email as markdown with inline metadata and body.

    Args:
        email: Full email content to format.

    Returns:
        Markdown string with subject as h1, metadata lines, hr, then body.
    """
    status = "Read" if email.is_read else "Unread"

    lines: list[str] = []
    lines.append(f"# {email.subject}")
    lines.append("")
    lines.append(f"**ID:** {email.id}")
    lines.append(f"**From:** {email.from_addr}")
    lines.append(f"**To:** {email.to}")
    lines.append(f"**Date:** {email.date}")
    lines.append(f"**Status:** {status}")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(email.body)

    return "\n".join(lines)


def format_thread(messages: list[ThreadMessage]) -> str:
    """Format a thread as markdown with --- separators between messages.

    Args:
        messages: List of thread messages in chronological order.

    Returns:
        Markdown string with thread header, then messages separated by ---.
    """
    if not messages:
        return "# Thread (0 messages)"

    subject = messages[0].subject

    lines: list[str] = []
    lines.append(f"# Thread: {subject} ({len(messages)} messages)")
    lines.append("")

    for msg in messages:
        lines.append("---")
        lines.append("")
        lines.append(f"**From:** {msg.from_addr}")
        lines.append(f"**To:** {msg.to}")
        lines.append(f"**Date:** {msg.date} | **ID:** {msg.id}")
        lines.append("")
        lines.append(msg.body)
        lines.append("")

    lines.append("---")

    return "\n".join(lines)
