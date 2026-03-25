"""
Per-session log capture for the voice pipeline.

Intercepts log output from both loguru and stdlib logging, attributes each
line to the active voice session via a ContextVar, and buffers it in memory.
On session end, the buffered text can be uploaded to Supabase Storage.

- Captures logs from both loguru sinks and stdlib logging handlers
- Uses contextvars to isolate logs per concurrent session
- Uploads session logs to Supabase Storage as .log files
- Never crashes or blocks the pipeline on failure

NOTE: Requires Python 3.12+ because asyncio.to_thread only propagates
contextvars.Context into spawned threads from 3.12 onwards. The project
uses python:3.12-slim in Docker. Do not downgrade without addressing this.
"""

from __future__ import annotations

import logging
from contextvars import ContextVar
from datetime import datetime, timezone

from loguru import logger
from supabase import Client


# ============================================================================
# CONSTANTS
# ============================================================================

STORAGE_BUCKET = "session-logs"
MAX_LINES = 50_000
LOG_FORMAT = "{timestamp} {level} [{module}] {message}"


# ============================================================================
# MODULE-LEVEL STATE
# ============================================================================

_buffers: dict[str, list[str]] = {}
_current_session_id: ContextVar[str | None] = ContextVar(
    "_current_session_id", default=None
)

# Tracks whether install() has been called, and stores the loguru sink ID
# and stdlib handler instance so they can be removed in uninstall().
_loguru_sink_id: int | None = None
_stdlib_handler: _SessionLogHandler | None = None


# ============================================================================
# PUBLIC API
# ============================================================================

def install() -> None:
    """Install the loguru sink and stdlib logging handler for session capture.

    Safe to call multiple times -- subsequent calls are no-ops.
    """
    global _loguru_sink_id, _stdlib_handler

    if _loguru_sink_id is not None:
        return

    _loguru_sink_id = logger.add(_loguru_sink, format="{message}", level="DEBUG")

    _stdlib_handler = _SessionLogHandler()
    _stdlib_handler.setLevel(logging.DEBUG)
    root = logging.getLogger()
    root.addHandler(_stdlib_handler)
    # Root logger defaults to WARNING; lower it so INFO records reach the handler
    if root.level > logging.INFO:
        root.setLevel(logging.INFO)


def uninstall() -> None:
    """Remove the loguru sink and stdlib logging handler.

    Intended for test teardown.
    """
    global _loguru_sink_id, _stdlib_handler

    if _loguru_sink_id is not None:
        logger.remove(_loguru_sink_id)
        _loguru_sink_id = None

    if _stdlib_handler is not None:
        logging.getLogger().removeHandler(_stdlib_handler)
        _stdlib_handler = None


def start(session_id: str) -> None:
    """Begin capturing logs for a session.

    Creates a buffer for the session and sets the ContextVar so that
    downstream log lines are attributed to this session.

    Args:
        session_id: Unique identifier for the voice session.
    """
    _buffers[session_id] = []
    _current_session_id.set(session_id)


def stop(session_id: str) -> str:
    """Stop capturing logs for a session and return the accumulated text.

    Works by dict lookup (NOT by reading the ContextVar) so it can be
    called from a different async task (e.g. lifespan shutdown for orphan
    cleanup).

    Clears the ContextVar only if it currently holds the given session_id.

    Args:
        session_id: Unique identifier for the voice session.

    Returns:
        The accumulated log text as a single string, or empty string if
        the session_id was not found.
    """
    buffer = _buffers.pop(session_id, None)
    if buffer is None:
        return ""

    # Only clear the ContextVar if it belongs to this session
    if _current_session_id.get(None) == session_id:
        _current_session_id.set(None)

    return "\n".join(buffer)


async def upload_session_logs(
    session_id: str, log_text: str, supabase: Client
) -> None:
    """Upload session log text to Supabase Storage.

    Swallows ALL exceptions so that upload failure never crashes or blocks
    the voice pipeline.

    Args:
        session_id: Unique identifier for the voice session.
        log_text: The full log text to upload.
        supabase: Supabase client instance.
    """
    try:
        file_path = f"{session_id}.log"
        supabase.storage.from_(STORAGE_BUCKET).upload(
            path=file_path,
            file=log_text.encode("utf-8"),
            file_options={"content-type": "text/plain"},
        )
    except Exception:
        pass


# ============================================================================
# INTERNAL HELPERS
# ============================================================================

def _handle_log_line(session_id: str, formatted_line: str) -> None:
    """Append a formatted log line to the session's buffer.

    Returns early if the session_id is not in the dict (session already
    stopped or never started) or if the buffer has reached MAX_LINES.

    Args:
        session_id: The session to attribute this line to.
        formatted_line: The pre-formatted log line string.
    """
    buffer = _buffers.get(session_id)
    if buffer is None:
        return

    if len(buffer) >= MAX_LINES:
        return

    buffer.append(formatted_line)


def _format_line(timestamp: str, level: str, module: str, message: str) -> str:
    """Format a log line using the shared LOG_FORMAT.

    Args:
        timestamp: ISO-format timestamp string.
        level: Log level name (e.g. "INFO").
        module: Source module name.
        message: The log message.

    Returns:
        A formatted log line string.
    """
    return LOG_FORMAT.format(
        timestamp=timestamp,
        level=level,
        module=module,
        message=message,
    )


def _loguru_sink(message) -> None:
    """Loguru sink function that captures log lines into session buffers.

    Reads the ContextVar to determine which session buffer to write to.
    If no session is active, does nothing.

    Args:
        message: Loguru Message object.
    """
    session_id = _current_session_id.get(None)
    if session_id is None:
        return

    record = message.record
    formatted_line = _format_line(
        timestamp=record["time"].strftime("%Y-%m-%d %H:%M:%S.%f")[:-3],
        level=record["level"].name,
        module=record["module"],
        message=record["message"],
    )
    _handle_log_line(session_id, formatted_line)


class _SessionLogHandler(logging.Handler):
    """Stdlib logging handler that captures log lines into session buffers.

    Reads the ContextVar to determine which session buffer to write to.
    If no session is active, does nothing.
    """

    def emit(self, record: logging.LogRecord) -> None:
        """Process a log record by appending it to the active session buffer.

        Args:
            record: The stdlib LogRecord to capture.
        """
        session_id = _current_session_id.get(None)
        if session_id is None:
            return

        timestamp = datetime.fromtimestamp(
            record.created, tz=timezone.utc
        ).strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]

        formatted_line = _format_line(
            timestamp=timestamp,
            level=record.levelname,
            module=record.module,
            message=record.getMessage(),
        )
        _handle_log_line(session_id, formatted_line)
