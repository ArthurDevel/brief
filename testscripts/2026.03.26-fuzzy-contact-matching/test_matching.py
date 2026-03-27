"""
Fuzzy Contact Matching -- Prototype Test Script

Standalone script to evaluate a fuzzy contact matching algorithm before
integrating it into the main application. Simulates how STT (speech-to-text)
garbled names are matched against a contact list extracted from IMAP headers.

Responsibilities:
- Implements phonetic scoring (Metaphone) and string similarity scoring (token_sort_ratio)
- Combines scores with a frequency weight to rank contacts
- Runs a battery of test queries against a realistic contact list
- Outputs pass/fail results to stdout and to output/results.txt
"""

import os
import sys

# -- Dependency check --
try:
    from rapidfuzz.fuzz import token_sort_ratio
except ImportError:
    print("ERROR: 'rapidfuzz' is not installed. Run: pip install rapidfuzz")
    sys.exit(1)

try:
    import jellyfish
except ImportError:
    print("ERROR: 'jellyfish' is not installed. Run: pip install jellyfish")
    sys.exit(1)


# ============================================================================
# CONSTANTS
# ============================================================================

PHONETIC_WEIGHT = 0.4
STRING_WEIGHT = 0.4
FREQUENCY_WEIGHT = 0.2

MIN_SCORE_THRESHOLD = 0.3
MAX_RESULTS = 5

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

TEST_QUERIES = [
    # (query_as_spoken_by_user, expected_top_email, description)
    ("john pierre dubwa", "jean-pierre.dubois@company.fr", "French name garbled by STT"),
    ("john smith", "john.smith@gmail.com", "Common English name, exact match"),
    ("jonatan smith", "j.smith@othercorp.com", "Misspelled Jonathan"),
    ("maria gonzales", "maria.gonzalez@empresa.mx", "Spanish name, slight misspelling"),
    ("thomas muller", "mueller.thomas@firma.de", "German name, should match Mueller or Muller"),
    ("you key tanaka", "yuki.tanaka@company.jp", "Japanese name phonetically garbled"),
    ("way chang", "wei.zhang@tech.cn", "Chinese name phonetically garbled"),
    ("preya sharma", "priya.sharma@startup.in", "Indian name, vowel shift"),
    ("ahmed hasan", "ahmed.hassan@org.eg", "Arabic name, common misspelling"),
    ("sean o'reilly", "s.oreilly@irish.ie", "Irish name with apostrophe"),
    ("sean oreilly", "s.oreilly@irish.ie", "Irish name without apostrophe"),
    ("frank lefev", "francois.lefebvre@paris.fr", "French name heavily garbled"),
    ("dimitri volkov", "dmitri.volkov@mail.ru", "Russian name, common variant"),
    ("noname", "noname@mystery.com", "Match on email local part when no display_name"),
    ("bjork", "bjork.eriksson@foretag.se", "Partial name (first name only)"),
    ("smith", "john.smith@gmail.com", "Last name only, should prefer higher frequency"),
]


# ============================================================================
# MATCHING FUNCTIONS
# ============================================================================

def _phonetic_score(query_tokens: list[str], name_tokens: list[str]) -> float:
    """
    Compare Metaphone encodings of query tokens vs name tokens.

    For each query token, find the best matching name token by exact
    Metaphone match (1.0 if match, 0.0 if not). Returns the average
    score across all query tokens.

    Args:
        query_tokens: tokenized query string (lowercased words)
        name_tokens: tokenized contact name (lowercased words)

    Returns:
        Score between 0.0 and 1.0
    """
    if not query_tokens or not name_tokens:
        return 0.0

    # Get metaphone encodings for name tokens (primary code only)
    name_metaphones = [jellyfish.metaphone(t) for t in name_tokens]

    total = 0.0
    for qt in query_tokens:
        qt_metaphone = jellyfish.metaphone(qt)
        # Check if any name token has the same metaphone encoding
        best = 1.0 if qt_metaphone in name_metaphones else 0.0
        total += best

    return total / len(query_tokens)


def _string_score(query: str, name: str) -> float:
    """
    Compare query and name using rapidfuzz token_sort_ratio.

    Args:
        query: the raw query string
        name: the contact name string

    Returns:
        Score between 0.0 and 1.0
    """
    return token_sort_ratio(query, name) / 100.0


def rank_contacts(query: str, contacts: list[dict]) -> list[dict]:
    """
    Rank contacts by a combined score of phonetic, string, and frequency similarity.

    final_score = 0.4 * phonetic + 0.4 * string + 0.2 * frequency

    For contacts with display_name=None, the email local part (before @) is used
    as the name.

    Args:
        query: the user's spoken/typed query
        contacts: list of contact dicts with keys: email, display_name, frequency

    Returns:
        Top 5 matches with score > 0.3, sorted descending by score.
        Each result: {"email": str, "display_name": str|None, "score": float}
    """
    if not query or not contacts:
        return []

    # Normalize query
    query_lower = query.lower().strip()
    query_tokens = query_lower.split()

    # Find max frequency for normalization
    max_freq = max(c["frequency"] for c in contacts)
    if max_freq == 0:
        max_freq = 1

    scored = []
    for contact in contacts:
        # Use email local part as fallback name
        name = contact["display_name"]
        if name is None:
            name = contact["email"].split("@")[0]

        name_lower = name.lower().strip()
        name_tokens = name_lower.split()

        phonetic = _phonetic_score(query_tokens, name_tokens)
        string = _string_score(query_lower, name_lower)
        frequency = contact["frequency"] / max_freq

        final = (PHONETIC_WEIGHT * phonetic
                 + STRING_WEIGHT * string
                 + FREQUENCY_WEIGHT * frequency)

        scored.append({
            "email": contact["email"],
            "display_name": contact["display_name"],
            "score": round(final, 4),
        })

    # Sort descending by score, filter, and limit
    scored.sort(key=lambda x: x["score"], reverse=True)
    return [s for s in scored if s["score"] > MIN_SCORE_THRESHOLD][:MAX_RESULTS]


# ============================================================================
# TEST RUNNER
# ============================================================================

def _run_tests() -> str:
    """
    Run all test queries against the contact list and build a report string.

    Returns:
        The full report as a string (printed to stdout and written to file).
    """
    lines: list[str] = []
    lines.append("=" * 70)
    lines.append("FUZZY CONTACT MATCHING -- TEST RESULTS")
    lines.append("=" * 70)
    lines.append("")

    top_match_pass = 0
    top3_pass = 0
    total = len(TEST_QUERIES)

    for query, expected_email, description in TEST_QUERIES:
        results = rank_contacts(query, CONTACTS)
        top3_emails = [r["email"] for r in results[:3]]

        # Determine pass/fail status
        if results and results[0]["email"] == expected_email:
            status = "PASS"
            top_match_pass += 1
            top3_pass += 1
        elif expected_email in top3_emails:
            status = "PARTIAL (in top 3, not top 1)"
            top3_pass += 1
        else:
            status = "FAIL"

        lines.append(f"Query: \"{query}\"")
        lines.append(f"  Description: {description}")
        lines.append(f"  Expected:    {expected_email}")
        lines.append(f"  Status:      {status}")
        lines.append(f"  Top 3 results:")
        for i, r in enumerate(results[:3]):
            marker = " <--" if r["email"] == expected_email else ""
            lines.append(
                f"    {i+1}. {r['email']:<40} "
                f"name={r['display_name'] or '(none)':<25} "
                f"score={r['score']:.4f}{marker}"
            )
        if not results:
            lines.append("    (no results above threshold)")
        lines.append("")

    # Summary
    lines.append("=" * 70)
    lines.append("SUMMARY")
    lines.append("=" * 70)
    lines.append(f"Top-1 match: {top_match_pass}/{total} passed")
    lines.append(f"Top-3 match: {top3_pass}/{total} passed")
    lines.append("")

    return "\n".join(lines)


def main() -> None:
    """Entry point. Runs tests, prints to stdout, writes to output/results.txt."""
    report = _run_tests()
    print(report)

    # Write to output file
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_dir = os.path.join(script_dir, "output")
    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, "results.txt")

    with open(output_path, "w") as f:
        f.write(report)

    print(f"Results written to: {output_path}")


if __name__ == "__main__":
    main()
