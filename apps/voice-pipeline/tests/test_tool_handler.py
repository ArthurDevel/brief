"""
Tests for the tool handler registered in pipeline.py.

Verifies that tool call results always communicate success or failure
back to the LLM -- especially when operations time out or raise errors.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.pipeline import _register_tool_handler
from src.session import ActiveSession, SmtpConfig, UserContext, MemoryEntry


# ============================================================================
# HELPERS
# ============================================================================

def _make_user_context() -> UserContext:
    """Create a minimal UserContext for testing."""
    return UserContext(
        user_id="test-user",
        imap_config=MagicMock(),
        smtp_config=SmtpConfig(host="", port=0, user="", password=""),
        voice_preference="aura-asteria-en",
        voice_speed=1.0,
        tool_approval_config={},
        memory_entries=[],
    )


def _make_session() -> ActiveSession:
    """Create a minimal ActiveSession for testing."""
    return MagicMock(spec=ActiveSession, session_id="test-session", user_id="test-user")


def _capture_handler(tool_name: str, **kwargs):
    """Register a tool handler and return the captured async handler function.

    Mocks the LLM's register_function to intercept the handler closure
    that _register_tool_handler creates.
    """
    mock_llm = MagicMock()
    captured = {}

    def capture(name, handler):
        captured[name] = handler

    mock_llm.register_function = capture

    _register_tool_handler(
        llm=mock_llm,
        tool_name=tool_name,
        session=kwargs.get("session", _make_session()),
        user_context=kwargs.get("user_context", _make_user_context()),
        imap_holder=kwargs.get("imap_holder", {"client": MagicMock(), "config": MagicMock()}),
        imap_lock=kwargs.get("imap_lock", asyncio.Lock()),
        supabase=kwargs.get("supabase", MagicMock()),
        langfuse_observer=kwargs.get("langfuse_observer", MagicMock()),
    )

    return captured[tool_name]


async def _call_handler(handler, tool_name: str = "archive_email", args: dict | None = None):
    """Call the captured handler and return the parsed JSON result."""
    result_callback = AsyncMock()

    await handler(
        tool_name,
        "tool_call_123",
        args or {"email_id": "1"},
        MagicMock(),   # llm_instance
        None,          # context
        result_callback,
    )

    result_callback.assert_called_once()
    return json.loads(result_callback.call_args[0][0])


# ============================================================================
# TESTS
# ============================================================================

class TestToolHandlerTimeout:
    """When a tool operation exceeds the timeout, the handler must return
    an error result so the LLM knows the action failed."""

    @pytest.mark.asyncio
    async def test_timeout_returns_error_result(self, monkeypatch):
        """If the underlying tool call blocks longer than the handler's
        internal timeout, the result must contain status 'error' with a
        timeout message -- not block forever and let pipecat send 'COMPLETED'."""
        cancel = threading.Event()

        def blocking_tool_call(*args, **kwargs):
            cancel.wait(30)

        monkeypatch.setattr("src.pipeline.handle_tool_call", blocking_tool_call)

        handler = _capture_handler("archive_email")

        # The handler must resolve within pipecat's 10s timeout window.
        # If it doesn't, the test fails -- proving the handler has no
        # internal timeout and would let pipecat send "COMPLETED".
        try:
            result = await asyncio.wait_for(_call_handler(handler), timeout=12)
        except (TimeoutError, asyncio.TimeoutError):
            pytest.fail(
                "Handler blocked forever instead of returning a timeout error. "
                "In production, pipecat would send 'COMPLETED' to the LLM."
            )

        assert result["status"] == "error"
        assert result["result"] is None
        assert "timed out" in result["message"].lower()

        # Clean up the blocking thread
        cancel.set()


class TestToolHandlerConcurrency:
    """Concurrent tool calls must be serialized so they don't corrupt
    the shared IMAP connection."""

    @pytest.mark.asyncio
    async def test_concurrent_tool_calls_are_serialized(self, monkeypatch):
        """Two tool calls dispatched concurrently must not overlap execution.
        They should run one after the other (serialized), both succeeding."""
        execution_log: list[str] = []

        def slow_tool_call(*args, **kwargs):
            thread_id = threading.current_thread().name
            execution_log.append(f"start-{thread_id}")
            time.sleep(0.3)
            execution_log.append(f"end-{thread_id}")
            # Return a valid ActionResult
            from src.tools.handlers import ActionResult
            return ActionResult(
                action_id="test",
                status="executed",
                result={"archived": True},
                message="ok",
            )

        monkeypatch.setattr("src.pipeline.handle_tool_call", slow_tool_call)

        handler = _capture_handler("archive_email")

        # Dispatch two calls concurrently (simulates parallel LLM tool calls)
        results = await asyncio.gather(
            _call_handler(handler, args={"email_id": "1"}),
            _call_handler(handler, args={"email_id": "2"}),
        )

        # Both must succeed
        assert results[0]["status"] == "executed"
        assert results[1]["status"] == "executed"

        # Execution must be serialized: first call must finish before second starts.
        # The log should be [start, end, start, end], not [start, start, end, end].
        assert len(execution_log) == 4
        assert execution_log[1].startswith("end-"), (
            f"Calls overlapped instead of being serialized: {execution_log}"
        )


class TestToolHandlerError:
    """When a tool operation raises an exception, the handler must return
    an error result with the exception message."""

    @pytest.mark.asyncio
    async def test_exception_returns_error_result(self, monkeypatch):
        """If the tool call raises, the result must contain the error message."""

        def failing_tool_call(*args, **kwargs):
            raise RuntimeError("IMAP operation failed, reconnecting: command: LIST => unexpected response")

        monkeypatch.setattr("src.pipeline.handle_tool_call", failing_tool_call)

        handler = _capture_handler("archive_email")
        result = await _call_handler(handler)

        assert result["status"] == "error"
        assert result["result"] is None
        assert "IMAP operation failed" in result["message"]
