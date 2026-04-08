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
from pipecat.services.llm_service import FunctionCallParams

from src.pipeline import _register_tool_handler
from src.session import ActiveSession, EmailAccount, SmtpConfig, UserContext, MemoryEntry
from src.tools.email_client import EmailClientContext


# ============================================================================
# HELPERS
# ============================================================================

def _make_email_account() -> EmailAccount:
    """Create a minimal EmailAccount for testing."""
    return EmailAccount(
        provider="custom",
        connection_type="imap_smtp",
        email_address="test@localhost",
        unipile_account_id=None,
        status="connected",
        imap_config=None,
        smtp_config=None,
    )


def _make_email_ctx() -> EmailClientContext:
    """Create a minimal EmailClientContext for testing (custom/imap_smtp)."""
    return EmailClientContext(
        connection_type="imap_smtp",
        provider="custom",
        imap_holder={"client": MagicMock(), "config": MagicMock()},
        smtp_config=SmtpConfig(host="", port=0, user="", password=""),
    )


def _make_user_context() -> UserContext:
    """Create a minimal UserContext for testing."""
    return UserContext(
        user_id="test-user",
        email_account=_make_email_account(),
        voice_preference="aura-2-andromeda-en",
        voice_speed=1.2,
        tool_approval_config={},
        memory_entries=[],
        email_provider="custom",
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

    def capture(name, handler, **kwargs):
        captured[name] = handler

    mock_llm.register_function = capture

    _register_tool_handler(
        llm=mock_llm,
        tool_name=tool_name,
        session=kwargs.get("session", _make_session()),
        user_context=kwargs.get("user_context", _make_user_context()),
        email_ctx=kwargs.get("email_ctx", _make_email_ctx()),
        email_lock=kwargs.get("email_lock", asyncio.Lock()),
        supabase=kwargs.get("supabase", MagicMock()),
        langfuse_observer=kwargs.get("langfuse_observer", MagicMock()),
        deepgram_api_key=kwargs.get("deepgram_api_key", "test-key"),
        tts_sample_rate=kwargs.get("tts_sample_rate", 16000),
        tts_voice=kwargs.get("tts_voice", "aura-asteria-en"),
        narration_http_session=kwargs.get("narration_http_session", {"session": None}),
        openrouter_api_key=kwargs.get("openrouter_api_key", "test-openrouter-key"),
    )

    return captured[tool_name]


async def _call_handler(handler, tool_name: str = "archive_email", args: dict | None = None):
    """Call the captured handler and return the parsed JSON result."""
    result_callback = AsyncMock()

    params = FunctionCallParams(
        function_name=tool_name,
        tool_call_id="tool_call_123",
        arguments=args or {"email_id": "1"},
        llm=MagicMock(),
        context=MagicMock(),
        result_callback=result_callback,
    )
    await handler(params)

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


class TestMessageIdInArguments:
    """When archive_email or delete_email is executed via handle_tool_call,
    the message_id from the IMAP envelope must be merged into the stored
    action arguments."""

    def _make_mock_supabase(self, inserted_row: dict) -> MagicMock:
        """Create a mock Supabase client that captures the inserted row."""
        mock_supabase = MagicMock()

        def capture_insert(row):
            inserted_row.update(row)
            mock_response = MagicMock()
            mock_response.data = [{"id": "action-1"}]
            mock_chain = MagicMock()
            mock_chain.execute = MagicMock(return_value=mock_response)
            return mock_chain

        mock_supabase.table.return_value.insert = capture_insert
        return mock_supabase

    def test_archive_email_stores_message_id(self, monkeypatch):
        """archive_email via handle_tool_call should merge message_id into arguments."""
        from src.tools.handlers import handle_tool_call, ActionInput, UndoRecipe

        monkeypatch.setattr(
            "src.tools.handlers._dispatch_tool",
            lambda **kwargs: (
                {"archived": True},
                UndoRecipe(operation="move_email", params={"email_id": "42", "from": "[Gmail]/All Mail", "to": "INBOX"}),
                "<test-msg-id@example.com>",
            ),
        )

        inserted_row: dict = {}
        mock_supabase = self._make_mock_supabase(inserted_row)

        result = handle_tool_call(
            input=ActionInput(user_id="test-user", session_id="test-session", tool_name="archive_email", arguments={"email_id": "42"}),
            user_config={},
            email_ctx=_make_email_ctx(),
            supabase=mock_supabase,
        )

        assert result.status == "executed"
        assert inserted_row["arguments"]["message_id"] == "<test-msg-id@example.com>"
        assert inserted_row["arguments"]["email_id"] == "42"

    def test_delete_email_stores_message_id(self, monkeypatch):
        """delete_email (with user_config override to auto) should merge message_id."""
        from src.tools.handlers import handle_tool_call, ActionInput, UndoRecipe

        monkeypatch.setattr(
            "src.tools.handlers._dispatch_tool",
            lambda **kwargs: (
                {"deleted": True},
                UndoRecipe(operation="move_email", params={"email_id": "99", "from": "[Gmail]/Trash", "to": "INBOX"}),
                "<delete-msg-id@example.com>",
            ),
        )

        inserted_row: dict = {}
        mock_supabase = self._make_mock_supabase(inserted_row)

        # delete_email defaults to mutating_queued, so override to mutating_auto
        result = handle_tool_call(
            input=ActionInput(user_id="test-user", session_id="test-session", tool_name="delete_email", arguments={"email_id": "99"}),
            user_config={"delete_email": "mutating_auto"},
            email_ctx=_make_email_ctx(),
            supabase=mock_supabase,
        )

        assert result.status == "executed"
        assert inserted_row["arguments"]["message_id"] == "<delete-msg-id@example.com>"

    def test_non_email_tool_has_no_message_id(self, monkeypatch):
        """Tools that do not return a message_id should not add one to arguments."""
        from src.tools.handlers import handle_tool_call, ActionInput

        monkeypatch.setattr(
            "src.tools.handlers._dispatch_tool",
            lambda **kwargs: ({"marked": True}, None, None),
        )

        inserted_row: dict = {}
        mock_supabase = self._make_mock_supabase(inserted_row)

        result = handle_tool_call(
            input=ActionInput(user_id="test-user", session_id="test-session", tool_name="mark_as_read", arguments={"email_id": "10"}),
            user_config={},
            email_ctx=_make_email_ctx(),
            supabase=mock_supabase,
        )

        assert result.status == "executed"
        assert "message_id" not in inserted_row["arguments"]


class TestListFolders:
    """list_folders should dispatch through handle_tool_call and return folder data."""

    def test_returns_folder_list(self, monkeypatch):
        """list_folders via handle_tool_call should return folders from _dispatch_tool."""
        from src.tools.handlers import handle_tool_call, ActionInput

        monkeypatch.setattr(
            "src.tools.handlers._dispatch_tool",
            lambda **kwargs: (
                {"folders": [
                    {"path": "[Gmail]/Trash", "name": "Trash", "special_use": "\\Trash"},
                    {"path": "Work", "name": "Work", "special_use": None},
                ]},
                None,
                None,
            ),
        )

        mock_supabase = MagicMock()
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "fake-action-id"}
        ]

        result = handle_tool_call(
            input=ActionInput(
                user_id="test-user",
                session_id="test-session",
                tool_name="list_folders",
                arguments={},
            ),
            user_config={},
            email_ctx=_make_email_ctx(),
            supabase=mock_supabase,
        )

        assert result.status == "executed"
        assert result.result is not None
        assert len(result.result["folders"]) == 2
        assert result.result["folders"][0]["path"] == "[Gmail]/Trash"
        assert result.result["folders"][1]["name"] == "Work"


class TestMoveToFolder:
    """move_to_folder should dispatch through handle_tool_call, return undo recipe,
    and store message_id in the action arguments."""

    def _make_mock_supabase(self, inserted_row: dict) -> MagicMock:
        """Create a mock Supabase client that captures the inserted row."""
        mock_supabase = MagicMock()

        def capture_insert(row):
            inserted_row.update(row)
            mock_response = MagicMock()
            mock_response.data = [{"id": "action-1"}]
            mock_chain = MagicMock()
            mock_chain.execute = MagicMock(return_value=mock_response)
            return mock_chain

        mock_supabase.table.return_value.insert = capture_insert
        return mock_supabase

    def test_move_to_folder_returns_undo_recipe_and_stores_message_id(self, monkeypatch):
        """move_to_folder should return moved:True, undo recipe, and merge message_id."""
        from src.tools.handlers import handle_tool_call, ActionInput, UndoRecipe

        monkeypatch.setattr(
            "src.tools.handlers._dispatch_tool",
            lambda **kwargs: (
                {"moved": True},
                UndoRecipe(operation="move_email", params={"message_id": "<move-test@example.com>", "from": "Dev/Github", "to": "INBOX"}),
                "<move-test@example.com>",
            ),
        )

        inserted_row: dict = {}
        mock_supabase = self._make_mock_supabase(inserted_row)

        result = handle_tool_call(
            input=ActionInput(
                user_id="test-user",
                session_id="test-session",
                tool_name="move_to_folder",
                arguments={"email_id": "55", "folder": "Dev/Github"},
            ),
            user_config={},
            email_ctx=_make_email_ctx(),
            supabase=mock_supabase,
        )

        assert result.status == "executed"
        assert result.result is not None
        assert result.result["moved"] is True
        assert inserted_row["arguments"]["message_id"] == "<move-test@example.com>"
        assert inserted_row["arguments"]["email_id"] == "55"
        assert inserted_row["undo_recipe"]["operation"] == "move_email"
        assert inserted_row["undo_recipe"]["params"]["from"] == "Dev/Github"
        assert inserted_row["undo_recipe"]["params"]["to"] == "INBOX"


class TestWhatCanYouDo:
    """what_can_you_do should return capabilities markdown."""

    def test_returns_capabilities_markdown(self):
        """handle_tool_call with what_can_you_do returns executed status
        and includes capability text."""
        from src.tools.handlers import handle_tool_call, ActionInput

        # Mock Supabase to allow the normal execute-and-store flow
        mock_supabase = MagicMock()
        mock_supabase.table.return_value.insert.return_value.execute.return_value.data = [
            {"id": "fake-action-id"}
        ]

        result = handle_tool_call(
            input=ActionInput(
                user_id="test-user",
                session_id="test-session",
                tool_name="what_can_you_do",
                arguments={},
            ),
            user_config={},
            email_ctx=_make_email_ctx(),
            supabase=mock_supabase,
        )

        assert result.status == "executed"
        assert result.result is not None
        assert "archive" in result.result["markdown"].lower()
        assert "read" in result.result["markdown"].lower()
