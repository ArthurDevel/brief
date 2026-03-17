"""
Langfuse tracing observer for the Pipecat voice pipeline (SDK v4).

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

Langfuse v4 API:
- Root span created via start_observation() (non-context-manager, long-lived)
- Child observations via root.start_observation(as_type=...)
- user_id/session_id set via propagate_attributes()
"""

from __future__ import annotations

import logging
from typing import Any

from langfuse import propagate_attributes
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

        # Langfuse root span (created in start_trace)
        self._root_span: Any = None

        # Accumulator for the current LLM response
        self._response_buffer: list[str] = []
        self._current_user_text: str = ""
        self._in_llm_response: bool = False

        # Pending generation to attach token usage
        self._pending_generation: Any = None

        # propagate_attributes context manager (kept alive for the call)
        self._propagation_ctx: Any = None

    def start_trace(self) -> None:
        """Create a Langfuse trace for this call. Call after session is created."""
        client = get_langfuse_client()

        # Enter propagate_attributes so all child observations inherit user/session
        self._propagation_ctx = propagate_attributes(
            trace_name="voice-call",
            user_id=self._session.user_id,
            session_id=self._session.session_id,
            metadata={
                "transport": self._transport_type,
                "model": LLM_MODEL,
                "voice": self._voice,
            },
        )
        self._propagation_ctx.__enter__()

        # Create a long-lived root span for the entire call
        self._root_span = client.start_observation(
            name="voice-call",
            input={"transport": self._transport_type, "model": LLM_MODEL},
        )

        logger.info(
            "[langfuse] Trace started for session %s",
            self._session.session_id,
        )

    async def on_push_frame(self, data: FramePushed) -> None:
        """Observe pipeline frames for transcript and Langfuse logging.

        Frames fire for every processor-to-processor hop, so we filter by
        source processor to avoid duplicates. We only observe LLM-related
        frames from the LLM service, and transcription from the STT service.
        """
        frame: Frame = data.frame
        source_name = type(data.source).__name__

        # User speech transcription — only from the STT service
        if isinstance(frame, TranscriptionFrame):
            if "STT" in source_name and frame.text and frame.text.strip():
                self._current_user_text = frame.text.strip()
                add_transcript_entry(self._session, "user", self._current_user_text)
            return

        # LLM frames — only from the LLM service to avoid duplicate hops
        if isinstance(frame, LLMFullResponseStartFrame):
            if "LLM" in source_name:
                # End any pending generation from previous turn
                if self._pending_generation is not None:
                    self._pending_generation.end()
                    self._pending_generation = None
                self._in_llm_response = True
                self._response_buffer.clear()
            return

        if isinstance(frame, LLMTextFrame) and self._in_llm_response:
            if "LLM" in source_name:
                self._response_buffer.append(frame.text)
            return

        # LLM response end → flush buffer, log transcript + generation
        if isinstance(frame, LLMFullResponseEndFrame):
            if "LLM" not in source_name:
                return
            self._in_llm_response = False
            assistant_text = "".join(self._response_buffer).strip()
            self._response_buffer.clear()

            if assistant_text:
                add_transcript_entry(self._session, "assistant", assistant_text)

                if self._root_span is not None:
                    self._pending_generation = self._root_span.start_observation(
                        as_type="generation",
                        name="llm-turn",
                        model=LLM_MODEL,
                        input=self._current_user_text or "(greeting)",
                        output=assistant_text,
                    )
            return

        # MetricsFrame with LLMUsageMetricsData → end pending generation
        # (Token counts from streaming are typically 0 for OpenRouter/Gemini;
        # real totals come from the OpenRouter generation API at session end)
        if isinstance(frame, MetricsFrame):
            for metric in frame.data:
                if type(metric).__name__ == "LLMUsageMetricsData" and self._pending_generation is not None:
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
        """Log a tool call as a Langfuse tool observation."""
        if self._root_span is None:
            return

        tool_obs = self._root_span.start_observation(
            as_type="tool",
            name=name,
            input=args,
            output=result,
            metadata={"duration_ms": str(round(duration_ms, 1))},
        )
        tool_obs.end()

    def end_trace(self, cost_summary: CostSummary) -> None:
        """Attach final cost metadata, end root span, and flush. Call at session cleanup."""
        if self._root_span is None:
            return

        # End any pending generation that never got token metrics
        if self._pending_generation is not None:
            self._pending_generation.end()
            self._pending_generation = None

        self._root_span.update(
            output={
                "cost_usd": cost_summary.total_cost,
                "duration_min": cost_summary.duration_min,
                "llm_input_tokens": cost_summary.llm_input_tokens,
                "llm_output_tokens": cost_summary.llm_output_tokens,
                "llm_cost": cost_summary.llm_cost,
                "llm_actual_cost": cost_summary.llm_actual_cost,
                "stt_minutes": cost_summary.stt_minutes,
                "stt_cost": cost_summary.stt_cost,
                "tts_characters": cost_summary.tts_characters,
                "tts_cost": cost_summary.tts_cost,
            },
        )
        self._root_span.end()

        # Exit propagation context
        if self._propagation_ctx is not None:
            self._propagation_ctx.__exit__(None, None, None)
            self._propagation_ctx = None

        client = get_langfuse_client()
        client.flush()

        logger.info(
            "[langfuse] Trace ended for session %s",
            self._session.session_id,
        )
