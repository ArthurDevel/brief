"""
Tests for the outbound /trigger-call endpoint.

Verifies:
- missing user_settings rows return no_phone_configured instead of crashing
"""

from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from types import ModuleType
from unittest.mock import MagicMock, patch

from starlette.testclient import TestClient

twilio_module = ModuleType("twilio")
twilio_rest_module = ModuleType("twilio.rest")
twilio_rest_module.Client = MagicMock()
twilio_module.rest = twilio_rest_module
sys.modules.setdefault("twilio", twilio_module)
sys.modules.setdefault("twilio.rest", twilio_rest_module)

from src.server import app


@asynccontextmanager
async def _noop_lifespan(app):
    yield


app.router.lifespan_context = _noop_lifespan
_client = TestClient(app)


def test_trigger_call_returns_no_phone_configured_when_settings_row_missing():
    """Users without user_settings should get a controlled no_phone_configured error."""
    mock_supabase = MagicMock()
    mock_execute = MagicMock()
    mock_execute.data = None
    (
        mock_supabase.table.return_value
        .select.return_value
        .eq.return_value
        .maybe_single.return_value
    ).execute.return_value = mock_execute

    mock_settings = MagicMock()
    mock_settings.internal_api_key = "test-internal-key"

    with (
        patch("src.server.load_settings", return_value=mock_settings),
        patch("src.server.create_service_client", return_value=mock_supabase),
    ):
        response = _client.post(
            "/trigger-call",
            headers={"Authorization": "Bearer test-internal-key"},
            json={"user_id": "user-123"},
        )

    assert response.status_code == 200
    assert response.json() == {"success": False, "error": "no_phone_configured"}
