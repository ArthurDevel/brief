"""
WSOLA pitch-preserving speed processor for TTS audio.

Uses a pure-numpy WSOLA (Waveform Similarity Overlap-Add) algorithm to apply
tempo changes to audio frames without altering pitch. No native dependencies.

- WSOLAStreamer: streaming WSOLA time-stretcher with cross-correlation overlap
- AudioSpeedProcessor: Pipecat FrameProcessor that intercepts TTS audio frames
"""

from __future__ import annotations

import numpy as np

from pipecat.frames.frames import Frame, TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


# ============================================================================
# CONSTANTS
# ============================================================================

WINDOW_SIZE_MS: int = 25          # analysis window size in milliseconds
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
# WSOLA STREAMER
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
# PIPECAT FRAME PROCESSOR
# ============================================================================

class AudioSpeedProcessor(FrameProcessor):
    """Pipecat FrameProcessor that applies pitch-preserving tempo change to TTS audio.

    Intercepts TTSAudioRawFrame, processes through WSOLA, and passes
    through all other frame types unchanged. Reads speed from a shared
    config dict so it can be updated live via an API endpoint.
    """

    def __init__(self, config: dict, sample_rate: int = 16000, num_channels: int = 1) -> None:
        """Initialize the speed processor.

        Args:
            config: Shared mutable dict with a "speed" key (float, 0.5-2.0).
            sample_rate: Audio sample rate in Hz.
            num_channels: Number of audio channels.
        """
        super().__init__()
        self._config = config
        self._sample_rate = sample_rate
        self._num_channels = num_channels
        self._streamer: WSOLAStreamer | None = None

    def _ensure_streamer(self, sample_rate: int, num_channels: int) -> None:
        """Create or update the WSOLA streamer to match current speed config."""
        speed = self._config.get("speed", 1.0)
        if self._streamer is None or sample_rate != self._sample_rate or num_channels != self._num_channels:
            self._sample_rate = sample_rate
            self._num_channels = num_channels
            self._streamer = WSOLAStreamer(sample_rate, num_channels, speed)
        else:
            self._streamer.set_tempo(speed)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Process a pipeline frame. Applies tempo change to TTS audio frames.

        Args:
            frame: The pipeline frame.
            direction: The direction the frame is traveling.
        """
        await super().process_frame(frame, direction)

        if isinstance(frame, TTSAudioRawFrame) and self._config.get("speed", 1.0) != 1.0:
            self._ensure_streamer(frame.sample_rate, frame.num_channels)
            assert self._streamer is not None
            processed_audio = self._streamer.process(frame.audio)
            if processed_audio:
                new_frame = TTSAudioRawFrame(
                    audio=processed_audio,
                    sample_rate=frame.sample_rate,
                    num_channels=frame.num_channels,
                )
                await self.push_frame(new_frame, direction)
        else:
            await self.push_frame(frame, direction)
