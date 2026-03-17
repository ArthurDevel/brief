"""
Test that _cleanup_session always finalizes the session in the database,
even when upstream steps (cost fetching, Langfuse) fail.

A session that is never finalized stays with ended_at=NULL and
duration_seconds=NULL, causing "In progress" entries in the call history
that never resolve.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.session import ActiveSession
from src.server import _cleanup_session, _live_pipeline_sessions, lifespan


@pytest.fixture
def session() -> ActiveSession:
    """A minimal active session."""
    return ActiveSession(
        session_id="test-session-id",
        user_id="test-user-id",
        started_at=datetime.now(timezone.utc),
    )


@pytest.fixture
def supabase_mock() -> MagicMock:
    """Mock Supabase client that records update calls."""
    mock = MagicMock()
    # Chain: supabase.table("sessions").update({...}).eq("id", ...).execute()
    mock.table.return_value.update.return_value.eq.return_value.execute.return_value = MagicMock(
        data=[{"id": "test-session-id"}]
    )
    return mock


@pytest.fixture
def settings_mock() -> MagicMock:
    """Mock settings with an OpenRouter API key."""
    settings = MagicMock()
    settings.openrouter_api_key = "fake-key"
    return settings


@pytest.mark.asyncio
async def test_session_finalized_when_cost_fetch_fails(
    session: ActiveSession,
    supabase_mock: MagicMock,
    settings_mock: MagicMock,
) -> None:
    """When fetch_llm_costs raises, the session must still be written to the DB
    with ended_at and duration_seconds populated (not left as NULL / 'In progress').
    """
    # Cost tracker that explodes on fetch_llm_costs
    cost_tracker = MagicMock()
    cost_tracker.fetch_llm_costs = AsyncMock(side_effect=RuntimeError("OpenRouter timeout"))

    langfuse_observer = MagicMock()
    imap_holder = {"client": MagicMock(), "config": MagicMock()}

    with patch("src.server.close_imap_connection"):
        await _cleanup_session(
            imap_holder, cost_tracker, langfuse_observer, session, supabase_mock, settings_mock,
        )

    # The session row must have been updated with ended_at and duration_seconds
    update_call = supabase_mock.table.return_value.update
    assert update_call.called, "end_session was never called -- session stays 'In progress'"

    update_payload = update_call.call_args[0][0]
    assert update_payload["ended_at"] is not None, "ended_at was not set"
    assert update_payload["duration_seconds"] is not None, "duration_seconds was not set"


@pytest.mark.asyncio
async def test_session_finalized_on_server_shutdown(
    session: ActiveSession,
    supabase_mock: MagicMock,
    settings_mock: MagicMock,
) -> None:
    """When the server is killed (Ctrl+C) during an active call, CancelledError
    propagates through async operations. The session must still be finalized
    in the DB -- not left as 'In progress' forever.
    """
    cost_tracker = MagicMock()
    cost_tracker.fetch_llm_costs = AsyncMock(side_effect=asyncio.CancelledError)

    langfuse_observer = MagicMock()
    imap_holder = {"client": MagicMock(), "config": MagicMock()}

    with patch("src.server.close_imap_connection"):
        await _cleanup_session(
            imap_holder, cost_tracker, langfuse_observer, session, supabase_mock, settings_mock,
        )

    update_call = supabase_mock.table.return_value.update
    assert update_call.called, "end_session was never called -- session stays 'In progress'"

    update_payload = update_call.call_args[0][0]
    assert update_payload["ended_at"] is not None, "ended_at was not set"
    assert update_payload["duration_seconds"] is not None, "duration_seconds was not set"


@pytest.mark.asyncio
async def test_lifespan_shutdown_finalizes_orphaned_sessions(
    session: ActiveSession,
    supabase_mock: MagicMock,
    settings_mock: MagicMock,
) -> None:
    """When the server is hard-killed, the bot's finally block never runs.
    The lifespan shutdown must finalize any sessions still in _live_pipeline_sessions.
    """
    cost_tracker = MagicMock()
    cost_tracker.fetch_llm_costs = AsyncMock()
    langfuse_observer = MagicMock()
    imap_holder = {"client": MagicMock(), "config": MagicMock()}

    # Simulate a session that was registered but never cleaned up
    _live_pipeline_sessions[session.session_id] = {
        "session": session,
        "cost_tracker": cost_tracker,
        "langfuse_observer": langfuse_observer,
        "imap_holder": imap_holder,
        "supabase": supabase_mock,
        "settings": settings_mock,
    }

    mock_handler = MagicMock()
    mock_handler.close = AsyncMock()

    mock_app = MagicMock()
    with patch("src.server.close_imap_connection"), \
         patch("src.server.SmallWebRTCRequestHandler", return_value=mock_handler), \
         patch("src.server.shutdown_langfuse_client"):
        async with lifespan(mock_app):
            pass  # server "runs" then shuts down

    update_call = supabase_mock.table.return_value.update
    assert update_call.called, "Orphaned session was not finalized on shutdown"

    update_payload = update_call.call_args[0][0]
    assert update_payload["ended_at"] is not None, "ended_at was not set"
    assert update_payload["duration_seconds"] is not None, "duration_seconds was not set"

    # Session should be removed from the registry
    assert session.session_id not in _live_pipeline_sessions
