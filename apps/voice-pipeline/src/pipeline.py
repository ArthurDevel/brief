"""
Core Pipecat pipeline factory for the voice pipeline.

Builds the full audio processing pipeline with Flux STT (native turn detection),
LLM (with function calling), TTS (with markdown filtering), and pitch-preserving
speed control. Recording is handled via AudioBufferProcessor when enabled.

- create_pipeline: build and configure the full pipeline with all components
- Tool call handlers route through tools/handlers.py
- IMAP operations wrapped in asyncio.to_thread() to avoid blocking
- AudioBufferProcessor captures merged + separate tracks, fires events for WAV upload
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

import aiohttp
from pipecat.frames.frames import InputAudioRawFrame, LLMMessagesFrame, TTSAudioRawFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from pipecat.processors.idle_frame_processor import IdleFrameProcessor
from pipecat.services.deepgram.flux.stt import DeepgramFluxSTTService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.transports.base_transport import BaseTransport
from pipecat.utils.text.markdown_text_filter import MarkdownTextFilter

from supabase import Client

from src.audio.normalizer import AudioNormalizerProcessor
from src.audio.recorder import write_wav, upload_recording
from src.audio.speed import AudioSpeedProcessor
from src.config import LLM_MODEL, Settings
from src.cost_tracker import CostTracker
from src.langfuse_observer import LangfuseObserver
from src.tracked_services import TrackedDeepgramTTSService, TrackedOpenAILLMService, UsageTracker
from src.prompt import build_system_prompt
from src.session import ActiveSession, SessionMetadata, SmtpConfig, UserContext, get_last_session_end_time
from src.tools.definitions import get_tool_definitions
from src.tools.email_client import count_emails_since, count_unread_emails
from src.tools.handlers import ActionInput, handle_tool_call


logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

@dataclass
class PipelineResult:
    """Bundles the pipeline task with service references for post-shutdown cleanup."""
    task: PipelineTask
    stt: DeepgramFluxSTTService
    audio_buffer: AudioBufferProcessor | None
    narration_http_session: dict[str, aiohttp.ClientSession | None]


DEFAULT_TEMPO = 1.5
# Must be shorter than pipecat's 10s function_call_timeout_secs so that
# our handler returns a proper error before pipecat sends "COMPLETED".
TOOL_CALL_TIMEOUT_SECS = 8.0

# Safety net timeout on register_function(). Higher than TOOL_CALL_TIMEOUT_SECS
# to account for lock wait time. The manual asyncio.wait_for() inside the lock
# remains the primary timeout mechanism.
REGISTER_FUNCTION_TIMEOUT_SECS = 20.0

# Cancels the pipeline if no audio frames arrive for this duration.
AUDIO_IDLE_TIMEOUT_SECS = 10.0

DEEPGRAM_HTTP_TTS_URL = "https://api.deepgram.com/v1/speak"

# Short phrases spoken via TTS before a tool executes, so the user isn't
# waiting in silence. Tools not listed here are executed silently.
TOOL_NARRATIONS: dict[str, str] = {
    "list_inbox": "Checking your inbox.",
    "read_email": "Reading that email.",
    "read_thread": "Pulling up the thread.",
    "search_emails": "Searching your emails.",
    "draft_email": "Drafting that email.",
    "send_email": "Sending that email.",
    "archive_email": "Archiving that email.",
    "delete_email": "Deleting that email.",
    "batch_archive_emails": "Archiving those emails.",
    "batch_delete_emails": "Deleting those emails.",
    "find_contact": "Looking up that contact.",
}


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
    recording_enabled: bool = False,
) -> PipelineResult:
    """Build the full Pipecat pipeline with STT, LLM, TTS, and speed control.

    Pipeline chain:
        transport.input() -> watchdog -> stt -> user_agg -> llm -> tts
        -> speed -> normalizer -> transport.output() -> [audio_buffer] -> assistant_agg

    Args:
        transport: The Pipecat transport (WebRTC or Twilio).
        user_context: User context with memory, credentials, and preferences.
        session: The active session tracker.
        cost_tracker: Observer tracking STT/LLM/TTS usage for cost calculation.
        langfuse_observer: Observer for Langfuse tracing.
        usage_tracker: Tracks usage metrics for the tracked services.
        audio_config: Dict with "sample_rate" and "num_channels" keys.
        supabase: Supabase client for DB operations.
        settings: Application settings.
        imap_holder: Mutable dict {"client": IMAPClient, "config": ImapConfig}
            for IMAP operations with reconnect support.
        recording_enabled: Whether to capture audio via AudioBufferProcessor.

    Returns:
        PipelineResult with the configured task, STT service, audio buffer, and
        narration HTTP session references.
    """
    sample_rate = audio_config.get("sample_rate", 16000)
    num_channels = audio_config.get("num_channels", 1)

    # -- STT (Deepgram Flux -- handles turn detection natively) --
    stt = DeepgramFluxSTTService(
        api_key=settings.deepgram_api_key,
    )

    # -- LLM (OpenRouter, OpenAI-compatible) --
    llm = TrackedOpenAILLMService(
        usage_tracker=usage_tracker,
        api_key=settings.openrouter_api_key,
        model=LLM_MODEL,
        base_url="https://openrouter.ai/api/v1",
    )

    # -- TTS (Deepgram with markdown filtering) --
    tts = TrackedDeepgramTTSService(
        usage_tracker=usage_tracker,
        api_key=settings.deepgram_api_key,
        voice=user_context.voice_preference,
        sample_rate=sample_rate,
        text_filter=MarkdownTextFilter(),
    )

    # -- Speed processor (WSOLA) --
    speed_config = {"speed": user_context.voice_speed}
    speed_processor = AudioSpeedProcessor(
        config=speed_config,
        sample_rate=sample_rate,
        num_channels=num_channels,
    )

    # -- Audio normalizer (RMS normalization with peak limiting) --
    normalizer_config = {"enabled": True}
    normalizer = AudioNormalizerProcessor(
        config=normalizer_config,
        sample_rate=sample_rate,
    )

    # -- Fetch email count for greeting --
    email_context: str | None = None
    last_ended_at: datetime | None = None
    try:
        last_ended_at = get_last_session_end_time(session.user_id, supabase)
        if last_ended_at is None:
            count = count_unread_emails(imap_holder["client"])
            if count > 0:
                email_context = f"This is the user's first call. They have {count} unread emails in their inbox."
            else:
                email_context = "This is the user's first call. They have no unread emails."
        else:
            count = count_emails_since(imap_holder["client"], last_ended_at)
            if count > 0:
                email_context = f"You have {count} new emails since the last call."
            else:
                email_context = "No new emails since the last call."
    except Exception:
        logger.warning("[pipeline] Failed to fetch email count for greeting, skipping")

    # -- Build session metadata and system prompt --
    # Use the user's local timezone if available, otherwise fall back to UTC
    if user_context.timezone is not None:
        user_tz = ZoneInfo(user_context.timezone)
        current_dt_str = datetime.now(user_tz).isoformat()
        last_call_dt_str = last_ended_at.astimezone(user_tz).isoformat() if last_ended_at is not None else None
    else:
        current_dt_str = datetime.now(timezone.utc).isoformat()
        last_call_dt_str = last_ended_at.isoformat() if last_ended_at is not None else None

    session_metadata = SessionMetadata(
        current_datetime=current_dt_str,
        user_email=user_context.imap_config.user,
        last_call_datetime=last_call_dt_str,
    )

    system_prompt = build_system_prompt(
        user_context.memory_entries,
        user_context.tool_approval_config,
        email_context=email_context,
        email_provider=user_context.email_provider,
        session_metadata=session_metadata,
    )

    tools = get_tool_definitions()

    messages: list[Any] = [{"role": "system", "content": system_prompt}]
    # Convert OpenAI-format tool dicts to FunctionSchema objects.
    # The OpenAI adapter only reads standard_tools (ignores custom_tools).
    standard_tools = [
        FunctionSchema(
            name=t["function"]["name"],
            description=t["function"]["description"],
            properties=t["function"]["parameters"].get("properties", {}),
            required=t["function"]["parameters"].get("required", []),
        )
        for t in tools
    ]
    tools_schema = ToolsSchema(standard_tools=list(standard_tools))  # type: ignore[arg-type]
    context = LLMContext(messages=messages, tools=tools_schema)

    # -- Context aggregators (Flux STT handles turn detection natively) --
    context_aggregator = LLMContextAggregatorPair(context)  # type: ignore[arg-type]
    user_aggregator = context_aggregator.user()
    assistant_aggregator = context_aggregator.assistant()

    # -- Register function call handlers --
    # Each handler routes through tools/handlers.py handle_tool_call().
    # IMAP operations are synchronous, so wrap in asyncio.to_thread().
    # A shared asyncio.Lock serializes IMAP access -- imapclient is not thread-safe.
    imap_lock = asyncio.Lock()
    tool_names = [t["function"]["name"] for t in tools]

    # Shared HTTP session for narration TTS calls (Deepgram REST API).
    # Created lazily on first use, closed when the pipeline ends.
    narration_http_session: dict[str, aiohttp.ClientSession | None] = {"session": None}

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
            deepgram_api_key=settings.deepgram_api_key,
            tts_sample_rate=sample_rate,
            tts_voice=user_context.voice_preference,
            narration_http_session=narration_http_session,
        )

    # -- Audio idle watchdog (cancels pipeline if audio frames stop arriving) --
    async def _on_audio_idle(processor: IdleFrameProcessor) -> None:
        logger.warning("[watchdog] No audio for %.0fs, cancelling pipeline", AUDIO_IDLE_TIMEOUT_SECS)
        await task.cancel()

    watchdog = IdleFrameProcessor(
        callback=_on_audio_idle,
        timeout=AUDIO_IDLE_TIMEOUT_SECS,
        types=[InputAudioRawFrame],
    )

    # -- Audio recording (AudioBufferProcessor, conditional) --
    audio_buffer: AudioBufferProcessor | None = None
    if recording_enabled:
        audio_buffer = AudioBufferProcessor(
            sample_rate=sample_rate,
            num_channels=num_channels,
        )

        @audio_buffer.event_handler("on_audio_data")
        async def on_audio_data(
            buffer: AudioBufferProcessor,
            audio: bytes,
            sample_rate: int,
            num_channels: int,
        ) -> None:
            """Save merged (user + bot) audio as WAV and upload to Supabase."""
            if not audio:
                return
            wav_bytes = write_wav(audio, sample_rate, num_channels)
            await upload_recording(session.session_id, wav_bytes, supabase)

        @audio_buffer.event_handler("on_track_audio_data")
        async def on_track_audio_data(
            buffer: AudioBufferProcessor,
            user_audio: bytes,
            bot_audio: bytes,
            sample_rate: int,
            num_channels: int,
        ) -> None:
            """Save separate user and bot audio tracks as WAV and upload to Supabase."""
            for label, audio_data in [("user", user_audio), ("bot", bot_audio)]:
                if not audio_data:
                    continue
                wav_bytes = write_wav(audio_data, sample_rate, 1)
                track_session_id = f"{session.session_id}_{label}"
                await upload_recording(track_session_id, wav_bytes, supabase)

    # -- Assemble pipeline --
    pipeline_chain: list[Any] = [
        transport.input(),
        watchdog,
        stt,
        user_aggregator,
        llm,
        tts,
        speed_processor,
        normalizer,
        transport.output(),
    ]
    if audio_buffer is not None:
        pipeline_chain.append(audio_buffer)
    pipeline_chain.append(assistant_aggregator)

    pipeline = Pipeline(pipeline_chain)

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=sample_rate,
            audio_out_sample_rate=sample_rate,
            enable_metrics=True,
            enable_usage_metrics=True,
            observers=[cost_tracker, langfuse_observer],
        ),
    )

    return PipelineResult(
        task=task,
        stt=stt,
        audio_buffer=audio_buffer,
        narration_http_session=narration_http_session,
    )


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

async def _synthesize_narration(
    text: str,
    api_key: str,
    sample_rate: int,
    voice: str,
    http_session: dict[str, aiohttp.ClientSession | None],
) -> bytes:
    """Synthesize a short phrase using Deepgram's HTTP TTS API.

    Uses the REST endpoint instead of the websocket TTS service to avoid
    a race condition where pipecat's websocket TTS cleans up the audio
    context before all audio chunks arrive.

    Args:
        text: The phrase to synthesize.
        api_key: Deepgram API key.
        sample_rate: Audio sample rate in Hz.
        voice: Deepgram voice model name.
        http_session: Mutable dict holding a shared aiohttp session (lazy-created).

    Returns:
        Raw PCM linear16 audio bytes.
    """
    # Lazy-create the shared HTTP session
    if http_session["session"] is None:
        http_session["session"] = aiohttp.ClientSession()

    session = http_session["session"]
    headers = {"Authorization": f"Token {api_key}", "Content-Type": "application/json"}
    params = {
        "model": voice,
        "encoding": "linear16",
        "sample_rate": sample_rate,
        "container": "none",
    }

    async with session.post(
        DEEPGRAM_HTTP_TTS_URL, headers=headers, json={"text": text}, params=params
    ) as resp:
        if resp.status != 200:
            error_text = await resp.text()
            raise RuntimeError(f"Deepgram HTTP TTS failed ({resp.status}): {error_text}")
        return await resp.read()


def _register_tool_handler(
    llm: TrackedOpenAILLMService,
    tool_name: str,
    session: ActiveSession,
    user_context: UserContext,
    imap_holder: dict[str, Any],
    imap_lock: asyncio.Lock,
    supabase: Client,
    langfuse_observer: LangfuseObserver,
    deepgram_api_key: str,
    tts_sample_rate: int,
    tts_voice: str,
    narration_http_session: dict[str, aiohttp.ClientSession | None],
) -> None:
    """Register a single function call handler on the LLM service.

    The handler wraps handle_tool_call in asyncio.to_thread() since
    IMAP operations are synchronous. An asyncio.Lock serializes IMAP
    access (imapclient is not thread-safe). A timeout ensures the handler
    returns an error before pipecat's hardcoded "COMPLETED" fires.

    The timeout_secs on register_function() is a safety net (20s) that
    accounts for lock wait time + IMAP timeout. The manual asyncio.wait_for()
    inside the lock (8s) remains the primary timeout mechanism.

    If a narration phrase is configured in TOOL_NARRATIONS for this tool,
    the handler synthesizes it via Deepgram's HTTP TTS API and pushes
    raw audio frames through the pipeline. This bypasses pipecat's
    websocket TTS service which has a race condition with short phrases
    (audio context gets cleaned up before all chunks arrive).

    Args:
        llm: The LLM service to register the handler on.
        tool_name: The tool name to register.
        session: Active session for action input.
        user_context: User context for approval config and SMTP config.
        imap_holder: Mutable IMAP client holder.
        imap_lock: Shared asyncio.Lock to serialize IMAP access.
        supabase: Supabase client.
        langfuse_observer: Observer for Langfuse tracing.
        deepgram_api_key: Deepgram API key for HTTP TTS narration.
        tts_sample_rate: Audio sample rate for narration synthesis.
        tts_voice: Deepgram voice model for narration synthesis.
        narration_http_session: Shared mutable dict holding the aiohttp session.
    """
    async def handler(params: FunctionCallParams) -> None:
        """Handle a function call from the LLM."""
        function_name = params.function_name
        args = dict(params.arguments)

        # Speak a short narration so the user knows something is happening.
        # Uses Deepgram HTTP TTS (not websocket) to avoid audio context race condition.
        narration = TOOL_NARRATIONS.get(function_name)
        if narration:
            try:
                logger.debug(f"[narration] Synthesizing narration for [{function_name}]: {narration}")
                audio_bytes = await _synthesize_narration(
                    narration, deepgram_api_key, tts_sample_rate, tts_voice,
                    narration_http_session,
                )
                logger.debug(f"[narration] Got {len(audio_bytes)} bytes, pushing TTSAudioRawFrame at {tts_sample_rate}Hz")
                await llm.push_frame(TTSAudioRawFrame(
                    audio=audio_bytes,
                    sample_rate=tts_sample_rate,
                    num_channels=1,
                ))
                logger.debug(f"[narration] push_frame completed for [{function_name}]")
            except Exception as e:
                logger.warning(f"Narration failed for [{function_name}]: {e}")

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

        await params.result_callback(result_str)

    llm.register_function(tool_name, handler, timeout_secs=REGISTER_FUNCTION_TIMEOUT_SECS)
