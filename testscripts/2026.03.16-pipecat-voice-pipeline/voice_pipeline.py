"""
Voice conversation pipeline using Pipecat with Deepgram STT/TTS over WebRTC.

Opens a browser UI at http://localhost:7860/client. The browser handles
echo cancellation natively via WebRTC, so interruptions work cleanly.

Pipeline: browser mic -> VAD -> STT -> LLM -> TTS -> speed adjust -> browser speaker
"""

import ctypes
import os
import sys

import numpy as np
from dotenv import load_dotenv
from loguru import logger

from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import Frame, LLMRunFrame, TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.services.llm_service import LLMContext

from cost_tracking import (
    UsageTracker,
    TrackedDeepgramSTTService,
    TrackedDeepgramTTSService,
    TrackedOpenAILLMService,
    fetch_actual_costs,
    print_cost_summary,
)
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

DEEPGRAM_TTS_VOICE = "aura-2-helena-en"

SYSTEM_PROMPT = """You are a helpful voice assistant. Keep your responses concise
and conversational -- aim for 1-3 sentences unless the user asks for detail.
You are having a real-time voice conversation, so be natural and responsive."""

VAD_STOP_SECS = 0.2
VAD_CONFIDENCE = 0.7
MIN_INTERRUPT_WORDS = 3
TTS_SPEED = 1.5

# Shared state — updated live by the control UI and cost tracking.
_shared_state = {
    "audio_config": {"speed": TTS_SPEED},
    "session_costs": None,  # populated after disconnect
}


# ============================================================================
# SOUNDTOUCH STREAMER — pitch-preserving tempo change via libSoundTouch
# ============================================================================

class SoundTouchStreamer:
    """Streaming tempo changer using libSoundTouch via ctypes.

    Maintains internal state across calls so consecutive chunks connect
    seamlessly (no boundary artifacts).
    """

    _lib = None

    @classmethod
    def _load_lib(cls):
        if cls._lib is not None:
            return cls._lib
        lib = ctypes.cdll.LoadLibrary("/opt/homebrew/lib/libSoundTouchDll.dylib")
        lib.soundtouch_createInstance.restype = ctypes.c_void_p
        lib.soundtouch_destroyInstance.argtypes = [ctypes.c_void_p]
        lib.soundtouch_setChannels.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        lib.soundtouch_setSampleRate.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        lib.soundtouch_setTempo.argtypes = [ctypes.c_void_p, ctypes.c_float]
        lib.soundtouch_putSamples_i16.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_int16), ctypes.c_uint,
        ]
        lib.soundtouch_receiveSamples_i16.argtypes = [
            ctypes.c_void_p, ctypes.POINTER(ctypes.c_int16), ctypes.c_uint,
        ]
        lib.soundtouch_receiveSamples_i16.restype = ctypes.c_uint
        lib.soundtouch_numSamples.argtypes = [ctypes.c_void_p]
        lib.soundtouch_numSamples.restype = ctypes.c_uint
        lib.soundtouch_flush.argtypes = [ctypes.c_void_p]
        lib.soundtouch_clear.argtypes = [ctypes.c_void_p]
        cls._lib = lib
        return lib

    def __init__(self, sample_rate: int, num_channels: int, tempo: float = 1.0):
        lib = self._load_lib()
        self._lib = lib
        self._handle = lib.soundtouch_createInstance()
        self._tempo = -1.0
        lib.soundtouch_setSampleRate(self._handle, sample_rate)
        lib.soundtouch_setChannels(self._handle, num_channels)
        self._num_channels = num_channels
        self.set_tempo(tempo)

    def set_tempo(self, tempo: float):
        if tempo != self._tempo:
            self._lib.soundtouch_setTempo(self._handle, ctypes.c_float(tempo))
            self._tempo = tempo

    def process(self, audio: bytes) -> bytes:
        """Feed int16 PCM in, get tempo-adjusted int16 PCM out."""
        in_arr = np.frombuffer(audio, dtype=np.int16).copy()
        num_frames = len(in_arr) // self._num_channels
        in_ptr = in_arr.ctypes.data_as(ctypes.POINTER(ctypes.c_int16))
        self._lib.soundtouch_putSamples_i16(self._handle, in_ptr, num_frames)

        max_frames = num_frames * 2
        out_buf = np.empty(max_frames * self._num_channels, dtype=np.int16)
        out_ptr = out_buf.ctypes.data_as(ctypes.POINTER(ctypes.c_int16))
        got = self._lib.soundtouch_receiveSamples_i16(self._handle, out_ptr, max_frames)
        if got == 0:
            return b""
        return out_buf[: got * self._num_channels].tobytes()

    def destroy(self):
        if self._handle is not None:
            self._lib.soundtouch_destroyInstance(self._handle)
            self._handle = None


# ============================================================================
# AUDIO SPEED PROCESSOR — Pipecat FrameProcessor wrapping SoundTouchStreamer
# ============================================================================

class AudioSpeedProcessor(FrameProcessor):
    """Pipecat processor that adjusts TTS playback speed without changing pitch.

    Reads speed live from a shared config dict.
    """

    def __init__(self, config: dict, **kwargs):
        super().__init__(**kwargs)
        self._config = config
        self._streamer: SoundTouchStreamer | None = None
        self._sample_rate: int = 0
        self._num_channels: int = 0

    def _ensure_streamer(self, sample_rate: int, num_channels: int):
        if self._streamer is None or sample_rate != self._sample_rate or num_channels != self._num_channels:
            if self._streamer is not None:
                self._streamer.destroy()
            self._sample_rate = sample_rate
            self._num_channels = num_channels
            self._streamer = SoundTouchStreamer(sample_rate, num_channels, self._config["speed"])
        else:
            self._streamer.set_tempo(self._config["speed"])

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TTSAudioRawFrame) and self._config["speed"] != 1.0:
            self._ensure_streamer(frame.sample_rate, frame.num_channels)
            out_bytes = self._streamer.process(frame.audio)
            if out_bytes:
                frame = TTSAudioRawFrame(
                    audio=out_bytes,
                    sample_rate=frame.sample_rate,
                    num_channels=frame.num_channels,
                    context_id=frame.context_id,
                )
                await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)


# ============================================================================
# PIPELINE
# ============================================================================

async def run_bot(transport: BaseTransport, usage_tracker: UsageTracker):
    deepgram_key = os.getenv("DEEPGRAM_API_KEY")
    openrouter_key = os.getenv("OPENROUTER_API_KEY")

    if not deepgram_key:
        logger.error("DEEPGRAM_API_KEY not set in .env")
        sys.exit(1)
    if not openrouter_key:
        logger.error("OPENROUTER_API_KEY not set in .env")
        sys.exit(1)

    stt = TrackedDeepgramSTTService(
        api_key=deepgram_key,
    )

    llm = TrackedOpenAILLMService(
        usage_tracker=usage_tracker,
        api_key=openrouter_key,
        base_url=OPENROUTER_BASE_URL,
        settings=TrackedOpenAILLMService.Settings(model=LLM_MODEL),
    )

    tts = TrackedDeepgramTTSService(
        usage_tracker=usage_tracker,
        api_key=deepgram_key,
        settings=TrackedDeepgramTTSService.Settings(voice=DEEPGRAM_TTS_VOICE),
    )

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

    speed_processor = AudioSpeedProcessor(config=_shared_state["audio_config"])

    pipeline = Pipeline([
        transport.input(),
        stt,
        user_aggregator,
        llm,
        tts,
        speed_processor,
        transport.output(),
        assistant_aggregator,
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected — starting conversation")
        _shared_state["session_costs"] = None
        context.add_message(
            {"role": "user", "content": "Say hello and briefly introduce yourself."}
        )
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected — fetching actual costs...")
        costs = await fetch_actual_costs(usage_tracker, openrouter_key)
        _shared_state["session_costs"] = costs
        print_cost_summary(costs)
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)


async def bot(runner_args: RunnerArguments):
    """Entry point called by pipecat runner."""
    usage_tracker = UsageTracker()

    transport = SmallWebRTCTransport(
        webrtc_connection=runner_args.webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    )
    await run_bot(transport, usage_tracker)


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    from control_ui import patch_server_app
    patch_server_app(_shared_state)

    from pipecat.runner.run import main
    main()
