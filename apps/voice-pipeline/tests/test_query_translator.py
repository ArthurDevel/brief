"""
Unit tests for the Gmail-to-IMAP query translator.
"""
# pyright: reportMissingImports=false

from __future__ import annotations

import datetime

import pytest

from src.tools.query_translator import translate_query


# --------------------------------------------------------------------------
# single operators
# --------------------------------------------------------------------------

class TestSingleOperators:
    def test_from_operator(self):
        result = translate_query("from:alice@example.com")
        assert result == ["FROM", "alice@example.com"]

    def test_to_operator(self):
        result = translate_query("to:bob@example.com")
        assert result == ["TO", "bob@example.com"]

    def test_subject_operator(self):
        result = translate_query("subject:invoice")
        assert result == ["SUBJECT", "invoice"]

    def test_before_date(self):
        result = translate_query("before:2024-01-01")
        assert result == ["BEFORE", datetime.date(2024, 1, 1)]

    def test_after_date(self):
        result = translate_query("after:2024-06-15")
        assert result == ["SINCE", datetime.date(2024, 6, 15)]

    def test_has_attachment(self):
        result = translate_query("has:attachment")
        assert result == ["HEADER", "Content-Type", "multipart/mixed"]

    def test_is_unread(self):
        result = translate_query("is:unread")
        assert result == ["UNSEEN"]


# --------------------------------------------------------------------------
# bare keywords
# --------------------------------------------------------------------------

class TestBareKeywords:
    def test_bare_keyword_searches_subject_and_from(self):
        result = translate_query("invoice")
        assert result == ["OR", "SUBJECT", "invoice", "FROM", "invoice"]


# --------------------------------------------------------------------------
# compound queries
# --------------------------------------------------------------------------

class TestCompoundQueries:
    def test_multiple_operators_are_anded(self):
        result = translate_query("from:bob subject:invoice")
        assert result == ["FROM", "bob", "SUBJECT", "invoice"]

    def test_subject_and_before_date(self):
        result = translate_query("subject:invoice before:2024-01-01")
        assert result == ["SUBJECT", "invoice", "BEFORE", datetime.date(2024, 1, 1)]

    def test_bare_keyword_with_operator(self):
        result = translate_query("invoice from:bob")
        assert result == ["OR", "SUBJECT", "invoice", "FROM", "invoice", "FROM", "bob"]


# --------------------------------------------------------------------------
# error cases
# --------------------------------------------------------------------------

class TestErrorCases:
    def test_unsupported_operator_raises_value_error(self):
        with pytest.raises(ValueError, match="Unsupported search operator"):
            translate_query("label:important")

    def test_empty_query_raises_value_error(self):
        with pytest.raises(ValueError, match="must not be empty"):
            translate_query("")

    def test_unsupported_has_value_raises(self):
        with pytest.raises(ValueError, match="Unsupported 'has' value"):
            translate_query("has:star")

    def test_unsupported_is_value_raises(self):
        with pytest.raises(ValueError, match="Unsupported 'is' value"):
            translate_query("is:starred")

    def test_invalid_date_raises(self):
        with pytest.raises(ValueError, match="Cannot parse date"):
            translate_query("before:not-a-date")
