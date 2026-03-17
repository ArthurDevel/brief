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

from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.openai.llm import OpenAILLMService


logger = logging.getLogger(__name__)


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

    def __init__(self, usage_tracker: UsageTracker, **kwargs):
        super().__init__(**kwargs)
        self._usage_tracker = usage_tracker

    async def get_chat_completions(self, params_from_context):
        chunks = await super().get_chat_completions(params_from_context)
        return self._wrap_chunks(chunks)

    async def _wrap_chunks(self, chunks):
        captured = False
        async for chunk in chunks:
            if not captured and hasattr(chunk, "id") and chunk.id:
                self._usage_tracker.log_llm_generation(chunk.id)
                captured = True
            yield chunk


class TrackedDeepgramTTSService(DeepgramTTSService):
    """DeepgramTTSService that counts characters sent for synthesis."""

    def __init__(self, usage_tracker: UsageTracker, **kwargs):
        super().__init__(**kwargs)
        self._usage_tracker = usage_tracker

    async def run_tts(self, text: str, context_id: str):
        self._usage_tracker.add_tts_characters(len(text))
        async for frame in super().run_tts(text, context_id):
            yield frame
