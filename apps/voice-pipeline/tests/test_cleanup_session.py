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

import httpx
import pytest

from src.session import ActiveSession
from src.server import _cleanup_session, _trigger_end_of_session_hook, _live_pipeline_sessions, lifespan, cancel_stt_tasks


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _find_session_update_payload(update_mock: MagicMock) -> dict:
    """Find the update() call that contains 'ended_at' (the session finalization).

    Other code paths (e.g. contact_sync) also call .update() on the same mock,
    so we need to search through all calls to find the session-specific one.
    """
    for call in update_mock.call_args_list:
        payload = call[0][0]
        if isinstance(payload, dict) and "ended_at" in payload:
            return payload
    raise AssertionError("No update() call with 'ended_at' found -- session was not finalized")


@pytest.fixture
def session(supabase_mock: MagicMock) -> ActiveSession:
    """A minimal active session."""
    return ActiveSession(
        session_id="test-session-id",
        user_id="test-user-id",
        started_at=datetime.now(timezone.utc),
        supabase=supabase_mock,
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
    """Mock settings with required keys for cleanup and end-of-session hook."""
    settings = MagicMock()
    settings.openrouter_api_key = "fake-key"
    settings.web_app_url = "http://localhost:3000"
    settings.internal_api_key = "fake-internal-key"
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

    with patch("src.server.close_imap_connection"), \
         patch("src.server._trigger_end_of_session_hook", new_callable=AsyncMock):
        await _cleanup_session(
            imap_holder, cost_tracker, langfuse_observer, session, supabase_mock, settings_mock,
        )

    # The session row must have been updated with ended_at and duration_seconds
    update_call = supabase_mock.table.return_value.update
    assert update_call.called, "end_session was never called -- session stays 'In progress'"

    # Find the session update call (contains "ended_at"), not other update calls
    session_payload = _find_session_update_payload(update_call)
    assert session_payload["ended_at"] is not None, "ended_at was not set"
    assert session_payload["duration_seconds"] is not None, "duration_seconds was not set"


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

    with patch("src.server.close_imap_connection"), \
         patch("src.server._trigger_end_of_session_hook", new_callable=AsyncMock):
        await _cleanup_session(
            imap_holder, cost_tracker, langfuse_observer, session, supabase_mock, settings_mock,
        )

    update_call = supabase_mock.table.return_value.update
    assert update_call.called, "end_session was never called -- session stays 'In progress'"

    session_payload = _find_session_update_payload(update_call)
    assert session_payload["ended_at"] is not None, "ended_at was not set"
    assert session_payload["duration_seconds"] is not None, "duration_seconds was not set"


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
         patch("src.server.shutdown_langfuse_client"), \
         patch("src.server._trigger_end_of_session_hook", new_callable=AsyncMock):
        async with lifespan(mock_app):
            pass  # server "runs" then shuts down

    update_call = supabase_mock.table.return_value.update
    assert update_call.called, "Orphaned session was not finalized on shutdown"

    session_payload = _find_session_update_payload(update_call)
    assert session_payload["ended_at"] is not None, "ended_at was not set"
    assert session_payload["duration_seconds"] is not None, "duration_seconds was not set"

    # Session should be removed from the registry
    assert session.session_id not in _live_pipeline_sessions


@pytest.mark.asyncio
async def test_cleanup_completes_when_hook_fails_both_attempts(
    session: ActiveSession,
    supabase_mock: MagicMock,
    settings_mock: MagicMock,
) -> None:
    """When the end-of-session hook fails on both attempts (transient error),
    cleanup must still complete and the session must be finalized in the DB.
    """
    cost_tracker = MagicMock()
    cost_tracker.fetch_llm_costs = AsyncMock()
    langfuse_observer = MagicMock()
    imap_holder = {"client": MagicMock(), "config": MagicMock()}

    with patch("src.server.close_imap_connection"), \
         patch("httpx.AsyncClient.post", new_callable=AsyncMock, side_effect=httpx.ConnectError("connection refused")), \
         patch("src.server.asyncio.sleep", new_callable=AsyncMock):
        await _cleanup_session(
            imap_holder, cost_tracker, langfuse_observer, session, supabase_mock, settings_mock,
        )

    # Session must still be finalized
    update_call = supabase_mock.table.return_value.update
    assert update_call.called, "end_session was never called -- session stays 'In progress'"

    session_payload = _find_session_update_payload(update_call)
    assert session_payload["ended_at"] is not None, "ended_at was not set"
    assert session_payload["duration_seconds"] is not None, "duration_seconds was not set"


@pytest.mark.asyncio
async def test_cleanup_retries_hook_on_transient_failure(
    session: ActiveSession,
    supabase_mock: MagicMock,
    settings_mock: MagicMock,
) -> None:
    """When the hook fails once with a transient error then succeeds on retry,
    two POST calls must be made and cleanup completes normally.
    """
    cost_tracker = MagicMock()
    cost_tracker.fetch_llm_costs = AsyncMock()
    langfuse_observer = MagicMock()
    imap_holder = {"client": MagicMock(), "config": MagicMock()}

    # First call raises ConnectError, second call succeeds
    mock_response = MagicMock()
    mock_response.raise_for_status = MagicMock()
    mock_post = AsyncMock(side_effect=[httpx.ConnectError("connection refused"), mock_response])

    with patch("src.server.close_imap_connection"), \
         patch("httpx.AsyncClient.post", mock_post), \
         patch("src.server.asyncio.sleep", new_callable=AsyncMock):
        await _cleanup_session(
            imap_holder, cost_tracker, langfuse_observer, session, supabase_mock, settings_mock,
        )

    # Two POST calls confirm the retry happened
    assert mock_post.call_count == 2, f"Expected 2 POST calls (1 fail + 1 retry), got {mock_post.call_count}"

    # Session must be finalized
    update_call = supabase_mock.table.return_value.update
    assert update_call.called, "end_session was never called"


@pytest.mark.asyncio
async def test_stt_dangling_tasks_cancelled_after_shutdown() -> None:
    """After the pipeline runner finishes, all surviving asyncio tasks owned
    by the STT service's task manager must be cancelled.
    """
    # Create fake asyncio tasks with a .cancel() method
    fake_tasks = []
    for i in range(3):
        task = MagicMock()
        task.cancel = MagicMock()
        # Make the task awaitable -- raises CancelledError when gathered
        task.__await__ = MagicMock(
            side_effect=lambda: (_ for _ in ()).throw(asyncio.CancelledError)
        )
        fake_tasks.append(task)

    # Mock STT service with a task manager that returns the fake tasks
    mock_stt = MagicMock()
    mock_stt._task_manager = MagicMock()
    mock_stt._task_manager.current_tasks.return_value = fake_tasks

    await cancel_stt_tasks(mock_stt)

    # All tasks should have received .cancel()
    for task in fake_tasks:
        assert task.cancel.called, "Task was not cancelled"


@pytest.mark.asyncio
async def test_stt_cleanup_handles_missing_task_manager() -> None:
    """When the STT service has no task manager (e.g. pipeline failed before
    start), cancel_stt_tasks must not raise.
    """
    mock_stt = MagicMock()
    mock_stt._task_manager = None

    # Should complete without raising
    await cancel_stt_tasks(mock_stt)
