"""
Test that the WebRTC /start endpoint enforces usage limits.

Verifies that a user who has exceeded their monthly call limit
receives a 403 when trying to start a new WebRTC session.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from src.server import app


@pytest.fixture
def client():
    return TestClient(app)


def test_start_returns_403_when_usage_limit_exceeded(client: TestClient):
    """A user over their monthly limit must be blocked from starting a WebRTC call."""
    with (
        patch("src.server.load_settings"),
        patch("src.server.create_service_client", return_value=MagicMock()),
        patch("src.server.verify_token", return_value="user-123"),
        patch("src.server.check_usage_limit", return_value=False),
    ):
        response = client.post(
            "/start",
            json={"token": "fake-jwt-token"},
        )

    assert response.status_code == 403
