"""
Tests for session user-context loading helpers.

Verifies:
- missing user_settings rows fall back to defaults instead of crashing
- WebRTC startup closes the peer connection cleanly when user context loading fails
"""

from __future__ import annotations

import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

twilio_module = ModuleType("twilio")
twilio_rest_module = ModuleType("twilio.rest")
twilio_rest_module.Client = MagicMock()
twilio_module.rest = twilio_rest_module
sys.modules.setdefault("twilio", twilio_module)
sys.modules.setdefault("twilio.rest", twilio_rest_module)

from src.server import _webrtc_bot
from src.session import load_user_context


def _mock_user_context_supabase(
    *,
    settings_data: dict | None,
    email_rows: list[dict] | None,
    memory_rows: list[dict] | None = None,
) -> MagicMock:
    """Create a mock Supabase client for load_user_context."""
    mock_client = MagicMock()

    settings_execute = MagicMock()
    settings_execute.data = settings_data

    account_execute = MagicMock()
    account_execute.data = email_rows or []

    memory_execute = MagicMock()
    memory_execute.data = memory_rows or []

    settings_chain = (
        mock_client.table.return_value
        .select.return_value
        .eq.return_value
        .maybe_single.return_value
    )
    settings_chain.execute.return_value = settings_execute

    account_table = MagicMock()
    account_chain = (
        account_table.select.return_value
        .eq.return_value
        .eq.return_value
        .limit.return_value
    )
    account_chain.execute.return_value = account_execute

    memory_table = MagicMock()
    memory_chain = memory_table.select.return_value.eq.return_value
    memory_chain.execute.return_value = memory_execute

    def table_side_effect(name: str):
        if name == "user_settings":
            return mock_client.table.return_value
        if name == "user_email_accounts":
            return account_table
        if name == "user_memory":
            return memory_table
        raise AssertionError(f"Unexpected table lookup: {name}")

    mock_client.table.side_effect = table_side_effect
    return mock_client


def test_load_user_context_uses_defaults_when_settings_row_missing():
    """Users without a user_settings row should still be able to load context."""
    mock_client = _mock_user_context_supabase(
        settings_data=None,
        email_rows=[{
            "id": "acc-1",
            "provider": "gmail",
            "connection_type": "unipile",
            "email_address": "user@example.com",
            "unipile_account_id": "unipile-1",
            "status": "connected",
        }],
    )

    result = load_user_context("user-123", mock_client)

    assert result.user_id == "user-123"
    assert result.email_account.provider == "gmail"
    assert result.voice_preference == "aura-2-andromeda-en"
    assert result.voice_speed == 1.2
    assert result.tool_approval_config == {}
    assert result.memory_entries == []
    assert result.timezone is None


@pytest.mark.asyncio
async def test_webrtc_bot_closes_connection_when_user_context_load_fails():
    """WebRTC startup failures should not escape as uncaught background task errors."""
    connection = SimpleNamespace(pc=SimpleNamespace(close=AsyncMock()))

    with (
        patch("src.server.load_settings"),
        patch("src.server.create_service_client", return_value=MagicMock()),
        patch("src.server.verify_token", return_value="user-123"),
        patch("src.server.load_user_context", side_effect=RuntimeError("No active email account found")),
    ):
        await _webrtc_bot(connection, {"token": "fake-jwt"})

    connection.pc.close.assert_awaited_once()
