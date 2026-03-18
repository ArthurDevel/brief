"""
Core Pipecat pipeline factory for the voice pipeline.

Builds the full audio processing pipeline with STT, LLM (with function
calling), TTS, and pitch-preserving speed control.

- create_pipeline: build and configure the full pipeline with all components
- Tool call handlers route through tools/handlers.py
- IMAP operations wrapped in asyncio.to_thread() to avoid blocking
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from pipecat.frames.frames import LLMMessagesFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.user_idle_processor import UserIdleProcessor
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.transports.base_transport import BaseTransport
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from supabase import Client

from src.audio.speed import AudioSpeedProcessor
from src.config import LLM_MODEL, Settings
from src.cost_tracker import CostTracker
from src.langfuse_observer import LangfuseObserver
from src.tracked_services import TrackedDeepgramTTSService, TrackedOpenAILLMService, UsageTracker
from src.prompt import build_system_prompt
from src.session import ActiveSession, SmtpConfig, UserContext
from src.tools.definitions import get_tool_definitions
from src.tools.handlers import ActionInput, handle_tool_call


logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

DEFAULT_TEMPO = 1.5
# Must be shorter than pipecat's 10s function_call_timeout_secs so that
# our handler returns a proper error before pipecat sends "COMPLETED".
TOOL_CALL_TIMEOUT_SECS = 8.0


# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

def create_pipeline(
    transport: BaseTransport,
    user_context: UserContext,
    session: ActiveSession,
    cost_tracker: CostTracker,
    langfuse_observer: LangfuseObserver,
    usage_tracker: UsageTracker,
    audio_config: dict[str, Any],
    supabase: Client,
    settings: Settings,
    imap_holder: dict[str, Any],
) -> PipelineTask:
    """Build the full Pipecat pipeline with STT, LLM, TTS, and speed control.

    Pipeline chain:
        transport.input() -> STT -> context_aggregator.user() -> LLM (with tools)
        -> TTS -> speed_processor -> transport.output() -> context_aggregator.assistant()

    Args:
        transport: The Pipecat transport (WebRTC or Twilio).
        user_context: User context with memory, credentials, and preferences.
        session: The active session tracker.
        cost_tracker: Observer tracking STT/LLM/TTS usage for cost calculation.
        audio_config: Dict with "sample_rate" and "num_channels" keys.
        supabase: Supabase client for DB operations.
        settings: Application settings.
        imap_holder: Mutable dict {"client": IMAPClient, "config": ImapConfig}
            for IMAP operations with reconnect support.

    Returns:
        Configured PipelineTask ready to run.
    """
    sample_rate = audio_config.get("sample_rate", 16000)
    num_channels = audio_config.get("num_channels", 1)

    # -- STT (Deepgram) --
    stt = DeepgramSTTService(
        api_key=settings.deepgram_api_key,
        audio_passthrough=True,
    )

    # -- LLM (OpenRouter, OpenAI-compatible) --
    llm = TrackedOpenAILLMService(
        usage_tracker=usage_tracker,
        api_key=settings.openrouter_api_key,
        model=LLM_MODEL,
        base_url="https://openrouter.ai/api/v1",
    )

    # -- TTS (Deepgram) --
    tts = TrackedDeepgramTTSService(
        usage_tracker=usage_tracker,
        api_key=settings.deepgram_api_key,
        voice=user_context.voice_preference,
        sample_rate=sample_rate,
    )

    # -- Speed processor (WSOLA) --
    # Uses the shared speed_config dict so the tempo can be updated live via API
    speed_config = audio_config.get("speed_config", {"speed": user_context.voice_speed})
    speed_processor = AudioSpeedProcessor(
        config=speed_config,
        sample_rate=sample_rate,
        num_channels=num_channels,
    )

    # -- Build system prompt and LLM context --
    system_prompt = build_system_prompt(
        user_context.memory_entries,
        user_context.tool_approval_config,
    )

    tools = get_tool_definitions()

    messages: list[Any] = [{"role": "system", "content": system_prompt}]
    context = OpenAILLMContext(messages=messages, tools=tools)  # type: ignore[arg-type]

    # SmartTurn v3 requires 16kHz audio (breaks silently at 8kHz/Twilio).
    # Use it for WebRTC, fall back to basic aggregator for Twilio.
    if sample_rate >= 16000:
        user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
            context,  # type: ignore[arg-type]
            user_params=LLMUserAggregatorParams(
                user_turn_strategies=UserTurnStrategies(
                    stop=[TurnAnalyzerUserTurnStopStrategy(
                        turn_analyzer=LocalSmartTurnAnalyzerV3()
                    )]
                ),
                vad_analyzer=SileroVADAnalyzer(),
            ),
        )
        logger.info("SmartTurn v3 enabled (16kHz)")
    else:
        basic = llm.create_context_aggregator(context)
        user_aggregator = basic.user()
        assistant_aggregator = basic.assistant()
        logger.info("SmartTurn v3 disabled (sample rate < 16kHz, using basic turn detection)")

    # -- Register function call handlers --
    # Each handler routes through tools/handlers.py handle_tool_call().
    # IMAP operations are synchronous, so wrap in asyncio.to_thread().
    # A shared asyncio.Lock serializes IMAP access -- imapclient is not thread-safe.
    imap_lock = asyncio.Lock()
    tool_names = [t["function"]["name"] for t in tools]
    for tool_name in tool_names:
        _register_tool_handler(
            llm=llm,
            tool_name=tool_name,
            session=session,
            user_context=user_context,
            imap_holder=imap_holder,
            imap_lock=imap_lock,
            supabase=supabase,
            langfuse_observer=langfuse_observer,
        )

    # -- Assemble pipeline --
    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            speed_processor,
            transport.output(),
            assistant_aggregator,
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=sample_rate,
            audio_out_sample_rate=sample_rate,
            allow_interruptions=True,
            enable_metrics=True,
            enable_usage_metrics=True,
            observers=[cost_tracker, langfuse_observer],
        ),
    )

    return task


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _register_tool_handler(
    llm: TrackedOpenAILLMService,
    tool_name: str,
    session: ActiveSession,
    user_context: UserContext,
    imap_holder: dict[str, Any],
    imap_lock: asyncio.Lock,
    supabase: Client,
    langfuse_observer: LangfuseObserver,
) -> None:
    """Register a single function call handler on the LLM service.

    The handler wraps handle_tool_call in asyncio.to_thread() since
    IMAP operations are synchronous. An asyncio.Lock serializes IMAP
    access (imapclient is not thread-safe). A timeout ensures the handler
    returns an error before pipecat's hardcoded "COMPLETED" fires.

    Args:
        llm: The LLM service to register the handler on.
        tool_name: The tool name to register.
        session: Active session for action input.
        user_context: User context for approval config and SMTP config.
        imap_holder: Mutable IMAP client holder.
        imap_lock: Shared asyncio.Lock to serialize IMAP access.
        supabase: Supabase client.
        langfuse_observer: Observer for Langfuse tracing.
    """
    async def handler(function_name, tool_call_id, args, llm_instance, context, result_callback):
        """Handle a function call from the LLM."""
        start_ms = time.time() * 1000
        try:
            action_input = ActionInput(
                user_id=user_context.user_id,
                session_id=session.session_id,
                tool_name=function_name,
                arguments=args,
            )

            # Lock serializes IMAP access (imapclient is not thread-safe).
            # Timeout ensures we return an error before pipecat sends "COMPLETED".
            async with imap_lock:
                action_result = await asyncio.wait_for(
                    asyncio.to_thread(
                        handle_tool_call,
                        action_input,
                        user_context.tool_approval_config,
                        imap_holder,
                        user_context.smtp_config,
                        supabase,
                    ),
                    timeout=TOOL_CALL_TIMEOUT_SECS,
                )

            result_dict = {
                "status": action_result.status,
                "result": action_result.result,
                "message": action_result.message,
            }
            result_str = json.dumps(result_dict, ensure_ascii=False)
        except asyncio.TimeoutError:
            logger.error(f"Tool call [{function_name}] timed out after {TOOL_CALL_TIMEOUT_SECS}s")
            result_dict = {
                "status": "error",
                "result": None,
                "message": f"Tool call timed out after {TOOL_CALL_TIMEOUT_SECS}s",
            }
            result_str = json.dumps(result_dict, ensure_ascii=False)
        except Exception as e:
            logger.error(f"Tool call [{function_name}] failed: {e}")
            result_dict = {
                "status": "error",
                "result": None,
                "message": str(e),
            }
            result_str = json.dumps(result_dict, ensure_ascii=False)

        duration_ms = time.time() * 1000 - start_ms
        langfuse_observer.log_tool_call(
            name=function_name,
            args=args,
            result=result_dict,
            duration_ms=duration_ms,
        )

        await result_callback(result_str)

    llm.register_function(tool_name, handler)
