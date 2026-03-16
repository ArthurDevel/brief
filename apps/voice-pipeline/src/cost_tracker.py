"""
Cost tracking observer for the Pipecat voice pipeline.

Accumulates STT audio duration, LLM token usage, and TTS character counts
by observing pipeline frames, then calculates a final cost breakdown.

- CostSummary: dataclass with all cost fields
- CostTracker: Pipecat BaseObserver subclass that counts usage from frames
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    MetricsFrame,
)
from pipecat.observers.base_observer import BaseObserver
from pipecat.observers.base_observer import FramePushed

from src.config import PRICING


logger = logging.getLogger(__name__)


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class CostSummary:
    """Final cost breakdown for a voice session."""

    duration_min: float
    llm_input_tokens: int
    llm_output_tokens: int
    llm_cost: float
    tts_characters: int
    tts_cost: float
    stt_minutes: float
    stt_cost: float
    total_cost: float
    cost_per_min: float


# ============================================================================
# MAIN LOGIC
# ============================================================================

class CostTracker(BaseObserver):
    """Pipecat BaseObserver subclass that tracks cost-related metrics.

    Observes pipeline frames to count:
    - STT audio seconds from InputAudioRawFrame
    - LLM tokens from LLMUsageMetricsData in MetricsFrame
    - TTS characters from TTSUsageMetricsData in MetricsFrame
    """

    def __init__(self) -> None:
        """Initialize counters."""
        super().__init__()
        self._stt_audio_seconds: float = 0.0
        self._llm_input_tokens: int = 0
        self._llm_output_tokens: int = 0
        self._tts_characters: int = 0
        self._start_time: float = time.time()

    async def on_push_frame(self, data: FramePushed) -> None:
        """Observe pipeline frames and accumulate usage metrics.

        Counts:
        - STT audio duration from InputAudioRawFrame (bytes / sample_rate / 2)
        - LLM tokens from LLMUsageMetricsData in MetricsFrame
        - TTS characters from TTSUsageMetricsData in MetricsFrame (authoritative source)

        Args:
            data: The FramePushed event containing the frame.
        """
        frame: Frame = data.frame

        # Count STT audio seconds from input audio frames
        if isinstance(frame, InputAudioRawFrame):
            # int16 PCM: 2 bytes per sample
            duration_s = len(frame.audio) / (frame.sample_rate * 2 * frame.num_channels)
            self._stt_audio_seconds += duration_s
            return

        # Count LLM tokens and TTS characters from metrics frames
        if isinstance(frame, MetricsFrame):
            for metric in frame.data:
                metric_class = type(metric).__name__

                if metric_class == "LLMUsageMetricsData":
                    self._llm_input_tokens += getattr(metric, "prompt_tokens", 0)
                    self._llm_output_tokens += getattr(metric, "completion_tokens", 0)

                elif metric_class == "TTSUsageMetricsData":
                    self._tts_characters += getattr(metric, "characters", 0)

    def get_summary(self) -> CostSummary:
        """Calculate the final cost breakdown using per-provider pricing.

        Returns:
            CostSummary with all cost fields populated.
        """
        elapsed_min = (time.time() - self._start_time) / 60.0
        stt_minutes = self._stt_audio_seconds / 60.0

        llm_cost = (
            self._llm_input_tokens * PRICING.LLM_COST_PER_INPUT_TOKEN
            + self._llm_output_tokens * PRICING.LLM_COST_PER_OUTPUT_TOKEN
        )
        tts_cost = self._tts_characters * PRICING.TTS_COST_PER_CHAR
        stt_cost = stt_minutes * PRICING.STT_COST_PER_MINUTE
        total_cost = llm_cost + tts_cost + stt_cost
        cost_per_min = total_cost / elapsed_min if elapsed_min > 0 else 0.0

        summary = CostSummary(
            duration_min=round(elapsed_min, 2),
            llm_input_tokens=self._llm_input_tokens,
            llm_output_tokens=self._llm_output_tokens,
            llm_cost=round(llm_cost, 6),
            tts_characters=self._tts_characters,
            tts_cost=round(tts_cost, 6),
            stt_minutes=round(stt_minutes, 2),
            stt_cost=round(stt_cost, 6),
            total_cost=round(total_cost, 6),
            cost_per_min=round(cost_per_min, 6),
        )

        logger.info(
            "[cost_tracker] Summary: %.2f min, %d in/%d out tokens, %d TTS chars, $%.4f total",
            summary.duration_min,
            summary.llm_input_tokens,
            summary.llm_output_tokens,
            summary.tts_characters,
            summary.total_cost,
        )

        return summary
