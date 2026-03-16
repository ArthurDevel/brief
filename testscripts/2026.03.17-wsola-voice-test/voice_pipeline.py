"""
Voice conversation pipeline using Pipecat with Deepgram STT/TTS over WebRTC.

Opens a browser UI at http://localhost:7860/client. The browser handles
echo cancellation natively via WebRTC, so interruptions work cleanly.

Uses WSOLA (pure numpy) for pitch-preserving speed adjustment instead of SoundTouch.

Pipeline: browser mic -> VAD -> STT -> LLM -> TTS -> speed adjust -> browser speaker
"""

import atexit
import os
import sys
import time

import numpy as np
from dotenv import load_dotenv
from loguru import logger

from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import Frame, InputAudioRawFrame, LLMRunFrame, MetricsFrame, TTSAudioRawFrame, TextFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
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

DEEPGRAM_TTS_VOICE = "aura-2-helena-en"

SYSTEM_PROMPT = """You are a helpful voice assistant. Keep your responses concise
and conversational -- aim for 1-3 sentences unless the user asks for detail.
You are having a real-time voice conversation, so be natural and responsive."""

VAD_STOP_SECS = 0.2
VAD_CONFIDENCE = 0.7
MIN_INTERRUPT_WORDS = 3
TTS_SPEED = 1.5

# Shared config dict — updated live by the control UI sliders.
_audio_config = {
    "speed": TTS_SPEED,
}

# Pricing (USD)
LLM_COST_PER_INPUT_TOKEN = 0.15 / 1_000_000
LLM_COST_PER_OUTPUT_TOKEN = 0.60 / 1_000_000
TTS_COST_PER_CHAR = 0.015 / 1_000
STT_COST_PER_MINUTE = 0.0043

# WSOLA parameters
WINDOW_SIZE_MS: int = 25         # analysis window size in milliseconds
OVERLAP_RATIO: float = 0.5       # overlap fraction of window size
MAX_SEEK_MS: int = 10            # max cross-correlation search range in ms


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _normalized_cross_correlation(a: np.ndarray, b: np.ndarray) -> float:
    """Compute normalized cross-correlation between two signals.

    Args:
        a: First signal (float32).
        b: Second signal (float32), same length as a.

    Returns:
        Correlation coefficient in range [-1.0, 1.0].
    """
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a < 1e-8 or norm_b < 1e-8:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def _float_to_int16(samples: np.ndarray) -> np.ndarray:
    """Convert float32 [-1.0, 1.0] samples to int16.

    Args:
        samples: Float32 audio samples.

    Returns:
        Int16 audio samples, clipped to valid range.
    """
    return np.clip(samples * 32768.0, -32768, 32767).astype(np.int16)


# ============================================================================
# WSOLA STREAMER — pitch-preserving tempo change via pure numpy
# ============================================================================

class WSOLAStreamer:
    """Streaming WSOLA time-stretcher operating on int16 PCM audio.

    Uses overlapping analysis windows with cross-correlation to find optimal
    overlap points, preserving pitch while changing tempo.
    """

    def __init__(self, sample_rate: int, num_channels: int, tempo: float) -> None:
        """Initialize the WSOLA streamer.

        Args:
            sample_rate: Audio sample rate in Hz (e.g., 16000).
            num_channels: Number of audio channels (1 for mono).
            tempo: Playback speed multiplier (0.5 to 2.0). 1.0 = normal speed.
        """
        if not 0.5 <= tempo <= 2.0:
            raise ValueError(f"Tempo must be between 0.5 and 2.0, got {tempo}")
        if num_channels != 1:
            raise ValueError(f"Only mono audio supported, got {num_channels} channels")

        self._sample_rate: int = sample_rate
        self._num_channels: int = num_channels
        self._tempo: float = tempo

        # Window and overlap sizes in samples
        self._window_size: int = int(sample_rate * WINDOW_SIZE_MS / 1000)
        self._overlap_size: int = int(self._window_size * OVERLAP_RATIO)
        self._max_seek: int = int(sample_rate * MAX_SEEK_MS / 1000)

        # Analysis hop = how far we advance in the INPUT per window
        # Synthesis hop = how far we advance in the OUTPUT per window
        # For tempo > 1.0 (speed up): analysis_hop > synthesis_hop
        # For tempo < 1.0 (slow down): analysis_hop < synthesis_hop
        self._synthesis_hop: int = self._window_size - self._overlap_size
        self._analysis_hop: int = int(self._synthesis_hop * tempo)

        # Build the Hann window for overlap-add
        self._window: np.ndarray = np.hanning(self._window_size).astype(np.float32)

        # Internal buffer for accumulating input samples (float32)
        self._input_buffer: np.ndarray = np.empty(0, dtype=np.float32)

        # Output buffer for overlap-add accumulation
        self._output_buffer: np.ndarray = np.empty(0, dtype=np.float32)

        # Current read position in the input buffer
        self._read_pos: int = 0

        # Track whether this is the first window (no cross-correlation needed)
        self._first_window: bool = True

    def set_tempo(self, tempo: float) -> None:
        """Update the playback speed.

        Args:
            tempo: New speed multiplier (0.5 to 2.0).
        """
        if not 0.5 <= tempo <= 2.0:
            raise ValueError(f"Tempo must be between 0.5 and 2.0, got {tempo}")
        self._tempo = tempo
        self._analysis_hop = int(self._synthesis_hop * tempo)

    def process(self, audio_bytes: bytes) -> bytes:
        """Feed int16 PCM audio in and return tempo-adjusted int16 PCM out.

        Args:
            audio_bytes: Raw int16 PCM audio bytes.

        Returns:
            Tempo-adjusted int16 PCM audio bytes. May return empty bytes
            if still buffering.
        """
        # Convert input to float32 [-1.0, 1.0]
        new_samples = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        self._input_buffer = np.concatenate([self._input_buffer, new_samples])

        # Process as many windows as we can
        output_chunks: list[np.ndarray] = []

        while self._can_process_window():
            chunk = self._process_one_window()
            if chunk is not None and len(chunk) > 0:
                output_chunks.append(chunk)

        if not output_chunks:
            return b""

        # Concatenate and convert back to int16
        output = np.concatenate(output_chunks)
        output_int16 = _float_to_int16(output)
        return output_int16.tobytes()

    def flush(self) -> bytes:
        """Flush remaining audio from internal buffers.

        Returns:
            Any remaining tempo-adjusted int16 PCM audio bytes.
        """
        # Pad input buffer to allow processing remaining data
        pad_size = self._window_size + self._max_seek
        padding = np.zeros(pad_size, dtype=np.float32)
        self._input_buffer = np.concatenate([self._input_buffer, padding])

        output_chunks: list[np.ndarray] = []
        while self._can_process_window():
            chunk = self._process_one_window()
            if chunk is not None and len(chunk) > 0:
                output_chunks.append(chunk)

        if not output_chunks:
            return b""

        output = np.concatenate(output_chunks)
        output_int16 = _float_to_int16(output)
        return output_int16.tobytes()

    def _can_process_window(self) -> bool:
        """Check if we have enough input data to extract another window."""
        required = self._read_pos + self._window_size + self._max_seek
        return required <= len(self._input_buffer)

    def _process_one_window(self) -> np.ndarray | None:
        """Extract and process one WSOLA window.

        Returns:
            The overlap-added output samples for this window, or None.
        """
        if self._first_window:
            # First window: just take it directly, no cross-correlation
            segment = self._input_buffer[self._read_pos:self._read_pos + self._window_size]
            windowed = segment * self._window
            self._first_window = False
            self._read_pos += self._analysis_hop

            # Initialize output buffer with this first window
            self._output_buffer = windowed.copy()
            return np.empty(0, dtype=np.float32)

        # Find optimal overlap position using cross-correlation
        best_offset = self._find_best_offset()
        actual_pos = self._read_pos + best_offset

        # Extract the segment at the optimal position
        segment = self._input_buffer[actual_pos:actual_pos + self._window_size]
        windowed = segment * self._window

        # Overlap-add with the tail of the output buffer
        # The last overlap_size samples of output_buffer overlap with the
        # first overlap_size samples of the new windowed segment
        output_len = len(self._output_buffer)

        if output_len >= self._overlap_size:
            # Extract the non-overlapping part as finalized output
            finalized = self._output_buffer[:output_len - self._overlap_size].copy()

            # Get the overlap tail from the previous output
            overlap_tail = self._output_buffer[output_len - self._overlap_size:].copy()

            # Cross-fade in the overlap region
            overlap_head = windowed[:self._overlap_size]
            crossfaded = overlap_tail + overlap_head

            # Build new output buffer: crossfaded region + rest of new window
            self._output_buffer = np.concatenate([crossfaded, windowed[self._overlap_size:]])
        else:
            # Output buffer is shorter than overlap -- just append
            finalized = np.empty(0, dtype=np.float32)
            self._output_buffer = np.concatenate([self._output_buffer, windowed])

        self._read_pos += self._analysis_hop
        self._compact_input_buffer()

        return finalized

    def _find_best_offset(self) -> int:
        """Find the offset within search range that best matches the overlap tail.

        Uses normalized cross-correlation between the end of the current output
        and candidate segments in the input buffer.

        Returns:
            Best offset relative to self._read_pos (can be negative).
        """
        if len(self._output_buffer) < self._overlap_size:
            return 0

        # The reference: last overlap_size samples of the output buffer
        reference = self._output_buffer[-self._overlap_size:]

        best_offset: int = 0
        best_corr: float = -1.0

        # Search around the nominal read position
        search_start = max(0, -self._max_seek)
        search_end = self._max_seek

        for offset in range(search_start, search_end + 1):
            pos = self._read_pos + offset
            if pos < 0 or pos + self._overlap_size > len(self._input_buffer):
                continue

            candidate = self._input_buffer[pos:pos + self._overlap_size]
            corr = _normalized_cross_correlation(reference, candidate)

            if corr > best_corr:
                best_corr = corr
                best_offset = offset

        return best_offset

    def _compact_input_buffer(self) -> None:
        """Remove consumed samples from the input buffer to limit memory use."""
        # Keep a margin before read_pos for cross-correlation search
        safe_pos = max(0, self._read_pos - self._max_seek)
        if safe_pos > 0:
            self._input_buffer = self._input_buffer[safe_pos:]
            self._read_pos -= safe_pos


# ============================================================================
# AUDIO SPEED PROCESSOR — Pipecat FrameProcessor wrapping WSOLAStreamer
# ============================================================================

class AudioSpeedProcessor(FrameProcessor):
    """Pipecat processor that adjusts TTS playback speed without changing pitch.

    Reads speed live from a shared config dict.
    """

    def __init__(self, config: dict, **kwargs):
        super().__init__(**kwargs)
        self._config = config
        self._streamer: WSOLAStreamer | None = None
        self._sample_rate: int = 0
        self._num_channels: int = 0

    def _ensure_streamer(self, sample_rate: int, num_channels: int):
        if self._streamer is None or sample_rate != self._sample_rate or num_channels != self._num_channels:
            if self._streamer is not None:
                pass  # WSOLAStreamer has no destroy method
            self._sample_rate = sample_rate
            self._num_channels = num_channels
            self._streamer = WSOLAStreamer(sample_rate, num_channels, self._config["speed"])
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

        if isinstance(frame, TextFrame) and hasattr(frame, "text") and frame.text:
            dest_name = type(data.destination).__name__
            if "TTS" in dest_name or "Deepgram" in dest_name:
                self.tts_characters += len(frame.text)

        if isinstance(frame, InputAudioRawFrame):
            source_name = type(data.source).__name__
            if "Transport" in source_name or "Input" in source_name:
                num_samples = len(frame.audio) / 2
                self.stt_audio_seconds += num_samples / frame.sample_rate

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
# PIPELINE
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

    stt = DeepgramSTTService(api_key=deepgram_key)

    llm = OpenAILLMService(
        api_key=openrouter_key,
        base_url=OPENROUTER_BASE_URL,
        settings=OpenAILLMService.Settings(model=LLM_MODEL),
    )

    tts = DeepgramTTSService(
        api_key=deepgram_key,
        settings=DeepgramTTSService.Settings(voice=DEEPGRAM_TTS_VOICE),
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

    speed_processor = AudioSpeedProcessor(config=_audio_config)

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


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    from control_ui import patch_server_app
    patch_server_app(_audio_config)

    from pipecat.runner.run import main
    main()
