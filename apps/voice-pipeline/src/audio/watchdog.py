"""
Audio frame watchdog that cancels the pipeline when audio input stops.

Detects broken WebRTC/transport connections by monitoring incoming audio
frames. If no InputAudioRawFrame arrives for a configurable timeout,
the pipeline task is cancelled, triggering normal cleanup.

- AudioFrameWatchdog: FrameProcessor that monitors audio frame arrival
"""

from __future__ import annotations

import asyncio
import logging
import time

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    StartFrame,
)
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

AUDIO_TIMEOUT_SECS = 10.0


# ============================================================================
# MAIN PROCESSOR
# ============================================================================

class AudioFrameWatchdog(FrameProcessor):
    """Monitors incoming audio frames and cancels the pipeline if they stop arriving.

    Passes all frames through unchanged. A background task checks whether
    the last audio frame arrived within the timeout window. When the timeout
    is exceeded, it cancels the pipeline task (triggering normal cleanup).
    """

    def __init__(self, timeout_secs: float = AUDIO_TIMEOUT_SECS) -> None:
        """Initialize the watchdog.

        Args:
            timeout_secs: Seconds without audio before cancelling.
        """
        super().__init__()
        self._task: PipelineTask | None = None
        self._timeout_secs = timeout_secs
        self._last_audio_time: float = 0.0
        self._monitor_task: asyncio.Task | None = None

    def set_task(self, task: PipelineTask) -> None:
        """Set the pipeline task to cancel on timeout. Must be called before the pipeline runs.

        Args:
            task: The PipelineTask to cancel when audio stops.
        """
        self._task = task

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Process a pipeline frame. Tracks audio frame timestamps.

        Args:
            frame: The pipeline frame.
            direction: The direction the frame is traveling.
        """
        await super().process_frame(frame, direction)

        if isinstance(frame, StartFrame):
            self._last_audio_time = time.monotonic()
            self._monitor_task = asyncio.create_task(self._monitor_loop())

        # Only stop the monitor on CancelFrame (pipeline is truly shutting down).
        # EndFrame may get stuck downstream and never complete the shutdown,
        # so the watchdog stays active as a safety net.
        if isinstance(frame, CancelFrame):
            self._stop_monitor()

        if isinstance(frame, InputAudioRawFrame):
            self._last_audio_time = time.monotonic()

        await self.push_frame(frame, direction)

    async def _monitor_loop(self) -> None:
        """Background loop that checks for audio frame timeout."""
        while True:
            await asyncio.sleep(self._timeout_secs)

            elapsed = time.monotonic() - self._last_audio_time
            if elapsed >= self._timeout_secs:
                if self._task is None:
                    logger.error("[watchdog] No PipelineTask set, cannot cancel")
                    return
                logger.warning(
                    "[watchdog] No audio frame received for %.1fs, cancelling pipeline",
                    elapsed,
                )
                await self._task.cancel()
                return

    def _stop_monitor(self) -> None:
        """Cancel the background monitor task."""
        if self._monitor_task and not self._monitor_task.done():
            self._monitor_task.cancel()
            self._monitor_task = None
