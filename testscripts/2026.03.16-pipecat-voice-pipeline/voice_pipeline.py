"""
Voice conversation pipeline using Pipecat with Deepgram STT/TTS over WebRTC.

Opens a browser UI at http://localhost:7860/client. The browser handles
echo cancellation natively via WebRTC, so interruptions work cleanly.

Pipeline: browser mic -> VAD -> STT -> LLM -> TTS -> browser speaker
"""

import atexit
import os
import sys
import time

from dotenv import load_dotenv
from loguru import logger

from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import InputAudioRawFrame, LLMRunFrame, MetricsFrame, TextFrame
from pipecat.metrics.metrics import LLMUsageMetricsData, TTSUsageMetricsData
from pipecat.observers.base_observer import BaseObserver, FrameProcessed, FramePushed
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.llm_service import LLMContext
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.turns.user_start import MinWordsUserTurnStartStrategy, VADUserTurnStartStrategy
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.runner.types import RunnerArguments

load_dotenv()

# ============================================================================
# CONSTANTS
# ============================================================================

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
LLM_MODEL = "google/gemini-3-flash-preview"

# Deepgram Aura 2 TTS voice -- "helena" is a natural conversational voice
# Other Aura 2 options: aura-2-andromeda-en, aura-2-aurora-en, aura-2-luna-en,
# aura-2-stella-en, aura-2-athena-en, aura-2-hera-en, aura-2-orion-en, aura-2-perseus-en
DEEPGRAM_TTS_VOICE = "aura-2-helena-en"

SYSTEM_PROMPT = """You are a helpful voice assistant. Keep your responses concise
and conversational -- aim for 1-3 sentences unless the user asks for detail.
You are having a real-time voice conversation, so be natural and responsive."""

# Smart Turn requires VAD stop_secs=0.2 to work properly
VAD_STOP_SECS = 0.2
VAD_CONFIDENCE = 0.7

# Minimum words required before an interruption is triggered.
MIN_INTERRUPT_WORDS = 3

# ============================================================================
# PRICING (USD) — update these when prices change
# ============================================================================

# OpenRouter: google/gemini-3-flash-preview
LLM_COST_PER_INPUT_TOKEN = 0.15 / 1_000_000   # $0.15/M input tokens
LLM_COST_PER_OUTPUT_TOKEN = 0.60 / 1_000_000   # $0.60/M output tokens

# Deepgram TTS: ~$0.015/1K chars
TTS_COST_PER_CHAR = 0.015 / 1_000

# Deepgram STT Nova-2: ~$0.0043/min (pay-as-you-go)
STT_COST_PER_MINUTE = 0.0043


# ============================================================================
# COST TRACKER
# ============================================================================

class CostTracker(BaseObserver):
    """Observes pipeline metrics and accumulates cost estimates."""

    def __init__(self):
        super().__init__()
        self.llm_input_tokens = 0
        self.llm_output_tokens = 0
        self.tts_characters = 0
        self.stt_audio_seconds = 0.0
        self.start_time = time.time()
        self._frames_seen = set()

    async def on_push_frame(self, data: FramePushed):
        frame = data.frame

        # Count TTS characters from TextFrames going into the TTS processor
        if isinstance(frame, TextFrame) and hasattr(frame, "text") and frame.text:
            dest_name = type(data.destination).__name__
            if "TTS" in dest_name or "Deepgram" in dest_name:
                self.tts_characters += len(frame.text)

        # Count STT audio duration — only from the transport source to avoid
        # counting the same frame multiple times as it passes through the pipeline
        if isinstance(frame, InputAudioRawFrame):
            source_name = type(data.source).__name__
            if "Transport" in source_name or "Input" in source_name:
                num_samples = len(frame.audio) / 2  # 16-bit = 2 bytes per sample
                self.stt_audio_seconds += num_samples / frame.sample_rate

        # Count LLM tokens from metrics frames
        if not isinstance(frame, MetricsFrame):
            return
        if frame.id in self._frames_seen:
            return
        self._frames_seen.add(frame.id)

        for m in frame.data:
            if isinstance(m, LLMUsageMetricsData):
                self.llm_input_tokens += m.value.prompt_tokens
                self.llm_output_tokens += m.value.completion_tokens
            elif isinstance(m, TTSUsageMetricsData):
                self.tts_characters += m.value

    def get_summary(self) -> dict:
        duration_min = (time.time() - self.start_time) / 60.0
        stt_min = self.stt_audio_seconds / 60.0
        llm_cost = (
            self.llm_input_tokens * LLM_COST_PER_INPUT_TOKEN
            + self.llm_output_tokens * LLM_COST_PER_OUTPUT_TOKEN
        )
        tts_cost = self.tts_characters * TTS_COST_PER_CHAR
        stt_cost = stt_min * STT_COST_PER_MINUTE
        total = llm_cost + tts_cost + stt_cost
        cost_per_min = total / duration_min if duration_min > 0 else 0
        return {
            "duration_min": round(duration_min, 2),
            "llm_input_tokens": self.llm_input_tokens,
            "llm_output_tokens": self.llm_output_tokens,
            "llm_cost": round(llm_cost, 6),
            "tts_characters": self.tts_characters,
            "tts_cost": round(tts_cost, 6),
            "stt_minutes": round(stt_min, 2),
            "stt_cost": round(stt_cost, 6),
            "total_cost": round(total, 6),
            "cost_per_min": round(cost_per_min, 6),
        }

    def print_summary(self):
        s = self.get_summary()
        print("\n" + "=" * 50)
        print("CONVERSATION COST SUMMARY")
        print("=" * 50)
        print(f"Duration:        {s['duration_min']} min")
        print(f"LLM tokens:      {s['llm_input_tokens']} in / {s['llm_output_tokens']} out  →  ${s['llm_cost']:.4f}")
        print(f"TTS characters:  {s['tts_characters']}  →  ${s['tts_cost']:.4f}")
        print(f"STT audio:       {s['stt_minutes']} min  →  ${s['stt_cost']:.4f}")
        print("-" * 50)
        print(f"TOTAL:           ${s['total_cost']:.4f}")
        print(f"COST/MIN:        ${s['cost_per_min']:.4f}")
        print("=" * 50 + "\n")


# ============================================================================
# BOT LOGIC
# ============================================================================

async def run_bot(transport: BaseTransport, cost_tracker: CostTracker):
    deepgram_key = os.getenv("DEEPGRAM_API_KEY")
    openrouter_key = os.getenv("OPENROUTER_API_KEY")

    if not deepgram_key:
        logger.error("DEEPGRAM_API_KEY not set in .env")
        sys.exit(1)
    if not openrouter_key:
        logger.error("OPENROUTER_API_KEY not set in .env")
        sys.exit(1)

    # -- STT: Deepgram Nova-2 (streaming) --
    stt = DeepgramSTTService(api_key=deepgram_key)

    # -- LLM: OpenRouter (OpenAI-compatible) --
    llm = OpenAILLMService(
        api_key=openrouter_key,
        base_url=OPENROUTER_BASE_URL,
        settings=OpenAILLMService.Settings(model=LLM_MODEL),
    )

    # -- TTS: Deepgram Aura (streaming) --
    tts = DeepgramTTSService(
        api_key=deepgram_key,
        settings=DeepgramTTSService.Settings(voice=DEEPGRAM_TTS_VOICE),
    )

    # -- Context + Turn management --
    context = LLMContext(
        messages=[{"role": "system", "content": SYSTEM_PROMPT}],
    )

    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(
                params=VADParams(
                    confidence=VAD_CONFIDENCE,
                    stop_secs=VAD_STOP_SECS,
                )
            ),
            user_turn_strategies=UserTurnStrategies(
                start=[
                    VADUserTurnStartStrategy(enable_interruptions=True),
                    MinWordsUserTurnStartStrategy(min_words=MIN_INTERRUPT_WORDS),
                ],
                stop=[
                    TurnAnalyzerUserTurnStopStrategy(
                        turn_analyzer=LocalSmartTurnAnalyzerV3()
                    )
                ],
            ),
        ),
    )

    # -- Pipeline --
    pipeline = Pipeline([
        transport.input(),
        stt,
        user_aggregator,
        llm,
        tts,
        transport.output(),
        assistant_aggregator,
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        observers=[cost_tracker],
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected — starting conversation")
        context.add_message(
            {"role": "user", "content": "Say hello and briefly introduce yourself."}
        )
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected")
        cost_tracker.print_summary()
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)


async def bot(runner_args: RunnerArguments):
    """Entry point called by pipecat runner."""
    cost_tracker = CostTracker()
    atexit.register(cost_tracker.print_summary)

    transport = SmallWebRTCTransport(
        webrtc_connection=runner_args.webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    )
    await run_bot(transport, cost_tracker)


if __name__ == "__main__":
    from pipecat.runner.run import main
    main()
