"""
WSOLA (Waveform Similarity Overlap-Add) speed processor test.

Validates a pure-numpy WSOLA implementation as a drop-in replacement for
SoundTouch. No native dependencies required -- only numpy.

- WSOLAStreamer: streaming WSOLA time-stretcher with cross-correlation overlap
- Batch test: generates sine wave, processes at multiple tempos, saves WAVs
- Streaming test: feeds audio in small 20ms chunks (matching Pipecat frames)
- Duration ratio verification for correctness
"""

from __future__ import annotations

import os
import struct
import sys
import time
from pathlib import Path

import numpy as np

try:
    import soundfile as sf
except ImportError:
    print("ERROR: soundfile not installed. Run: pip install soundfile")
    sys.exit(1)


# =============================================================================
# CONSTANTS
# =============================================================================

SAMPLE_RATE: int = 16000
NUM_CHANNELS: int = 1

# WSOLA parameters
WINDOW_SIZE_MS: int = 25         # analysis window size in milliseconds
OVERLAP_RATIO: float = 0.5       # overlap fraction of window size
MAX_SEEK_MS: int = 10            # max cross-correlation search range in ms

# Test parameters
TEST_DURATION_SEC: float = 3.0   # length of test sine wave
TEST_FREQ_HZ: float = 440.0     # A4 note
STREAM_CHUNK_MS: int = 20        # Pipecat frame size

TEMPOS: list[float] = [0.8, 1.0, 1.2, 1.5]

OUTPUT_DIR: str = "output"


# =============================================================================
# WSOLA STREAMER
# =============================================================================

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


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

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


def _generate_sine_wave(
    freq_hz: float,
    duration_sec: float,
    sample_rate: int,
) -> np.ndarray:
    """Generate a sine wave as int16 samples.

    Args:
        freq_hz: Frequency in Hz.
        duration_sec: Duration in seconds.
        sample_rate: Sample rate in Hz.

    Returns:
        Int16 numpy array of the sine wave.
    """
    t = np.arange(int(sample_rate * duration_sec)) / sample_rate
    wave = np.sin(2.0 * np.pi * freq_hz * t)
    return (wave * 30000).astype(np.int16)


def _count_samples_from_bytes(audio_bytes: bytes) -> int:
    """Count the number of int16 samples in a byte buffer.

    Args:
        audio_bytes: Raw int16 PCM bytes.

    Returns:
        Number of samples.
    """
    return len(audio_bytes) // 2


# =============================================================================
# BATCH TEST
# =============================================================================

def run_batch_test(test_audio: np.ndarray) -> None:
    """Process the full test audio at each tempo in one shot.

    Saves output WAV files and prints duration ratios.

    Args:
        test_audio: Int16 numpy array of test audio.
    """
    print("=" * 60)
    print("BATCH TEST")
    print("=" * 60)

    input_bytes = test_audio.tobytes()
    input_samples = len(test_audio)
    input_duration = input_samples / SAMPLE_RATE

    print(f"Input: {input_samples} samples, {input_duration:.3f}s")
    print()

    for tempo in TEMPOS:
        streamer = WSOLAStreamer(SAMPLE_RATE, NUM_CHANNELS, tempo)

        t0 = time.perf_counter()
        output_bytes = streamer.process(input_bytes)
        flush_bytes = streamer.flush()
        elapsed = time.perf_counter() - t0

        total_bytes = output_bytes + flush_bytes
        output_samples = _count_samples_from_bytes(total_bytes)
        output_duration = output_samples / SAMPLE_RATE

        expected_duration = input_duration / tempo
        ratio = output_duration / input_duration if input_duration > 0 else 0
        expected_ratio = 1.0 / tempo
        ratio_error = abs(ratio - expected_ratio) / expected_ratio * 100

        print(f"Tempo {tempo:.1f}x:")
        print(f"  Output: {output_samples} samples, {output_duration:.3f}s")
        print(f"  Expected duration: {expected_duration:.3f}s")
        print(f"  Duration ratio: {ratio:.3f} (expected {expected_ratio:.3f}, error {ratio_error:.1f}%)")
        print(f"  Processing time: {elapsed:.4f}s")

        # Save WAV file
        output_array = np.frombuffer(total_bytes, dtype=np.int16)
        output_path = os.path.join(OUTPUT_DIR, f"batch_tempo_{tempo:.1f}x.wav")
        sf.write(output_path, output_array, SAMPLE_RATE, subtype="PCM_16")
        print(f"  Saved: {output_path}")
        print()


# =============================================================================
# STREAMING TEST
# =============================================================================

def run_streaming_test(test_audio: np.ndarray) -> None:
    """Process audio in small chunks to simulate Pipecat's streaming behavior.

    Feeds audio in 20ms frames and collects output incrementally.

    Args:
        test_audio: Int16 numpy array of test audio.
    """
    print("=" * 60)
    print("STREAMING TEST (20ms chunks)")
    print("=" * 60)

    input_bytes = test_audio.tobytes()
    input_samples = len(test_audio)
    input_duration = input_samples / SAMPLE_RATE
    chunk_size_samples = int(SAMPLE_RATE * STREAM_CHUNK_MS / 1000)
    chunk_size_bytes = chunk_size_samples * 2  # int16 = 2 bytes per sample

    print(f"Input: {input_samples} samples, {input_duration:.3f}s")
    print(f"Chunk size: {chunk_size_samples} samples ({STREAM_CHUNK_MS}ms)")
    print()

    for tempo in TEMPOS:
        streamer = WSOLAStreamer(SAMPLE_RATE, NUM_CHANNELS, tempo)

        output_chunks: list[bytes] = []
        num_chunks = 0

        t0 = time.perf_counter()

        # Feed in chunks
        offset = 0
        while offset < len(input_bytes):
            chunk = input_bytes[offset:offset + chunk_size_bytes]
            result = streamer.process(chunk)
            if result:
                output_chunks.append(result)
            offset += chunk_size_bytes
            num_chunks += 1

        # Flush remaining
        flush_result = streamer.flush()
        if flush_result:
            output_chunks.append(flush_result)

        elapsed = time.perf_counter() - t0

        total_output = b"".join(output_chunks)
        output_samples = _count_samples_from_bytes(total_output)
        output_duration = output_samples / SAMPLE_RATE

        expected_duration = input_duration / tempo
        ratio = output_duration / input_duration if input_duration > 0 else 0
        expected_ratio = 1.0 / tempo

        print(f"Tempo {tempo:.1f}x:")
        print(f"  Chunks fed: {num_chunks}")
        print(f"  Output: {output_samples} samples, {output_duration:.3f}s")
        print(f"  Expected duration: {expected_duration:.3f}s")
        print(f"  Duration ratio: {ratio:.3f} (expected {expected_ratio:.3f})")
        print(f"  Processing time: {elapsed:.4f}s")

        # Save WAV file
        output_array = np.frombuffer(total_output, dtype=np.int16)
        output_path = os.path.join(OUTPUT_DIR, f"stream_tempo_{tempo:.1f}x.wav")
        sf.write(output_path, output_array, SAMPLE_RATE, subtype="PCM_16")
        print(f"  Saved: {output_path}")
        print()


# =============================================================================
# CONSISTENCY TEST
# =============================================================================

def run_consistency_test(test_audio: np.ndarray) -> None:
    """Verify that batch and streaming produce the same output length.

    Args:
        test_audio: Int16 numpy array of test audio.
    """
    print("=" * 60)
    print("CONSISTENCY TEST (batch vs streaming)")
    print("=" * 60)

    input_bytes = test_audio.tobytes()
    chunk_size_samples = int(SAMPLE_RATE * STREAM_CHUNK_MS / 1000)
    chunk_size_bytes = chunk_size_samples * 2

    for tempo in TEMPOS:
        # Batch
        batch_streamer = WSOLAStreamer(SAMPLE_RATE, NUM_CHANNELS, tempo)
        batch_out = batch_streamer.process(input_bytes) + batch_streamer.flush()
        batch_samples = _count_samples_from_bytes(batch_out)

        # Streaming
        stream_streamer = WSOLAStreamer(SAMPLE_RATE, NUM_CHANNELS, tempo)
        stream_chunks: list[bytes] = []
        offset = 0
        while offset < len(input_bytes):
            chunk = input_bytes[offset:offset + chunk_size_bytes]
            result = stream_streamer.process(chunk)
            if result:
                stream_chunks.append(result)
            offset += chunk_size_bytes
        flush_result = stream_streamer.flush()
        if flush_result:
            stream_chunks.append(flush_result)
        stream_samples = _count_samples_from_bytes(b"".join(stream_chunks))

        diff_pct = abs(batch_samples - stream_samples) / max(batch_samples, 1) * 100
        status = "PASS" if diff_pct < 5.0 else "FAIL"

        print(f"Tempo {tempo:.1f}x: batch={batch_samples} stream={stream_samples} diff={diff_pct:.1f}% [{status}]")

    print()


# =============================================================================
# ENTRY POINT
# =============================================================================

def main() -> None:
    """Run all WSOLA tests."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    print()
    print("Generating test sine wave...")
    print(f"  Frequency: {TEST_FREQ_HZ} Hz")
    print(f"  Duration: {TEST_DURATION_SEC} s")
    print(f"  Sample rate: {SAMPLE_RATE} Hz")
    print()

    test_audio = _generate_sine_wave(TEST_FREQ_HZ, TEST_DURATION_SEC, SAMPLE_RATE)

    # Save the original for reference
    original_path = os.path.join(OUTPUT_DIR, "original.wav")
    sf.write(original_path, test_audio, SAMPLE_RATE, subtype="PCM_16")
    print(f"Saved original: {original_path}")
    print()

    run_batch_test(test_audio)
    run_streaming_test(test_audio)
    run_consistency_test(test_audio)

    print("=" * 60)
    print("ALL TESTS COMPLETE")
    print("=" * 60)
    print(f"WAV files saved to: {os.path.abspath(OUTPUT_DIR)}/")
    print("Listen to the output files to verify pitch is preserved.")


if __name__ == "__main__":
    main()
