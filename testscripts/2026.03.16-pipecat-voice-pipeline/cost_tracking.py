"""
Post-hoc cost tracking for the Pipecat voice pipeline.

- OpenRouter LLM: actual cost via generation API
- Deepgram STT: actual duration from transcription metadata × tier pricing
- Deepgram TTS: actual character count from run_tts × tier pricing
"""

import asyncio
import time

import httpx
from loguru import logger

from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.openai.llm import OpenAILLMService


# ============================================================================
# CONSTANTS
# ============================================================================

OPENROUTER_GENERATION_URL = "https://openrouter.ai/api/v1/generation"
COST_RETRY_DELAY_SECS = 2
COST_MAX_RETRIES = 3

# Deepgram pay-as-you-go pricing (USD)
# https://deepgram.com/pricing
DEEPGRAM_STT_COST_PER_MIN = 0.0059  # Nova-3 pay-as-you-go
DEEPGRAM_TTS_COST_PER_CHAR = 0.000015  # Aura-2 pay-as-you-go ($0.015/1000 chars)


# ============================================================================
# USAGE TRACKER
# ============================================================================

class UsageTracker:
    """Tracks usage metrics in-process during a session."""

    def __init__(self):
        self._llm_gen_ids: list[str] = []
        self._llm_seen: set[str] = set()
        self._tts_characters: int = 0
        self._session_start: float = time.monotonic()

    def log_llm_generation(self, gen_id: str):
        if gen_id in self._llm_seen:
            return
        self._llm_seen.add(gen_id)
        self._llm_gen_ids.append(gen_id)
        logger.info(f"Logged LLM generation: {gen_id}")

    def add_tts_characters(self, num_chars: int):
        self._tts_characters += num_chars
        logger.debug(f"TTS characters so far: {self._tts_characters}")

    @property
    def llm_gen_ids(self) -> list[str]:
        return self._llm_gen_ids

    @property
    def tts_characters(self) -> int:
        return self._tts_characters

    @property
    def session_duration_secs(self) -> float:
        return time.monotonic() - self._session_start


# ============================================================================
# TRACKED SERVICE SUBCLASSES
# ============================================================================

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


class TrackedDeepgramSTTService(DeepgramSTTService):
    """DeepgramSTTService — STT cost uses session duration (billed for full connection)."""
    pass


# ============================================================================
# COST FETCHER
# ============================================================================

async def fetch_actual_costs(
    usage_tracker: UsageTracker,
    openrouter_key: str,
) -> dict:
    """Compute session costs.

    - LLM: actual cost from OpenRouter generation API
    - STT: duration × per-minute rate
    - TTS: characters × per-character rate
    """
    costs = {
        "llm": 0.0,
        "tts": 0.0,
        "stt": 0.0,
        "tts_characters": usage_tracker.tts_characters,
    }

    # -- OpenRouter LLM costs (actual) --
    async with httpx.AsyncClient(timeout=15) as client:
        for gen_id in usage_tracker.llm_gen_ids:
            cost = await _fetch_openrouter_cost(client, openrouter_key, gen_id)
            costs["llm"] += cost

    # -- Deepgram costs (metered usage × pricing) --
    # STT bills for the full WebSocket connection duration (silence included)
    costs["stt"] = (usage_tracker.session_duration_secs / 60) * DEEPGRAM_STT_COST_PER_MIN
    costs["tts"] = usage_tracker.tts_characters * DEEPGRAM_TTS_COST_PER_CHAR

    costs["total"] = costs["llm"] + costs["tts"] + costs["stt"]
    duration_mins = usage_tracker.session_duration_secs / 60
    costs["session_duration_secs"] = usage_tracker.session_duration_secs
    costs["cost_per_min"] = costs["total"] / duration_mins if duration_mins > 0 else 0.0
    return costs


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def _fetch_openrouter_cost(
    client: httpx.AsyncClient, api_key: str, gen_id: str
) -> float:
    """Fetch actual cost for an OpenRouter generation. Retries if cost is 0."""
    headers = {"Authorization": f"Bearer {api_key}"}

    for attempt in range(COST_MAX_RETRIES):
        resp = await client.get(
            OPENROUTER_GENERATION_URL,
            params={"id": gen_id},
            headers=headers,
        )
        if resp.status_code != 200:
            logger.warning(f"OpenRouter generation query failed ({resp.status_code}): {resp.text}")
            return 0.0

        data = resp.json().get("data", {})
        total_cost = data.get("total_cost", 0)
        if total_cost and total_cost > 0:
            return float(total_cost)

        # Cost may not be finalized yet for streaming responses
        if attempt < COST_MAX_RETRIES - 1:
            logger.debug(f"OpenRouter cost not ready for {gen_id}, retrying...")
            await asyncio.sleep(COST_RETRY_DELAY_SECS)

    logger.warning(f"OpenRouter cost still 0 for {gen_id} after retries")
    return 0.0


def print_cost_summary(costs: dict):
    """Print a formatted cost summary to the terminal."""
    duration = costs.get('session_duration_secs', 0)
    mins, secs = divmod(int(duration), 60)
    print("\n" + "=" * 50)
    print("SESSION COST SUMMARY")
    print("=" * 50)
    print(f"Duration:           {mins}m {secs}s")
    print(f"LLM (OpenRouter):   ${costs['llm']:.6f}  [actual]")
    print(f"STT (Deepgram):     ${costs['stt']:.6f}  [{mins}m {secs}s connection]")
    print(f"TTS (Deepgram):     ${costs['tts']:.6f}  [{costs['tts_characters']} chars]")
    print("-" * 50)
    print(f"TOTAL:              ${costs['total']:.6f}")
    print(f"COST/MIN:           ${costs['cost_per_min']:.6f}")
    print("=" * 50 + "\n")
