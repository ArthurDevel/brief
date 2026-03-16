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
from typing import Any

from pipecat.frames.frames import LLMMessagesFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.processors.user_idle_processor import UserIdleProcessor
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepgram.tts import DeepgramTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.base_transport import BaseTransport
from pipecat.audio.vad.silero import SileroVADAnalyzer

from supabase import Client

from src.audio.speed import AudioSpeedProcessor
from src.config import LLM_MODEL, TTS_VOICE, Settings
from src.cost_tracker import CostTracker
from src.prompt import build_system_prompt
from src.session import ActiveSession, SmtpConfig, UserContext
from src.tools.definitions import get_tool_definitions
from src.tools.handlers import ActionInput, handle_tool_call


logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

DEFAULT_TEMPO = 1.5


# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

def create_pipeline(
    transport: BaseTransport,
    user_context: UserContext,
    session: ActiveSession,
    cost_tracker: CostTracker,
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
    llm = OpenAILLMService(
        api_key=settings.openrouter_api_key,
        model=LLM_MODEL,
        base_url="https://openrouter.ai/api/v1",
    )

    # -- TTS (Deepgram) --
    tts = DeepgramTTSService(
        api_key=settings.deepgram_api_key,
        voice=TTS_VOICE,
        sample_rate=sample_rate,
    )

    # -- Speed processor (WSOLA) --
    # Uses the shared speed_config dict so the tempo can be updated live via API
    speed_config = audio_config.get("speed_config", {"speed": DEFAULT_TEMPO})
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

    messages = [{"role": "system", "content": system_prompt}]
    context = OpenAILLMContext(messages=messages, tools=tools)
    context_aggregator = llm.create_context_aggregator(context)

    # -- Register function call handlers --
    # Each handler routes through tools/handlers.py handle_tool_call().
    # IMAP operations are synchronous, so wrap in asyncio.to_thread().
    tool_names = [t["function"]["name"] for t in tools]
    for tool_name in tool_names:
        _register_tool_handler(
            llm=llm,
            tool_name=tool_name,
            session=session,
            user_context=user_context,
            imap_holder=imap_holder,
            supabase=supabase,
        )

    # -- Assemble pipeline --
    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            context_aggregator.user(),
            llm,
            tts,
            speed_processor,
            transport.output(),
            context_aggregator.assistant(),
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=sample_rate,
            audio_out_sample_rate=sample_rate,
            vad_enabled=True,
            vad_analyzer=SileroVADAnalyzer(),
            allow_interruptions=True,
            enable_metrics=True,
            observers=[cost_tracker],
        ),
    )

    return task


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _register_tool_handler(
    llm: OpenAILLMService,
    tool_name: str,
    session: ActiveSession,
    user_context: UserContext,
    imap_holder: dict[str, Any],
    supabase: Client,
) -> None:
    """Register a single function call handler on the LLM service.

    The handler wraps handle_tool_call in asyncio.to_thread() since
    IMAP operations are synchronous.

    Args:
        llm: The LLM service to register the handler on.
        tool_name: The tool name to register.
        session: Active session for action input.
        user_context: User context for approval config and SMTP config.
        imap_holder: Mutable IMAP client holder.
        supabase: Supabase client.
    """
    async def handler(function_name, tool_call_id, args, llm_instance, context, result_callback):
        """Handle a function call from the LLM."""
        action_input = ActionInput(
            user_id=user_context.user_id,
            session_id=session.session_id,
            tool_name=function_name,
            arguments=args,
        )

        # Run synchronous IMAP/tool operations in a thread
        action_result = await asyncio.to_thread(
            handle_tool_call,
            action_input,
            user_context.tool_approval_config,
            imap_holder,
            user_context.smtp_config,
            supabase,
        )

        # Return the result to the LLM as a JSON string
        result_str = json.dumps({
            "status": action_result.status,
            "result": action_result.result,
            "message": action_result.message,
        })

        await result_callback(result_str)

    llm.register_function(tool_name, handler)
