"""
Tests for fuzzy contact matching in contact_matcher.py.

Pure unit tests -- no IMAP, no DB. Verifies that the ranking algorithm
correctly resolves garbled spoken names, handles missing display names,
and returns empty results for empty input.
"""

from __future__ import annotations

from src.tools.contact_matcher import ContactMatch, rank_contacts


# ============================================================================
# FIXTURES
# ============================================================================

CONTACTS = [
    {"email": "jean-pierre.dubois@company.fr", "display_name": "Jean-Pierre Dubois", "frequency": 45},
    {"email": "john.smith@gmail.com", "display_name": "John Smith", "frequency": 120},
    {"email": "j.smith@othercorp.com", "display_name": "Jonathan Smith", "frequency": 5},
    {"email": "maria.gonzalez@empresa.mx", "display_name": "Maria Gonzalez", "frequency": 30},
    {"email": "mueller.thomas@firma.de", "display_name": "Thomas Mueller", "frequency": 15},
    {"email": "muller.t@gmail.com", "display_name": "Thomas Muller", "frequency": 8},
    {"email": "yuki.tanaka@company.jp", "display_name": "Yuki Tanaka", "frequency": 22},
    {"email": "wei.zhang@tech.cn", "display_name": "Wei Zhang", "frequency": 60},
    {"email": "priya.sharma@startup.in", "display_name": "Priya Sharma", "frequency": 35},
    {"email": "ahmed.hassan@org.eg", "display_name": "Ahmed Hassan", "frequency": 18},
    {"email": "bjork.eriksson@foretag.se", "display_name": "Bjork Eriksson", "frequency": 7},
    {"email": "noname@mystery.com", "display_name": None, "frequency": 3},
    {"email": "s.oreilly@irish.ie", "display_name": "Sean O'Reilly", "frequency": 25},
    {"email": "francois.lefebvre@paris.fr", "display_name": "Francois Lefebvre", "frequency": 11},
    {"email": "dmitri.volkov@mail.ru", "display_name": "Dmitri Volkov", "frequency": 9},
]


# ============================================================================
# TESTS
# ============================================================================

class TestGarbledNameMatching:
    """Given a garbled spoken name, rank_contacts returns the correct contact."""

    def test_garbled_french_name_matches_top(self) -> None:
        """STT-garbled 'john pierre dubwa' should match 'Jean-Pierre Dubois' as
        top result with score above 0.5."""
        results = rank_contacts("john pierre dubwa", CONTACTS)

        assert len(results) > 0
        assert results[0].email == "jean-pierre.dubois@company.fr"
        assert results[0].score > 0.5


class TestPhoneticVsStringSimilarity:
    """Phonetic matching should rank phonetically closer names higher."""

    def test_phonetic_closer_name_ranks_higher(self) -> None:
        """'dimitri volkov' is phonetically close to 'Dmitri Volkov' and should
        rank higher than names that only partially match on string similarity."""
        contacts = [
            {"email": "dmitri.volkov@mail.ru", "display_name": "Dmitri Volkov", "frequency": 10},
            {"email": "dimitris.v@other.com", "display_name": "Dimitris Volk", "frequency": 10},
        ]
        results = rank_contacts("dimitri volkov", contacts)

        assert len(results) >= 2
        # Dmitri Volkov should rank first (exact phonetic match on both tokens)
        assert results[0].email == "dmitri.volkov@mail.ru"
        assert results[0].score > results[1].score


class TestEmptyContacts:
    """Given an empty contacts list, rank_contacts returns an empty list."""

    def test_empty_contacts_returns_empty(self) -> None:
        results = rank_contacts("john smith", [])
        assert results == []

    def test_empty_query_returns_empty(self) -> None:
        results = rank_contacts("", CONTACTS)
        assert results == []


class TestNoneDisplayName:
    """Contacts with display_name=None should match on email local part."""

    def test_match_on_email_local_part(self) -> None:
        """A contact with display_name=None and email 'noname@mystery.com' should
        be matchable by querying 'noname'."""
        contacts = [
            {"email": "noname@mystery.com", "display_name": None, "frequency": 3},
        ]
        results = rank_contacts("noname", contacts)

        assert len(results) > 0
        assert results[0].email == "noname@mystery.com"
        assert results[0].display_name is None
