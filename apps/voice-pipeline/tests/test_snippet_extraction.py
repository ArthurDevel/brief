"""
Tests for snippet extraction helpers and body parsing.

Validates that:
- _find_text_part correctly walks BODYSTRUCTURE to find text parts
- _decode_part handles base64, quoted-printable, and 7bit encodings
- _extract_body produces clean text from full RFC822 emails (used by readEmail
  and as the same parsing logic behind snippets)

- Defines realistic BODYSTRUCTURE constants (as returned by imapclient)
- Defines realistic full RFC822 email constants
- Tests the helper functions directly
"""

from __future__ import annotations

from src.tools.email_client import (
    _find_text_part,
    _decode_part,
    _extract_body,
    _decode_header,
    SNIPPET_LENGTH,
)


# ============================================================================
# CONSTANTS - BODYSTRUCTURE SAMPLES (as returned by imapclient)
# ============================================================================

# Multipart/alternative with text/plain + text/html
# imapclient format: ([child1, child2], b'ALTERNATIVE', ...)
# Leaf: (b'TEXT', b'PLAIN', (b'CHARSET', b'utf-8'), None, None, b'7BIT', 123)
BODYSTRUCTURE_MULTIPART = (
    [
        (b"TEXT", b"PLAIN", (b"CHARSET", b"utf-8"), None, None, b"7BIT", 123),
        (b"TEXT", b"HTML", (b"CHARSET", b"utf-8"), None, None, b"QUOTED-PRINTABLE", 456),
    ],
    b"ALTERNATIVE",
)

# Single text/plain (no multipart)
BODYSTRUCTURE_PLAIN_ONLY = (
    b"TEXT", b"PLAIN", (b"CHARSET", b"utf-8"), None, None, b"7BIT", 100,
)

# Single text/html (no multipart)
BODYSTRUCTURE_HTML_ONLY = (
    b"TEXT", b"HTML", (b"CHARSET", b"utf-8"), None, None, b"BASE64", 500,
)

# Multipart with only text/html (no plain part)
BODYSTRUCTURE_MULTIPART_HTML_ONLY = (
    [
        (b"TEXT", b"HTML", (b"CHARSET", b"utf-8"), None, None, b"QUOTED-PRINTABLE", 456),
        (b"IMAGE", b"PNG", None, None, None, b"BASE64", 9999),
    ],
    b"RELATED",
)

# Nested multipart: multipart/mixed > multipart/alternative > text/plain + text/html
BODYSTRUCTURE_NESTED = (
    [
        (
            [
                (b"TEXT", b"PLAIN", (b"CHARSET", b"utf-8"), None, None, b"7BIT", 50),
                (b"TEXT", b"HTML", (b"CHARSET", b"utf-8"), None, None, b"7BIT", 200),
            ],
            b"ALTERNATIVE",
        ),
        (b"APPLICATION", b"PDF", None, None, None, b"BASE64", 50000),
    ],
    b"MIXED",
)


# ============================================================================
# CONSTANTS - FULL RFC822 EMAIL SAMPLES (for _extract_body tests)
# ============================================================================

# HTML email with <style> block containing CSS rules.
HTML_WITH_CSS_EMAIL = (
    b"From: alerts@chase.com\r\n"
    b"To: user@example.com\r\n"
    b"Subject: You updated your digital wallet\r\n"
    b"MIME-Version: 1.0\r\n"
    b"Content-Type: text/html; charset=utf-8\r\n"
    b"\r\n"
    b'<!DOCTYPE html><html><head><style type="text/css">'
    b"* { line-height: normal !important; } "
    b"strong { font-weight: bold !important; }"
    b"</style></head><body>"
    b"<p>You updated your digital wallet successfully.</p>"
    b"</body></html>"
)

# Multipart MIME email with text/plain + text/html parts.
MULTIPART_MIME_EMAIL = (
    b"From: sender@example.com\r\n"
    b"To: recipient@example.com\r\n"
    b"Subject: Meeting notes\r\n"
    b"MIME-Version: 1.0\r\n"
    b'Content-Type: multipart/alternative; boundary="_boundary123"\r\n'
    b"\r\n"
    b"--_boundary123\r\n"
    b"Content-Type: text/plain; charset=utf-8\r\n"
    b"Content-Transfer-Encoding: 7bit\r\n"
    b"\r\n"
    b"Hey, here are the meeting notes from today.\r\n"
    b"--_boundary123\r\n"
    b"Content-Type: text/html; charset=utf-8\r\n"
    b"\r\n"
    b"<html><body><p>Hey, here are the meeting notes from today.</p></body></html>\r\n"
    b"--_boundary123--"
)


# ============================================================================
# TESTS - _find_text_part
# ============================================================================

class TestFindTextPart:
    def test_prefers_plain_over_html_in_multipart(self):
        result = _find_text_part(BODYSTRUCTURE_MULTIPART)

        assert result is not None
        mime_type, part_spec, encoding, charset = result
        assert mime_type == "text/plain"
        assert part_spec == "1"
        assert encoding == "7bit"
        assert charset == "utf-8"

    def test_single_plain_part(self):
        result = _find_text_part(BODYSTRUCTURE_PLAIN_ONLY)

        assert result is not None
        mime_type, part_spec, encoding, charset = result
        assert mime_type == "text/plain"
        assert encoding == "7bit"

    def test_single_html_part(self):
        result = _find_text_part(BODYSTRUCTURE_HTML_ONLY)

        assert result is not None
        mime_type, part_spec, encoding, charset = result
        assert mime_type == "text/html"
        assert encoding == "base64"

    def test_falls_back_to_html_when_no_plain(self):
        result = _find_text_part(BODYSTRUCTURE_MULTIPART_HTML_ONLY)

        assert result is not None
        mime_type, _part_spec, _encoding, _charset = result
        assert mime_type == "text/html"

    def test_finds_text_in_nested_multipart(self):
        result = _find_text_part(BODYSTRUCTURE_NESTED)

        assert result is not None
        mime_type, part_spec, encoding, charset = result
        assert mime_type == "text/plain"
        assert part_spec == "1.1"


# ============================================================================
# TESTS - _decode_part
# ============================================================================

class TestDecodePart:
    def test_decodes_7bit_utf8(self):
        raw = b"Hello, this is plain text."
        result = _decode_part(raw, "7bit", "utf-8")
        assert result == "Hello, this is plain text."

    def test_decodes_quoted_printable(self):
        raw = b"San Francisco=2C CA"
        result = _decode_part(raw, "quoted-printable", "utf-8")
        assert result == "San Francisco, CA"

    def test_decodes_base64_utf8(self):
        import base64
        original = "Meeting notes from today."
        raw = base64.b64encode(original.encode("utf-8"))
        result = _decode_part(raw, "base64", "utf-8")
        assert result == original

    def test_decodes_latin1_charset(self):
        raw = b"caf\xe9"
        result = _decode_part(raw, "7bit", "iso-8859-1")
        assert result == "cafe\u0301" or result == "caf\xe9"


# ============================================================================
# TESTS - _extract_body (end-to-end body parsing)
# ============================================================================

class TestExtractBody:
    def test_strips_css_from_html_emails(self):
        body = _extract_body(HTML_WITH_CSS_EMAIL)

        assert "line-height" not in body
        assert "!important" not in body
        assert "<" not in body
        assert "digital wallet" in body

    def test_prefers_plain_text_in_multipart(self):
        body = _extract_body(MULTIPART_MIME_EMAIL)

        assert "meeting notes" in body
        assert "<" not in body

    def test_snippet_from_body_is_clean(self):
        """Simulates snippet generation: extract body, then truncate."""
        body = _extract_body(HTML_WITH_CSS_EMAIL)
        snippet = body[:SNIPPET_LENGTH].replace("\n", " ").strip()

        assert "line-height" not in snippet
        assert "{" not in snippet
        assert "digital wallet" in snippet

    def test_strips_zero_width_characters_from_body(self):
        """Based on real Dribbble email stuffed with zero-width non-joiners."""
        body = _extract_body(
            b"From: no-reply@dribbble.com\r\n"
            b"Subject: Protein branding\r\n"
            b"MIME-Version: 1.0\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n"
            b"\r\n"
            b"Plus: redundancy reframed \xe2\x80\x8c \xe2\x80\x8c \xe2\x80\x8c "
            b"\xe2\x80\x8c \xe2\x80\x8c \xe2\x80\x8c \xe2\x80\x8c \xe2\x80\x8c"
        )
        snippet = body[:SNIPPET_LENGTH].replace("\n", " ").strip()

        # Should not contain zero-width non-joiner characters
        assert "\u200c" not in snippet
        # Should contain readable text
        assert "redundancy reframed" in snippet


# ============================================================================
# TESTS - _decode_header (RFC 2047 encoded subjects)
# ============================================================================

class TestDecodeHeader:
    def test_decodes_utf8_q_encoded_subject(self):
        """Based on real calendar invite with Q-encoded subject."""
        encoded = b"=?UTF-8?Q?Afspraak_gemaakt:_=E2=98=95_Quick_m?= =?UTF-8?Q?orning_check-in?="
        result = _decode_header(encoded)

        assert "=?UTF-8?Q?" not in result
        assert "=E2=98=95" not in result
        assert "Quick morning check-in" in result

    def test_decodes_utf8_q_encoded_emoji(self):
        """Based on real Dribbble email with Q-encoded emoji in subject."""
        encoded = b"=?UTF-8?Q?=F0=9F=90=84=C2=A0Protein_branding,_but_make_it_quiet?="
        result = _decode_header(encoded)

        assert "=?UTF-8?Q?" not in result
        assert "=F0=9F=90=84" not in result
        assert "Protein branding" in result

    def test_plain_ascii_subject_unchanged(self):
        result = _decode_header(b"Meeting notes")
        assert result == "Meeting notes"

    def test_none_returns_no_subject(self):
        result = _decode_header(None)
        assert result == "(no subject)"


# ============================================================================
# TESTS - snippet cleanup (carriage returns, markdown images)
# ============================================================================

class TestSnippetCleanup:
    def test_strips_carriage_returns_from_body(self):
        """Based on real Proximus email with \\r throughout snippet."""
        body = _extract_body(
            b"From: service@proximus.com\r\n"
            b"Subject: Met MyProximus lukt het me!\r\n"
            b"MIME-Version: 1.0\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n"
            b"\r\n"
            b"Alles van Proximus op zak\r\n\r\n\r\nBeste klant,\r\n\r\nNaar aanleiding"
        )
        snippet = body[:SNIPPET_LENGTH].replace("\n", " ").strip()

        assert "\r" not in snippet

    def test_strips_markdown_image_links_from_body(self):
        """Based on real Stage Freaks email with [Image](url) in snippet."""
        body = _extract_body(
            b"From: info@stagefreaks.nl\r\n"
            b"Subject: Laatste rigging cursus\r\n"
            b"MIME-Version: 1.0\r\n"
            b"Content-Type: text/html; charset=utf-8\r\n"
            b"\r\n"
            b'<html><body><a href="https://example.com"><img src="https://example.com/img.jpg"></a>'
            b"<p>Hoi Arthur, wil jij je rigging skills verbeteren?</p></body></html>"
        )
        snippet = body[:SNIPPET_LENGTH].replace("\n", " ").strip()

        # Should not contain markdown image syntax
        assert "![" not in snippet
        assert "[Image" not in snippet
        # Should contain readable text
        assert "rigging" in snippet
