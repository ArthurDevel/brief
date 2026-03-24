"""
Gmail-style query string to IMAP search criteria translator.

Converts human-friendly Gmail-style queries (e.g. "from:alice subject:invoice")
into imapclient-compatible search criteria lists.

- Parse Gmail-style operators (from:, to:, subject:, before:, after:, has:, is:)
- Convert bare keywords to OR searches across subject and sender
- AND multiple criteria together (IMAP default behavior)
- Fail fast on unsupported operators
"""

from __future__ import annotations

import datetime
import re


# ============================================================================
# CONSTANTS
# ============================================================================

SUPPORTED_OPERATORS = {"from", "to", "subject", "before", "after", "has", "is"}

DATE_FORMATS = [
    "%Y-%m-%d",   # ISO: 2024-01-01
    "%d/%m/%Y",   # European: 01/01/2024
    "%m/%d/%Y",   # US: 01/01/2024
    "%Y/%m/%d",   # Alternate ISO: 2024/01/01
]


# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

def translate_query(query: str) -> list:
    """Convert a Gmail-style query string to an imapclient search criteria list.

    Supported operators:
        from:value, to:value, subject:value, before:date, after:date,
        has:attachment, is:unread

    Bare keywords (without an operator) search both subject and sender via OR.
    Multiple terms are ANDed together (IMAP default).

    Args:
        query: Gmail-style search query string.

    Returns:
        List of IMAP search criteria compatible with imapclient.search().

    Raises:
        ValueError: If the query is empty or contains unsupported operators.
    """
    query = query.strip()
    if not query:
        raise ValueError("Search query must not be empty")

    tokens = _tokenize(query)
    criteria: list = []

    for token in tokens:
        criteria.extend(_translate_token(token))

    return criteria


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _tokenize(query: str) -> list[str]:
    """Split a query string into tokens, preserving operator:value pairs.

    Handles quoted values like subject:"hello world".

    Args:
        query: Raw query string.

    Returns:
        List of token strings (e.g. ["from:alice", "subject:invoice"]).
    """
    # Match operator:value pairs (with optional quotes) or bare words
    pattern = r'(\w+:"[^"]*"|\w+:\S+|\S+)'
    return re.findall(pattern, query)


def _translate_token(token: str) -> list:
    """Translate a single token into IMAP search criteria.

    Args:
        token: A single token like "from:alice" or "invoice".

    Returns:
        List of IMAP criteria elements for this token.

    Raises:
        ValueError: If the operator is not supported.
    """
    # Check if token contains an operator
    match = re.match(r'^(\w+):(.+)$', token)
    if not match:
        # Bare keyword -- search subject and sender
        return ["OR", "SUBJECT", token, "FROM", token]

    operator = match.group(1).lower()
    value = match.group(2).strip('"')

    if operator not in SUPPORTED_OPERATORS:
        raise ValueError(f"Unsupported search operator: '{operator}'")

    if operator == "from":
        return ["FROM", value]

    if operator == "to":
        return ["TO", value]

    if operator == "subject":
        return ["SUBJECT", value]

    if operator == "before":
        return ["BEFORE", _parse_date(value)]

    if operator == "after":
        return ["SINCE", _parse_date(value)]

    if operator == "has":
        if value.lower() == "attachment":
            # IMAP doesn't have a direct "has attachment" flag.
            # Search for Content-Type headers containing "multipart/mixed",
            # which indicates attachments are present.
            return ["HEADER", "Content-Type", "multipart/mixed"]
        raise ValueError(f"Unsupported 'has' value: '{value}'. Only 'attachment' is supported.")

    if operator == "is":
        if value.lower() == "unread":
            return ["UNSEEN"]
        raise ValueError(f"Unsupported 'is' value: '{value}'. Only 'unread' is supported.")

    # Should not reach here due to SUPPORTED_OPERATORS check above
    raise ValueError(f"Unsupported search operator: '{operator}'")


def _parse_date(date_str: str) -> datetime.date:
    """Parse a date string into a datetime.date object.

    Tries several common date formats in order.

    Args:
        date_str: Date string to parse (e.g. "2024-01-01").

    Returns:
        Parsed datetime.date object.

    Raises:
        ValueError: If the date string does not match any supported format.
    """
    for fmt in DATE_FORMATS:
        try:
            return datetime.datetime.strptime(date_str, fmt).date()
        except ValueError:
            continue

    raise ValueError(
        f"Cannot parse date '{date_str}'. "
        f"Supported formats: YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, YYYY/MM/DD"
    )
