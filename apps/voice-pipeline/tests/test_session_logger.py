"""
Tests for per-session log capture via session_logger.

Verifies that:
- Logs within a session context are captured and retrievable
- Logs outside any session context are not buffered
- Concurrent sessions capture their own logs independently
- upload_session_logs swallows exceptions and does not raise
- stop() for unknown session returns empty string
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Generator
from unittest.mock import MagicMock

import pytest  # type: ignore[import-untyped]
from loguru import logger

from src import session_logger


# ============================================================================
# FIXTURES
# ============================================================================

@pytest.fixture(autouse=True)
def install_session_logger() -> Generator[None, None, None]:
    """Install session_logger before each test, uninstall after."""
    session_logger.install()
    yield
    session_logger.uninstall()
    # Clear any leftover buffers between tests
    session_logger._buffers.clear()


# ============================================================================
# TESTS
# ============================================================================

def test_logs_within_session_are_captured() -> None:
    """Logs emitted while a session is active are captured and returned by stop().

    Starts a session, emits log lines via both loguru and stdlib logging,
    calls stop(), and verifies the returned text contains the emitted messages.
    """
    session_id = "test-session-capture"
    session_logger.start(session_id)

    # Emit via loguru
    logger.info("loguru hello from session")

    # Emit via stdlib logging
    stdlib_logger = logging.getLogger("test_capture")
    stdlib_logger.setLevel(logging.DEBUG)
    stdlib_logger.info("stdlib hello from session")

    log_text = session_logger.stop(session_id)

    assert "loguru hello from session" in log_text
    assert "stdlib hello from session" in log_text


def test_logs_outside_session_not_buffered() -> None:
    """Logs emitted without an active session are not buffered.

    Emits log lines without calling start(). Verifies that the internal
    _buffers dict remains empty.
    """
    logger.info("this should not be buffered")

    stdlib_logger = logging.getLogger("test_outside")
    stdlib_logger.setLevel(logging.DEBUG)
    stdlib_logger.info("this should also not be buffered")

    assert len(session_logger._buffers) == 0


def test_preformatted_lines_can_be_appended() -> None:
    """Pre-session markers can be buffered and appended after start()."""
    session_id = "test-pre-session-lines"
    line = session_logger.make_log_line(
        level="INFO",
        module="test_session_logger",
        message="[startup] before session existed",
        timestamp=datetime(2026, 4, 10, 12, 0, 0, 123000, tzinfo=timezone.utc),
    )

    session_logger.start(session_id)
    session_logger.append_lines(session_id, [line])
    log_text = session_logger.stop(session_id)

    assert "2026-04-10 12:00:00.123 INFO [test_session_logger] [startup] before session existed" in log_text


@pytest.mark.asyncio
async def test_concurrent_sessions_independent() -> None:
    """Concurrent sessions capture their own logs independently.

    Starts two sessions in separate asyncio tasks, emits distinct log
    messages in each, stops both, and verifies each session's returned
    log text contains only its own messages.
    """
    session_a = "session-alpha"
    session_b = "session-beta"

    async def task_a() -> str:
        session_logger.start(session_a)
        logger.info("message from alpha")
        # Small yield to let task_b run
        await asyncio.sleep(0)
        return session_logger.stop(session_a)

    async def task_b() -> str:
        session_logger.start(session_b)
        logger.info("message from beta")
        await asyncio.sleep(0)
        return session_logger.stop(session_b)

    result_a, result_b = await asyncio.gather(
        asyncio.create_task(task_a()),
        asyncio.create_task(task_b()),
    )

    assert "message from alpha" in result_a
    assert "message from beta" not in result_a

    assert "message from beta" in result_b
    assert "message from alpha" not in result_b


@pytest.mark.asyncio
async def test_upload_swallows_exceptions() -> None:
    """upload_session_logs swallows exceptions and does not raise.

    Calls upload_session_logs with a mock Supabase client whose upload
    raises a RuntimeError. Verifies no exception propagates.
    """
    mock_supabase = MagicMock()
    mock_supabase.storage.from_.return_value.upload.side_effect = RuntimeError(
        "storage unavailable"
    )

    # This must not raise
    await session_logger.upload_session_logs(
        session_id="test-upload-fail",
        log_text="some log content",
        supabase=mock_supabase,
    )


def test_stop_unknown_session_returns_empty() -> None:
    """stop() for an unknown session_id returns empty string without raising."""
    result = session_logger.stop("nonexistent-session-id")

    assert result == ""
