"""
Cost tracking observer for the Pipecat voice pipeline.

Accumulates STT audio duration from pipeline frames, and reads LLM generation
IDs and TTS character counts from the UsageTracker (populated by tracked
service subclasses). Actual LLM costs are fetched post-hoc from OpenRouter's
generation API.

- CostSummary: dataclass with all cost fields
- CostTracker: Pipecat BaseObserver subclass that counts usage from frames
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

import httpx
from pipecat.observers.base_observer import BaseObserver, FramePushed

from src.config import (
    OPENROUTER_COST_MAX_RETRIES,
    OPENROUTER_COST_RETRY_DELAY,
    OPENROUTER_GENERATION_URL,
    PRICING,
)
from src.tracked_services import UsageTracker


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
    llm_actual_cost: float  # from OpenRouter API (0 if unavailable)
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

    Observes pipeline frames to count STT audio seconds from InputAudioRawFrame.
    LLM token counts and TTS character counts come from the UsageTracker
    (populated by TrackedOpenAILLMService and TrackedDeepgramTTSService).
    """

    def __init__(self, usage_tracker: UsageTracker) -> None:
        super().__init__()
        self._usage_tracker = usage_tracker
        self._llm_input_tokens: int = 0
        self._llm_output_tokens: int = 0
        self._llm_actual_cost: float = 0.0
        self._start_time: float = time.time()

    async def on_push_frame(self, data: FramePushed) -> None:
        """Observe pipeline frames (currently a no-op, metrics come from UsageTracker)."""
        pass

    async def fetch_llm_costs(self, openrouter_api_key: str) -> None:
        """Fetch actual LLM costs and token counts from OpenRouter's generation API.

        Called at session end, before get_summary(). Parallelizes requests
        across all generation IDs.
        """
        gen_ids = self._usage_tracker.llm_gen_ids
        if not gen_ids:
            logger.info("[cost_tracker] No LLM generation IDs to fetch costs for")
            return

        logger.info("[cost_tracker] Fetching costs for %d LLM generations", len(gen_ids))

        async with httpx.AsyncClient(timeout=15) as client:
            tasks = [
                self._fetch_single_generation(client, openrouter_api_key, gen_id)
                for gen_id in gen_ids
            ]
            results = await asyncio.gather(*tasks)

        for cost, input_tokens, output_tokens in results:
            self._llm_actual_cost += cost
            self._llm_input_tokens += input_tokens
            self._llm_output_tokens += output_tokens

        logger.info(
            "[cost_tracker] LLM actual cost: $%.6f (%d in / %d out tokens)",
            self._llm_actual_cost,
            self._llm_input_tokens,
            self._llm_output_tokens,
        )

    async def _fetch_single_generation(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        gen_id: str,
    ) -> tuple[float, int, int]:
        """Fetch cost and token counts for a single OpenRouter generation.

        Returns (cost, input_tokens, output_tokens).
        """
        headers = {"Authorization": f"Bearer {api_key}"}

        for attempt in range(OPENROUTER_COST_MAX_RETRIES):
            try:
                resp = await client.get(
                    OPENROUTER_GENERATION_URL,
                    params={"id": gen_id},
                    headers=headers,
                )
                if resp.status_code != 200:
                    logger.warning(
                        "[cost_tracker] OpenRouter generation query failed (%d): %s",
                        resp.status_code, resp.text,
                    )
                    return 0.0, 0, 0

                data = resp.json().get("data", {})
                total_cost = data.get("total_cost", 0)
                if total_cost and total_cost > 0:
                    return (
                        float(total_cost),
                        int(data.get("tokens_prompt", 0)),
                        int(data.get("tokens_completion", 0)),
                    )

                if attempt < OPENROUTER_COST_MAX_RETRIES - 1:
                    await asyncio.sleep(OPENROUTER_COST_RETRY_DELAY)

            except Exception as exc:
                logger.warning("[cost_tracker] Error fetching cost for %s: %s", gen_id, exc)
                return 0.0, 0, 0

        logger.warning("[cost_tracker] Cost still 0 for %s after retries", gen_id)
        return 0.0, 0, 0

    def get_summary(self) -> CostSummary:
        """Calculate the final cost breakdown.

        Uses actual LLM cost from OpenRouter if available, otherwise
        falls back to rate-based estimate from token counts.
        """
        elapsed_min = (time.time() - self._start_time) / 60.0
        stt_minutes = self._usage_tracker.session_duration_secs / 60.0
        tts_characters = self._usage_tracker.tts_characters

        # LLM cost: prefer actual, fall back to estimate
        if self._llm_actual_cost > 0:
            llm_cost = self._llm_actual_cost
        else:
            llm_cost = (
                self._llm_input_tokens * PRICING.LLM_COST_PER_INPUT_TOKEN
                + self._llm_output_tokens * PRICING.LLM_COST_PER_OUTPUT_TOKEN
            )

        tts_cost = tts_characters * PRICING.TTS_COST_PER_CHAR
        stt_cost = stt_minutes * PRICING.STT_COST_PER_MINUTE
        total_cost = llm_cost + tts_cost + stt_cost
        cost_per_min = total_cost / elapsed_min if elapsed_min > 0 else 0.0

        summary = CostSummary(
            duration_min=round(elapsed_min, 2),
            llm_input_tokens=self._llm_input_tokens,
            llm_output_tokens=self._llm_output_tokens,
            llm_cost=round(llm_cost, 6),
            llm_actual_cost=round(self._llm_actual_cost, 6),
            tts_characters=tts_characters,
            tts_cost=round(tts_cost, 6),
            stt_minutes=round(stt_minutes, 2),
            stt_cost=round(stt_cost, 6),
            total_cost=round(total_cost, 6),
            cost_per_min=round(cost_per_min, 6),
        )

        logger.info(
            "[cost_tracker] Summary: %.2f min, %d in/%d out tokens, %d TTS chars, $%.4f total (LLM actual: $%.4f)",
            summary.duration_min,
            summary.llm_input_tokens,
            summary.llm_output_tokens,
            summary.tts_characters,
            summary.total_cost,
            summary.llm_actual_cost,
        )

        return summary
