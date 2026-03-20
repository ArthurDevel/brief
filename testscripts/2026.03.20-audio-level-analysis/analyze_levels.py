"""
Audio level analyzer for TTS + WSOLA pipeline.

Fetches TTS audio from Deepgram, runs it through the WSOLA speed processor,
and measures peak/RMS levels at each stage to determine available headroom.

Responsibilities:
- Fetch PCM16 audio from Deepgram HTTP TTS API
- Process audio through WSOLA at 1.5x and 1.0x speeds
- Measure peak, RMS, headroom, and crest factor at each stage
- Save WAV files for manual listening
- Print a summary table with recommended gain
"""

from __future__ import annotations

import os
import struct
import sys
import wave
from dataclasses import dataclass

import numpy as np
import requests
from dotenv import load_dotenv


# ============================================================================
# CONSTANTS
# ============================================================================

SAMPLE_RATE: int = 16000
NUM_CHANNELS: int = 1
BITS_PER_SAMPLE: int = 16
TARGET_PEAK_DBFS: float = -3.0  # target peak level (leave safety margin)

TEST_PHRASES: list[str] = [
    "You have three new emails in your inbox.",
    "I've drafted a reply to the meeting invitation from Sarah. Shall I send it?",
    "Archiving those emails now.",
]

OUTPUT_DIR: str = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")

# WSOLA constants (copied from voice-pipeline)
WINDOW_SIZE_MS: int = 25
OVERLAP_RATIO: float = 0.5
MAX_SEEK_MS: int = 10


# ============================================================================
# WSOLA IMPLEMENTATION (copied from apps/voice-pipeline/src/audio/speed.py)
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

        self._synthesis_hop: int = self._window_size - self._overlap_size
        self._analysis_hop: int = int(self._synthesis_hop * tempo)

        self._window: np.ndarray = np.hanning(self._window_size).astype(np.float32)
        self._input_buffer: np.ndarray = np.empty(0, dtype=np.float32)
        self._output_buffer: np.ndarray = np.empty(0, dtype=np.float32)
        self._read_pos: int = 0
        self._first_window: bool = True

    def process(self, audio_bytes: bytes) -> bytes:
        """Feed int16 PCM audio in and return tempo-adjusted int16 PCM out.

        Args:
            audio_bytes: Raw int16 PCM audio bytes.

        Returns:
            Tempo-adjusted int16 PCM audio bytes.
        """
        new_samples = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        self._input_buffer = np.concatenate([self._input_buffer, new_samples])

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

    def flush(self) -> bytes:
        """Flush remaining audio from internal buffers.

        Returns:
            Any remaining tempo-adjusted int16 PCM audio bytes.
        """
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
            segment = self._input_buffer[self._read_pos:self._read_pos + self._window_size]
            windowed = segment * self._window
            self._first_window = False
            self._read_pos += self._analysis_hop
            self._output_buffer = windowed.copy()
            return np.empty(0, dtype=np.float32)

        best_offset = self._find_best_offset()
        actual_pos = self._read_pos + best_offset

        segment = self._input_buffer[actual_pos:actual_pos + self._window_size]
        windowed = segment * self._window

        output_len = len(self._output_buffer)
        if output_len >= self._overlap_size:
            finalized = self._output_buffer[:output_len - self._overlap_size].copy()
            overlap_tail = self._output_buffer[output_len - self._overlap_size:].copy()
            overlap_head = windowed[:self._overlap_size]
            crossfaded = overlap_tail + overlap_head
            self._output_buffer = np.concatenate([crossfaded, windowed[self._overlap_size:]])
        else:
            finalized = np.empty(0, dtype=np.float32)
            self._output_buffer = np.concatenate([self._output_buffer, windowed])

        self._read_pos += self._analysis_hop
        self._compact_input_buffer()
        return finalized

    def _find_best_offset(self) -> int:
        """Find the offset within search range that best matches the overlap tail.

        Returns:
            Best offset relative to self._read_pos.
        """
        if len(self._output_buffer) < self._overlap_size:
            return 0

        reference = self._output_buffer[-self._overlap_size:]
        best_offset: int = 0
        best_corr: float = -1.0

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
        safe_pos = max(0, self._read_pos - self._max_seek)
        if safe_pos > 0:
            self._input_buffer = self._input_buffer[safe_pos:]
            self._read_pos -= safe_pos


# ============================================================================
# AUDIO MEASUREMENT
# ============================================================================

@dataclass
class AudioMeasurement:
    """Holds measured audio level data for a single audio sample."""
    label: str
    peak_sample: int
    peak_dbfs: float
    rms_dbfs: float
    headroom_db: float
    crest_factor_db: float
    recommended_gain: float
    num_samples: int


def measure_audio_levels(pcm_bytes: bytes, label: str) -> AudioMeasurement:
    """Measure peak, RMS, headroom, and crest factor of PCM16 audio.

    Args:
        pcm_bytes: Raw int16 PCM audio bytes.
        label: Descriptive label for this measurement.

    Returns:
        AudioMeasurement with all computed values.
    """
    if len(pcm_bytes) == 0:
        raise ValueError(f"Empty audio data for: {label}")

    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float64)
    num_samples = len(samples)

    # Peak measurement
    peak_sample = int(np.max(np.abs(samples)))
    if peak_sample == 0:
        raise ValueError(f"Silent audio (all zeros) for: {label}")

    peak_dbfs = 20.0 * np.log10(peak_sample / 32768.0)

    # RMS measurement
    rms = np.sqrt(np.mean(samples ** 2))
    rms_dbfs = 20.0 * np.log10(rms / 32768.0) if rms > 0 else -120.0

    # Headroom: how much gain before clipping
    headroom_db = 0.0 - peak_dbfs  # 0 dBFS is the ceiling

    # Crest factor: peak-to-RMS ratio
    crest_factor_db = peak_dbfs - rms_dbfs

    # Recommended gain to reach target peak
    gain_db_needed = TARGET_PEAK_DBFS - peak_dbfs
    recommended_gain = 10.0 ** (gain_db_needed / 20.0)

    return AudioMeasurement(
        label=label,
        peak_sample=peak_sample,
        peak_dbfs=round(peak_dbfs, 2),
        rms_dbfs=round(rms_dbfs, 2),
        headroom_db=round(headroom_db, 2),
        crest_factor_db=round(crest_factor_db, 2),
        recommended_gain=round(recommended_gain, 3),
        num_samples=num_samples,
    )


# ============================================================================
# DEEPGRAM TTS
# ============================================================================

def fetch_tts_audio(api_key: str, phrase: str) -> bytes:
    """Fetch PCM16 audio from Deepgram HTTP TTS API.

    Args:
        api_key: Deepgram API key.
        phrase: Text to synthesize.

    Returns:
        Raw PCM16 audio bytes (16kHz, mono, linear16).
    """
    url = "https://api.deepgram.com/v1/speak"
    headers = {
        "Authorization": f"Token {api_key}",
        "Content-Type": "application/json",
    }
    params = {
        "model": "aura-2-helena-en",
        "encoding": "linear16",
        "sample_rate": SAMPLE_RATE,
        "container": "none",
    }

    response = requests.post(url, headers=headers, json={"text": phrase}, params=params)
    if response.status_code != 200:
        raise RuntimeError(
            f"Deepgram TTS failed (HTTP {response.status_code}): {response.text}"
        )

    if len(response.content) == 0:
        raise RuntimeError(f"Deepgram returned empty audio for: {phrase}")

    return response.content


# ============================================================================
# WAV FILE WRITING
# ============================================================================

def save_wav(pcm_bytes: bytes, filepath: str) -> None:
    """Save raw PCM16 bytes as a WAV file.

    Args:
        pcm_bytes: Raw int16 PCM audio bytes.
        filepath: Output WAV file path.
    """
    with wave.open(filepath, "wb") as wf:
        wf.setnchannels(NUM_CHANNELS)
        wf.setsampwidth(BITS_PER_SAMPLE // 8)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm_bytes)


# ============================================================================
# WSOLA PROCESSING
# ============================================================================

def process_wsola(pcm_bytes: bytes, tempo: float) -> bytes:
    """Run PCM16 audio through WSOLA at the given tempo.

    Args:
        pcm_bytes: Raw int16 PCM audio bytes.
        tempo: Speed multiplier (e.g., 1.5 for 1.5x speed).

    Returns:
        Tempo-adjusted int16 PCM audio bytes.
    """
    streamer = WSOLAStreamer(SAMPLE_RATE, NUM_CHANNELS, tempo)
    output = streamer.process(pcm_bytes)
    flushed = streamer.flush()
    return output + flushed


# ============================================================================
# SUMMARY TABLE
# ============================================================================

def print_summary_table(measurements: list[AudioMeasurement]) -> None:
    """Print a formatted summary table of all measurements.

    Args:
        measurements: List of AudioMeasurement objects to display.
    """
    # Header
    header = (
        f"{'Label':<45} {'Peak':>6} {'Peak dBFS':>10} {'RMS dBFS':>10} "
        f"{'Headroom':>10} {'Crest':>8} {'Gain':>6}"
    )
    separator = "-" * len(header)

    print()
    print(separator)
    print("AUDIO LEVEL ANALYSIS RESULTS")
    print(separator)
    print(header)
    print(separator)

    for m in measurements:
        print(
            f"{m.label:<45} {m.peak_sample:>6} {m.peak_dbfs:>10.2f} {m.rms_dbfs:>10.2f} "
            f"{m.headroom_db:>10.2f} {m.crest_factor_db:>8.2f} {m.recommended_gain:>6.3f}"
        )

    print(separator)
    print()
    print(f"Target peak: {TARGET_PEAK_DBFS} dBFS")
    print(f"Gain column: multiplier needed to reach target peak of {TARGET_PEAK_DBFS} dBFS")
    print()


# ============================================================================
# ENTRY POINT
# ============================================================================

def main() -> None:
    """Main entry point. Fetches TTS audio, processes through WSOLA, measures levels."""

    # Load API key
    load_dotenv()
    api_key = os.getenv("DEEPGRAM_API_KEY")
    if not api_key:
        raise RuntimeError("DEEPGRAM_API_KEY not found in .env file")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    all_measurements: list[AudioMeasurement] = []

    for i, phrase in enumerate(TEST_PHRASES, start=1):
        print(f"Processing phrase {i}/{len(TEST_PHRASES)}: \"{phrase[:50]}...\"")

        # Step 1: Fetch raw TTS audio from Deepgram
        raw_pcm = fetch_tts_audio(api_key, phrase)
        print(f"  Received {len(raw_pcm)} bytes ({len(raw_pcm) // 2} samples)")

        # Step 2: Process through WSOLA at 1.5x and 1.0x
        wsola_1_5x_pcm = process_wsola(raw_pcm, tempo=1.5)
        wsola_1_0x_pcm = process_wsola(raw_pcm, tempo=1.0)

        # Step 3: Save WAV files
        save_wav(raw_pcm, os.path.join(OUTPUT_DIR, f"raw_phrase_{i}.wav"))
        save_wav(wsola_1_5x_pcm, os.path.join(OUTPUT_DIR, f"wsola_1.5x_phrase_{i}.wav"))
        save_wav(wsola_1_0x_pcm, os.path.join(OUTPUT_DIR, f"wsola_1.0x_phrase_{i}.wav"))

        # Step 4: Measure levels at each stage
        raw_measurement = measure_audio_levels(raw_pcm, f"Phrase {i} - Raw TTS")
        wsola_1_5x_measurement = measure_audio_levels(wsola_1_5x_pcm, f"Phrase {i} - WSOLA 1.5x")
        wsola_1_0x_measurement = measure_audio_levels(wsola_1_0x_pcm, f"Phrase {i} - WSOLA 1.0x (control)")

        all_measurements.extend([raw_measurement, wsola_1_5x_measurement, wsola_1_0x_measurement])

    # Step 5: Print summary
    print_summary_table(all_measurements)

    print(f"WAV files saved to: {OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
