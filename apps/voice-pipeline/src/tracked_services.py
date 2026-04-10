"""
Tracked service subclasses for actual cost tracking.

OpenRouter doesn't return streaming usage for Gemini models, and Deepgram TTS
doesn't emit TTSUsageMetricsData through Pipecat's observer system. These
subclasses capture data at the source:

- TrackedOpenAILLMService: captures OpenRouter generation IDs from streaming chunks
- TrackedDeepgramTTSService: counts characters sent to TTS

Actual LLM costs are fetched post-hoc from OpenRouter's generation API.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from pipecat.frames.frames import ErrorFrame, TTSSpeakFrame
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.openai.llm import OpenAILLMService


logger = logging.getLogger(__name__)


LLM_ERROR_FALLBACK_MESSAGE = (
    "Sorry, the assistant is temporarily unavailable. Please try again soon."
)


class UsageTracker:
    """Accumulates usage metrics during a voice session."""

    def __init__(self) -> None:
        self._llm_gen_ids: list[str] = []
        self._llm_seen: set[str] = set()
        self._tts_characters: int = 0
        self._session_start: float = time.monotonic()

    def log_llm_generation(self, gen_id: str) -> None:
        if gen_id in self._llm_seen:
            return
        self._llm_seen.add(gen_id)
        self._llm_gen_ids.append(gen_id)
        logger.debug("[usage_tracker] LLM generation: %s", gen_id)

    def add_tts_characters(self, num_chars: int) -> None:
        self._tts_characters += num_chars

    @property
    def llm_gen_ids(self) -> list[str]:
        return self._llm_gen_ids

    @property
    def tts_characters(self) -> int:
        return self._tts_characters

    @property
    def session_duration_secs(self) -> float:
        return time.monotonic() - self._session_start


class TrackedOpenAILLMService(OpenAILLMService):
    """OpenAILLMService that captures generation IDs from streamed chunks."""

    def __init__(
        self,
        usage_tracker: UsageTracker,
        error_fallback_message: str | None = LLM_ERROR_FALLBACK_MESSAGE,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._usage_tracker = usage_tracker
        self._error_fallback_message = error_fallback_message

    async def get_chat_completions(self, params_from_context) -> Any:
        chunks = await super().get_chat_completions(params_from_context)
        return self._wrap_chunks(chunks)

    async def _wrap_chunks(self, chunks):
        captured = False
        async for chunk in chunks:
            if not captured and hasattr(chunk, "id") and chunk.id:
                self._usage_tracker.log_llm_generation(chunk.id)
                captured = True
            yield chunk

    async def push_error_frame(self, error: ErrorFrame) -> None:
        """Speak a fallback message when the LLM fails.

        Pipecat forwards non-fatal LLM errors upstream for logging, but nothing
        audible reaches the caller. A short TTS frame keeps phone/WebRTC users
        from hearing silence when the provider rejects a request.
        """
        if self._error_fallback_message:
            try:
                await self.push_frame(TTSSpeakFrame(
                    self._error_fallback_message,
                    append_to_context=False,
                ))
            except Exception as exc:
                logger.warning("[llm] Failed to queue error fallback speech: %s", exc)

        await super().push_error_frame(error)


class TrackedDeepgramTTSService(DeepgramTTSService):
    """DeepgramTTSService that counts characters sent for synthesis."""

    def __init__(self, usage_tracker: UsageTracker, **kwargs):
        super().__init__(**kwargs)
        self._usage_tracker = usage_tracker

    async def run_tts(self, text: str, context_id: str):
        self._usage_tracker.add_tts_characters(len(text))
        async for frame in super().run_tts(text, context_id):
            yield frame
