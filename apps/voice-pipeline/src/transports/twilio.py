"""
Custom Pipecat transport for Twilio bidirectional media streams.

Pipecat has no native Twilio transport. This module extends BaseTransport
with input/output sub-transports that bridge Twilio's mulaw 8kHz JSON
WebSocket protocol to Pipecat's PCM16 frame-based pipeline.

- TwilioTransport: top-level transport with input() and output() accessors
- TwilioInputTransport: reads Twilio JSON from WebSocket, transcodes mulaw
  to PCM16, pushes InputAudioRawFrame into the pipeline
- TwilioOutputTransport: receives PCM16 OutputAudioRawFrame, transcodes to
  mulaw, sends as Twilio JSON over WebSocket
- Handles Twilio "start" (extract streamSid), "stop" (trigger disconnect),
  and "clear" (flush queued audio on interruption) events
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from typing import Optional

from fastapi import WebSocket
from starlette.websockets import WebSocketState

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
    StartFrame,
)
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import BaseTransport, TransportParams

from src.audio.transcoder import mulaw_to_pcm16, pcm16_to_mulaw


logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

TWILIO_SAMPLE_RATE = 8000


# ============================================================================
# TRANSPORT PARAMS
# ============================================================================

class TwilioParams(TransportParams):
    """Transport parameters for Twilio media streams.

    Twilio always uses mulaw at 8kHz. The transcoder handles conversion
    to/from the pipeline's sample rate internally.
    """

    pass


# ============================================================================
# INPUT TRANSPORT
# ============================================================================

class TwilioInputTransport(BaseInputTransport):
    """Reads Twilio JSON messages from a WebSocket and pushes PCM16 audio frames.

    On "media" events: decodes base64 mulaw payload, transcodes to PCM16 at
    the pipeline sample rate, pushes as InputAudioRawFrame.
    On "start" events: extracts and stores the streamSid.
    On "stop" events: triggers pipeline shutdown.
    """

    def __init__(
        self,
        websocket: WebSocket,
        transport: TwilioTransport,
        params: TransportParams,
        **kwargs,
    ) -> None:
        """Initialize the Twilio input transport.

        Args:
            websocket: The FastAPI WebSocket connection from Twilio.
            transport: The parent TwilioTransport instance.
            params: Transport parameters.
        """
        super().__init__(params, **kwargs)
        self._websocket = websocket
        self._transport = transport
        self._receive_task: Optional[asyncio.Task] = None

    async def start(self, frame: StartFrame) -> None:
        """Start the input transport and kick off the WebSocket read loop.

        Args:
            frame: The pipeline start frame with audio configuration.
        """
        await super().start(frame)
        self._receive_task = self.create_task(self._read_loop())

    async def stop(self, frame: EndFrame) -> None:
        """Stop the input transport and cancel the read loop.

        Args:
            frame: The pipeline end frame.
        """
        if self._receive_task:
            self._receive_task.cancel()
            self._receive_task = None
        await super().stop(frame)

    async def cancel(self, frame: CancelFrame) -> None:
        """Cancel the input transport.

        Args:
            frame: The cancel frame.
        """
        if self._receive_task:
            self._receive_task.cancel()
            self._receive_task = None
        await super().cancel(frame)

    async def _read_loop(self) -> None:
        """Read Twilio JSON messages from the WebSocket in a loop.

        Handles three event types:
        - "start": extracts streamSid for later use in clear messages
        - "media": decodes mulaw audio, transcodes to PCM16, pushes frame
        - "stop": signals end of the media stream
        """
        try:
            while True:
                raw = await self._websocket.receive_text()
                message = json.loads(raw)
                event = message.get("event")

                if event == "start":
                    stream_sid = message.get("start", {}).get("streamSid", "")
                    self._transport.stream_sid = stream_sid
                    logger.info("[twilio] Stream started, streamSid=%s", stream_sid)

                elif event == "media":
                    payload_b64 = message.get("media", {}).get("payload", "")
                    if not payload_b64:
                        continue

                    # Decode base64 -> mulaw bytes -> PCM16 at pipeline rate
                    mulaw_bytes = base64.b64decode(payload_b64)
                    pcm16_bytes = mulaw_to_pcm16(mulaw_bytes, self._transport.pipeline_sample_rate)

                    frame = InputAudioRawFrame(
                        audio=pcm16_bytes,
                        sample_rate=self._transport.pipeline_sample_rate,
                        num_channels=1,
                    )
                    await self.push_audio_frame(frame)

                elif event == "stop":
                    logger.info("[twilio] Stream stopped")
                    break

        except asyncio.CancelledError:
            pass
        except Exception as exc:
            logger.error("[twilio] Read loop error: %s", exc)

        # Signal pipeline to shut down
        await self.push_frame(EndFrame())


# ============================================================================
# OUTPUT TRANSPORT
# ============================================================================

class TwilioOutputTransport(BaseOutputTransport):
    """Transcodes PCM16 audio frames to mulaw and sends as Twilio JSON.

    Each OutputAudioRawFrame is downsampled from the pipeline rate to 8kHz,
    encoded as mulaw, base64-encoded, and sent as a Twilio media event.
    """

    def __init__(
        self,
        websocket: WebSocket,
        transport: TwilioTransport,
        params: TransportParams,
        **kwargs,
    ) -> None:
        """Initialize the Twilio output transport.

        Args:
            websocket: The FastAPI WebSocket connection to Twilio.
            transport: The parent TwilioTransport instance.
            params: Transport parameters.
        """
        super().__init__(params, **kwargs)
        self._websocket = websocket
        self._transport = transport

    async def write_audio_frame(self, frame: OutputAudioRawFrame) -> bool:
        """Transcode a PCM16 frame to mulaw and send as Twilio JSON.

        Args:
            frame: The PCM16 audio frame from the pipeline.

        Returns:
            True if the frame was sent successfully, False otherwise.
        """
        if self._websocket.client_state != WebSocketState.CONNECTED:
            return False

        # Transcode PCM16 -> mulaw 8kHz
        mulaw_bytes = pcm16_to_mulaw(frame.audio, frame.sample_rate)
        payload_b64 = base64.b64encode(mulaw_bytes).decode("ascii")

        message = json.dumps({
            "event": "media",
            "streamSid": self._transport.stream_sid,
            "media": {
                "payload": payload_b64,
            },
        })

        try:
            await self._websocket.send_text(message)
            return True
        except Exception as exc:
            logger.error("[twilio] Failed to send audio: %s", exc)
            return False

    async def send_clear(self) -> None:
        """Send a clear event to flush queued audio on the Twilio side.

        Called when the pipeline detects a user interruption via VAD to
        stop playback immediately on the phone.
        """
        if not self._transport.stream_sid:
            logger.warning("[twilio] Cannot send clear: no streamSid")
            return

        if self._websocket.client_state != WebSocketState.CONNECTED:
            return

        message = json.dumps({
            "event": "clear",
            "streamSid": self._transport.stream_sid,
        })

        try:
            await self._websocket.send_text(message)
            logger.debug("[twilio] Sent clear for streamSid=%s", self._transport.stream_sid)
        except Exception as exc:
            logger.error("[twilio] Failed to send clear: %s", exc)


# ============================================================================
# MAIN TRANSPORT
# ============================================================================

class TwilioTransport(BaseTransport):
    """Top-level Pipecat transport for Twilio bidirectional media streams.

    Wraps a FastAPI WebSocket connection and provides input/output
    sub-transports that handle mulaw/PCM16 transcoding transparently.
    """

    def __init__(
        self,
        websocket: WebSocket,
        params: TransportParams,
        pipeline_sample_rate: int = 16000,
    ) -> None:
        """Initialize the Twilio transport.

        Args:
            websocket: The FastAPI WebSocket connection from Twilio.
            params: Transport parameters for the pipeline.
            pipeline_sample_rate: The sample rate the pipeline operates at.
                Mulaw 8kHz is transcoded to/from this rate internally.
        """
        super().__init__()
        self._websocket = websocket
        self._params = params
        self.stream_sid: str = ""
        self.pipeline_sample_rate: int = pipeline_sample_rate

        self._input = TwilioInputTransport(
            websocket=websocket,
            transport=self,
            params=params,
            name="TwilioInput",
        )
        self._output = TwilioOutputTransport(
            websocket=websocket,
            transport=self,
            params=params,
            name="TwilioOutput",
        )

    def input(self) -> TwilioInputTransport:
        """Get the input transport for reading Twilio audio.

        Returns:
            The TwilioInputTransport instance.
        """
        return self._input

    def output(self) -> TwilioOutputTransport:
        """Get the output transport for writing Twilio audio.

        Returns:
            The TwilioOutputTransport instance.
        """
        return self._output
