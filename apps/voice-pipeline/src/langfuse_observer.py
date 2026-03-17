"""
Langfuse tracing observer for the Pipecat voice pipeline.

A single BaseObserver that handles:
- Creating a Langfuse trace per call (with user_id, session_id)
- Logging LLM generations (input/output text + token usage)
- Logging tool calls as tool spans
- Recording transcript entries on the ActiveSession

Frame observation strategy:
- TranscriptionFrame         → user utterance → transcript entry
- LLMFullResponseStartFrame  → begin accumulating assistant text
- LLMTextFrame               → append to response buffer
- LLMFullResponseEndFrame    → flush buffer → transcript entry + Langfuse generation
- MetricsFrame (LLMUsage)    → attach token usage to current generation
"""

from __future__ import annotations

import logging
import time
from typing import Any

from pipecat.frames.frames import (
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    MetricsFrame,
    TranscriptionFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed

from src.config import LLM_MODEL
from src.cost_tracker import CostSummary
from src.langfuse_client import get_langfuse_client
from src.session import ActiveSession, add_transcript_entry


logger = logging.getLogger(__name__)


class LangfuseObserver(BaseObserver):
    """Pipecat observer that traces pipeline activity to Langfuse
    and records transcript entries on the ActiveSession."""

    def __init__(self, session: ActiveSession, transport_type: str, voice: str) -> None:
        super().__init__()
        self._session = session
        self._transport_type = transport_type
        self._voice = voice

        # Langfuse trace (created in start_trace)
        self._trace: Any = None

        # Accumulator for the current LLM response
        self._response_buffer: list[str] = []
        self._current_user_text: str = ""
        self._in_llm_response: bool = False

        # Pending generation to attach token usage
        self._pending_generation: Any = None

    def start_trace(self) -> None:
        """Create a Langfuse trace for this call. Call after session is created."""
        client = get_langfuse_client()
        self._trace = client.trace(
            name="voice-call",
            user_id=self._session.user_id,
            session_id=self._session.session_id,
            metadata={
                "transport": self._transport_type,
                "model": LLM_MODEL,
                "voice": self._voice,
            },
        )
        logger.info(
            "[langfuse] Trace started for session %s",
            self._session.session_id,
        )

    async def on_push_frame(self, data: FramePushed) -> None:
        """Observe pipeline frames for transcript and Langfuse logging."""
        frame: Frame = data.frame

        # User speech transcription (final only)
        if isinstance(frame, TranscriptionFrame):
            if frame.text and frame.text.strip():
                self._current_user_text = frame.text.strip()
                add_transcript_entry(self._session, "user", self._current_user_text)
            return

        # LLM response start
        if isinstance(frame, LLMFullResponseStartFrame):
            self._in_llm_response = True
            self._response_buffer.clear()
            return

        # LLM response text chunk
        if isinstance(frame, LLMTextFrame) and self._in_llm_response:
            self._response_buffer.append(frame.text)
            return

        # LLM response end → flush buffer, log transcript + generation
        if isinstance(frame, LLMFullResponseEndFrame):
            self._in_llm_response = False
            assistant_text = "".join(self._response_buffer).strip()
            self._response_buffer.clear()

            if assistant_text:
                add_transcript_entry(self._session, "assistant", assistant_text)

                if self._trace is not None:
                    self._pending_generation = self._trace.generation(
                        name="llm-turn",
                        model=LLM_MODEL,
                        input=self._current_user_text,
                        output=assistant_text,
                    )
            return

        # Token usage from MetricsFrame → attach to pending generation
        if isinstance(frame, MetricsFrame):
            for metric in frame.data:
                metric_class = type(metric).__name__
                if metric_class == "LLMUsageMetricsData" and self._pending_generation is not None:
                    prompt_tokens = getattr(metric, "prompt_tokens", 0)
                    completion_tokens = getattr(metric, "completion_tokens", 0)
                    self._pending_generation.update(
                        usage_details={
                            "input": prompt_tokens,
                            "output": completion_tokens,
                        },
                    )
                    self._pending_generation.end()
                    self._pending_generation = None
            return

    def log_tool_call(
        self,
        name: str,
        args: dict[str, Any],
        result: dict[str, Any],
        duration_ms: float,
    ) -> None:
        """Log a tool call as a Langfuse span."""
        if self._trace is None:
            return

        span = self._trace.span(
            name=name,
            input=args,
            output=result,
            metadata={"duration_ms": round(duration_ms, 1)},
        )
        span.end()

    def end_trace(self, cost_summary: CostSummary) -> None:
        """Attach final cost metadata and flush. Call at session cleanup."""
        if self._trace is None:
            return

        # End any pending generation that never got token metrics
        if self._pending_generation is not None:
            self._pending_generation.end()
            self._pending_generation = None

        self._trace.update(
            metadata={
                "transport": self._transport_type,
                "model": LLM_MODEL,
                "voice": self._voice,
                "cost_usd": cost_summary.total_cost,
                "duration_min": cost_summary.duration_min,
                "llm_input_tokens": cost_summary.llm_input_tokens,
                "llm_output_tokens": cost_summary.llm_output_tokens,
                "llm_cost": cost_summary.llm_cost,
                "stt_minutes": cost_summary.stt_minutes,
                "stt_cost": cost_summary.stt_cost,
                "tts_characters": cost_summary.tts_characters,
                "tts_cost": cost_summary.tts_cost,
            },
        )

        client = get_langfuse_client()
        client.flush()

        logger.info(
            "[langfuse] Trace ended for session %s",
            self._session.session_id,
        )
