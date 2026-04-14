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
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import aiohttp
from pipecat.frames.frames import InputAudioRawFrame, TTSAudioRawFrame
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
from src.audio.thinking_indicator import ThinkingCueProcessor
from src.config import LLM_MODEL, Settings
from src.cost_tracker import CostTracker
from src.langfuse_observer import LangfuseObserver
from src.tracked_services import TrackedDeepgramTTSService, TrackedOpenAILLMService, UsageTracker
from src.prompt import build_system_prompt
from src.session import ActiveSession, SessionMetadata, UserContext, get_last_session_end_time
from src.tools.definitions import get_tool_definitions
from src.tools.email_client import EmailClientContext, count_emails_since, count_unread_emails
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
    "read_calendar": "Checking your calendar.",
    "draft_email": "Drafting that email.",
    "send_email": "Sending that email.",
    "archive_email": "Archiving that email.",
    "delete_email": "Deleting that email.",
    "batch_archive_emails": "Archiving those emails.",
    "batch_delete_emails": "Deleting those emails.",
    "batch_move_to_folder": "Moving those emails.",
    "mark_as_read": "Marking that as read.",
    "reply_email": "Sending that reply.",
    "move_to_folder": "Moving that email.",
    "list_folders": "Checking your folders.",
    "save_memory": "Saving that to memory.",
    "submit_feature_request": "Submitting your feedback.",
    "find_contact": "Looking up that contact.",
    "what_can_you_do": "Checking my capabilities.",
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
    email_ctx: EmailClientContext,
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
        email_ctx: Provider-aware email client context (IMAP/SMTP or Unipile).
        recording_enabled: Whether to capture audio via AudioBufferProcessor.

    Returns:
        PipelineResult with the configured task, STT service, audio buffer, and
        narration HTTP session references.
    """
    sample_rate = audio_config.get("sample_rate", 16000)
    num_channels = audio_config.get("num_channels", 1)

    # -- STT (Deepgram Flux -- handles turn detection natively) --
    logger.info("[startup] Initializing Deepgram Flux STT service")
    stt = DeepgramFluxSTTService(
        api_key=settings.deepgram_api_key,
    )
    logger.info("[startup] Deepgram Flux STT service initialized")

    # -- LLM (OpenRouter, OpenAI-compatible) --
    logger.info("[startup] Initializing OpenRouter LLM service: model=%s", LLM_MODEL)
    llm = TrackedOpenAILLMService(
        usage_tracker=usage_tracker,
        api_key=settings.openrouter_api_key,
        model=LLM_MODEL,
        base_url="https://openrouter.ai/api/v1",
    )
    logger.info("[startup] OpenRouter LLM service initialized")

    # -- TTS (Deepgram with markdown filtering) --
    logger.info("[startup] Initializing Deepgram TTS service: voice=%s sample_rate=%s", user_context.voice_preference, sample_rate)
    tts = TrackedDeepgramTTSService(
        usage_tracker=usage_tracker,
        api_key=settings.deepgram_api_key,
        voice=user_context.voice_preference,
        sample_rate=sample_rate,
        text_filter=MarkdownTextFilter(),
    )
    logger.info("[startup] Deepgram TTS service initialized")

    # -- Speed processor (WSOLA) --
    logger.info("[startup] Initializing audio processors: speed=%s", user_context.voice_speed)
    speed_config = {"speed": user_context.voice_speed}
    speed_processor = AudioSpeedProcessor(
        config=speed_config,
        sample_rate=sample_rate,
        num_channels=num_channels,
    )
    thinking_indicator = ThinkingCueProcessor()

    # -- Audio normalizer (RMS normalization with peak limiting) --
    normalizer_config = {"enabled": True}
    normalizer = AudioNormalizerProcessor(
        config=normalizer_config,
        sample_rate=sample_rate,
    )
    logger.info("[startup] Audio processors initialized")

    # -- Fetch email count for greeting --
    email_context: str | None = None
    last_ended_at: datetime | None = None
    try:
        logger.info("[startup] Loading last completed session end time")
        last_ended_at = get_last_session_end_time(session.user_id, supabase)
        logger.info("[startup] Last completed session end time loaded: present=%s", last_ended_at is not None)

        # Email count for greeting is only available for custom IMAP accounts.
        # Unipile accounts skip this -- the greeting will not mention email counts.
        if email_ctx.connection_type == "imap_smtp" and email_ctx.imap_holder is not None:
            imap_client_for_count = email_ctx.imap_holder["client"]
            if last_ended_at is None:
                logger.info("[startup] Counting unread emails for first-call greeting")
                count = count_unread_emails(imap_client_for_count)
                logger.info("[startup] Unread email count complete: count=%d", count)
                if count > 0:
                    email_context = f"This is the user's first call. They have {count} unread emails in their inbox."
                else:
                    email_context = "This is the user's first call. They have no unread emails."
            else:
                # Convert last_ended_at to the user's local timezone before comparing
                # against Gmail's naive local-time envelope dates. Without this,
                # the UTC hour (e.g. 18:21) would be compared against local-time
                # envelope dates (e.g. 11:25), incorrectly filtering out all emails.
                since_for_count = last_ended_at
                if user_context.timezone is not None:
                    since_for_count = last_ended_at.astimezone(ZoneInfo(user_context.timezone))
                logger.info("[startup] Counting emails since last call for greeting")
                count = count_emails_since(imap_client_for_count, since_for_count)
                logger.info("[startup] New email count complete: count=%d", count)
                if count > 0:
                    email_context = f"You have {count} new emails since the last call."
                else:
                    email_context = "No new emails since the last call."
        else:
            # Unipile account: set a basic context based on whether this is the first call
            if last_ended_at is None:
                email_context = "This is the user's first call."
            else:
                email_context = None
    except Exception:
        logger.warning("[pipeline] Failed to fetch email count for greeting, skipping")

    # -- Check for unlistened newsletter summary --
    try:
        logger.info("[startup] Checking newsletter summary state")
        if user_context.timezone is not None:
            nl_tz = ZoneInfo(user_context.timezone)
        else:
            nl_tz = ZoneInfo("UTC")
        nl_yesterday = (datetime.now(nl_tz) - timedelta(days=1)).date()

        nl_response = (
            supabase.table("newsletter_summaries")
            .select("id")
            .eq("user_id", session.user_id)
            .eq("summary_date", nl_yesterday.isoformat())
            .eq("listened", False)
            .execute()
        )
        if nl_response.data:
            nl_line = "You have an unlistened newsletter summary from yesterday."
            if email_context:
                email_context += f" {nl_line}"
            else:
                email_context = nl_line
        logger.info("[startup] Newsletter summary check complete: present=%s", bool(nl_response.data))
    except Exception:
        logger.warning("[pipeline] Failed to check newsletter summary, skipping")

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
        user_email=user_context.email_account.email_address or "",
        last_call_datetime=last_call_dt_str,
    )

    logger.info("[startup] Building system prompt")
    system_prompt = build_system_prompt(
        user_context.memory_entries,
        user_context.tool_approval_config,
        email_context=email_context,
        email_provider=user_context.email_provider,
        session_metadata=session_metadata,
    )
    langfuse_observer.set_system_prompt(system_prompt)
    logger.info("[startup] System prompt built: chars=%d", len(system_prompt))

    logger.info("[startup] Loading tool definitions")
    tools = get_tool_definitions()
    logger.info("[startup] Tool definitions loaded: count=%d", len(tools))

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
            email_ctx=email_ctx,
            email_lock=imap_lock,
            supabase=supabase,
            langfuse_observer=langfuse_observer,
            deepgram_api_key=settings.deepgram_api_key,
            tts_sample_rate=sample_rate,
            tts_voice=user_context.voice_preference,
            narration_http_session=narration_http_session,
            openrouter_api_key=settings.openrouter_api_key,
        )
    logger.info("[startup] Function handlers registered: count=%d", len(tool_names))

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
        thinking_indicator,
        speed_processor,
        normalizer,
        transport.output(),
    ]
    if audio_buffer is not None:
        pipeline_chain.append(audio_buffer)
    pipeline_chain.append(assistant_aggregator)

    pipeline = Pipeline(pipeline_chain)
    logger.info("[startup] Pipeline chain assembled: processors=%d", len(pipeline_chain))

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=sample_rate,
            audio_out_sample_rate=sample_rate,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        observers=[cost_tracker, langfuse_observer],
    )
    logger.info("[startup] Pipeline task created")

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


async def _trigger_on_demand_newsletter(
    supabase: Client,
    user_id: str,
    target_date_str: str,
    api_key: str,
) -> None:
    """Fire-and-forget background task for on-demand newsletter generation.

    Runs the sync generate_on_demand_for_user in a thread so it does not
    block the event loop.

    Args:
        supabase: Supabase client for DB operations.
        user_id: The user to generate a summary for.
        target_date_str: ISO date string (YYYY-MM-DD) to summarize.
        api_key: OpenRouter API key for LLM calls.
    """
    try:
        from src.newsletter import generate_on_demand_for_user
        target_date = date.fromisoformat(target_date_str)
        await asyncio.to_thread(
            generate_on_demand_for_user, supabase, user_id, target_date, api_key
        )
    except Exception as exc:
        logger.warning("[pipeline] On-demand newsletter generation failed: %s", exc)


def _register_tool_handler(
    llm: TrackedOpenAILLMService,
    tool_name: str,
    session: ActiveSession,
    user_context: UserContext,
    email_ctx: EmailClientContext,
    email_lock: asyncio.Lock,
    supabase: Client,
    langfuse_observer: LangfuseObserver,
    deepgram_api_key: str,
    tts_sample_rate: int,
    tts_voice: str,
    narration_http_session: dict[str, aiohttp.ClientSession | None],
    openrouter_api_key: str,
) -> None:
    """Register a single function call handler on the LLM service.

    The handler wraps handle_tool_call in asyncio.to_thread() since
    email operations may be synchronous (IMAP). An asyncio.Lock serializes
    access (imapclient is not thread-safe, and Unipile benefits from
    serialized access too). A timeout ensures the handler returns an error
    before pipecat's hardcoded "COMPLETED" fires.

    The timeout_secs on register_function() is a safety net (20s) that
    accounts for lock wait time + operation timeout. The manual asyncio.wait_for()
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
        user_context: User context for approval config.
        email_ctx: Provider-aware email client context (IMAP/SMTP or Unipile).
        email_lock: Shared asyncio.Lock to serialize email access.
        supabase: Supabase client.
        langfuse_observer: Observer for Langfuse tracing.
        deepgram_api_key: Deepgram API key for HTTP TTS narration.
        tts_sample_rate: Audio sample rate for narration synthesis.
        tts_voice: Deepgram voice model for narration synthesis.
        narration_http_session: Shared mutable dict holding the aiohttp session.
        openrouter_api_key: OpenRouter API key for on-demand newsletter generation.
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

            # Lock serializes email access (imapclient is not thread-safe,
            # and Unipile benefits from serialized access too).
            # Timeout ensures we return an error before pipecat sends "COMPLETED".
            async with email_lock:
                action_result = await asyncio.wait_for(
                    asyncio.to_thread(
                        handle_tool_call,
                        action_input,
                        user_context.tool_approval_config,
                        email_ctx,
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

            # If the tool returned an on_demand_task, spawn background generation
            if isinstance(action_result.result, dict) and "on_demand_task" in action_result.result:
                on_demand = action_result.result["on_demand_task"]
                asyncio.create_task(_trigger_on_demand_newsletter(
                    supabase,
                    on_demand["user_id"],
                    on_demand["target_date"],
                    openrouter_api_key,
                ))
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
