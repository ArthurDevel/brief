"""
Tests for TwilioOutputTransport interruption handling.

Verifies that the Twilio transport sends a "clear" event to flush
Twilio's server-side audio buffer when the pipeline detects a user
interruption.

Responsibilities:
- Verify send_clear() sends correct JSON when streamSid is set
- Verify send_clear() does nothing when streamSid is missing
- Verify process_frame calls send_clear() on InterruptionFrame
"""

from __future__ import annotations

import json
from typing import Any, cast
from unittest.mock import AsyncMock, patch

import pytest  # type: ignore[import-untyped]

from pipecat.frames.frames import InterruptionFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.transports.base_transport import TransportParams
from starlette.websockets import WebSocketState

from src.transports.twilio import TwilioOutputTransport, TwilioTransport


# ============================================================================
# FIXTURES
# ============================================================================

def _make_transport_and_output(stream_sid: str = "") -> tuple[TwilioTransport, TwilioOutputTransport, AsyncMock]:
    """Create a TwilioTransport with a mock WebSocket for testing.

    Args:
        stream_sid: The stream SID to set on the transport.

    Returns:
        Tuple of (TwilioTransport, TwilioOutputTransport, mock_websocket).
    """
    mock_ws = AsyncMock()
    mock_ws.client_state = WebSocketState.CONNECTED

    transport = TwilioTransport(
        websocket=cast(Any, mock_ws),
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    transport.stream_sid = stream_sid

    return transport, transport.output(), mock_ws


# ============================================================================
# TESTS: send_clear
# ============================================================================

@pytest.mark.asyncio
async def test_send_clear_sends_clear_event_with_stream_sid() -> None:
    """send_clear() sends a clear JSON message with the correct streamSid."""
    _, output, mock_ws = _make_transport_and_output(stream_sid="MZ123abc")

    await output.send_clear()

    mock_ws.send_text.assert_called_once()
    sent_message = json.loads(mock_ws.send_text.call_args[0][0])
    assert sent_message == {"event": "clear", "streamSid": "MZ123abc"}


@pytest.mark.asyncio
async def test_send_clear_does_nothing_without_stream_sid() -> None:
    """send_clear() does not send a WebSocket message when streamSid is empty."""
    _, output, mock_ws = _make_transport_and_output(stream_sid="")

    await output.send_clear()

    mock_ws.send_text.assert_not_called()


# ============================================================================
# TESTS: process_frame interruption
# ============================================================================

@pytest.mark.asyncio
async def test_process_frame_calls_send_clear_on_interruption() -> None:
    """process_frame() calls send_clear() when it receives an InterruptionFrame."""
    _, output, _ = _make_transport_and_output(stream_sid="MZ456def")

    with patch.object(output, "send_clear", new_callable=AsyncMock) as mock_clear, \
         patch("pipecat.transports.base_output.BaseOutputTransport.process_frame", new_callable=AsyncMock):
        frame = InterruptionFrame()
        await output.process_frame(frame, FrameDirection.DOWNSTREAM)

        mock_clear.assert_called_once()
