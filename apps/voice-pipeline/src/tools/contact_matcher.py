"""
Fuzzy contact matching using phonetic and string similarity scoring.

Ranks a list of contacts against a spoken/typed query by combining three
signals: Metaphone phonetic encoding, token-sort string similarity, and
email frequency. Used by the find_contact tool to resolve names to emails.

Responsibilities:
- Phonetic scoring via jellyfish.metaphone()
- String similarity scoring via rapidfuzz.fuzz.token_sort_ratio()
- Frequency-weighted final scoring and filtering
- For contacts without a display_name, falls back to email local part
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import jellyfish
from rapidfuzz.fuzz import token_sort_ratio


# ============================================================================
# CONSTANTS
# ============================================================================

PHONETIC_WEIGHT = 0.4
STRING_WEIGHT = 0.4
FREQUENCY_WEIGHT = 0.2

SCORE_THRESHOLD = 0.3
MAX_RESULTS = 5


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class ContactMatch:
    """A single contact match result with its similarity score.

    Attributes:
        email: the contact's email address
        display_name: the contact's display name (None if not available)
        score: combined similarity score between 0.0 and 1.0
    """
    email: str
    display_name: str | None
    score: float


# ============================================================================
# MAIN FUNCTIONS
# ============================================================================

def rank_contacts(query: str, contacts: list[dict]) -> list[ContactMatch]:
    """Rank contacts by combined phonetic + string similarity + frequency score.

    Final score = 0.4 * phonetic + 0.4 * string + 0.2 * frequency.
    For contacts with display_name=None, the email local part (before @) is
    used as the name for matching.

    Args:
        query: the user's spoken or typed name query
        contacts: list of contact dicts with keys: email, display_name, frequency

    Returns:
        Top 5 matches with score > 0.3, sorted descending by score.
    """
    if not query or not contacts:
        return []

    query_lower = query.lower().strip()
    query_tokens = _tokenize(query_lower)

    # Find max frequency for normalization (avoid division by zero)
    max_freq = max(c["frequency"] for c in contacts)
    if max_freq == 0:
        max_freq = 1

    scored: list[ContactMatch] = []
    for contact in contacts:
        # Use email local part as fallback when display_name is missing
        name = contact["display_name"]
        if name is None:
            name = contact["email"].split("@")[0]

        name_lower = name.lower().strip()
        name_tokens = _tokenize(name_lower)

        phonetic = _phonetic_score(query_tokens, name_tokens)
        string = _string_score(query_lower, name_lower)
        frequency = contact["frequency"] / max_freq

        final = (
            PHONETIC_WEIGHT * phonetic
            + STRING_WEIGHT * string
            + FREQUENCY_WEIGHT * frequency
        )

        scored.append(ContactMatch(
            email=contact["email"],
            display_name=contact["display_name"],
            score=round(final, 4),
        ))

    # Sort descending by score, filter below threshold, limit results
    scored.sort(key=lambda m: m.score, reverse=True)
    return [m for m in scored if m.score > SCORE_THRESHOLD][:MAX_RESULTS]


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _tokenize(text: str) -> list[str]:
    """Split text into tokens on spaces, hyphens, and apostrophes.

    Handles hyphenated names like "Jean-Pierre" -> ["jean", "pierre"]
    and names with apostrophes like "O'Reilly" -> ["o", "reilly"].

    Args:
        text: lowercased input string

    Returns:
        List of non-empty token strings.
    """
    return [t for t in re.split(r"[\s\-']+", text) if t]


def _phonetic_score(query_tokens: list[str], name_tokens: list[str]) -> float:
    """Compare Metaphone encodings of query tokens vs name tokens.

    For each query token, checks if any name token shares the same Metaphone
    code (exact match = 1.0, no match = 0.0). Returns the average across all
    query tokens.

    Args:
        query_tokens: lowercased words from the query
        name_tokens: lowercased words from the contact name

    Returns:
        Score between 0.0 and 1.0.
    """
    if not query_tokens or not name_tokens:
        return 0.0

    name_metaphones = [jellyfish.metaphone(t) for t in name_tokens]

    total = 0.0
    for qt in query_tokens:
        qt_metaphone = jellyfish.metaphone(qt)
        best = 1.0 if qt_metaphone in name_metaphones else 0.0
        total += best

    return total / len(query_tokens)


def _string_score(query: str, name: str) -> float:
    """Compare query and name using rapidfuzz token_sort_ratio.

    Args:
        query: the raw query string (lowercased)
        name: the contact name string (lowercased)

    Returns:
        Score between 0.0 and 1.0.
    """
    return token_sort_ratio(query, name) / 100.0
