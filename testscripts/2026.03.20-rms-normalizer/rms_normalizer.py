"""
RMS-based audio normalizer with peak limiting for real-time voice pipelines.

Normalizes int16 PCM audio to a target RMS level while preventing clipping
via tanh soft limiting. Designed for streaming use: processes audio chunk by
chunk and maintains state across calls.

Responsibilities:
- Compute per-chunk RMS and derive the gain needed to hit a target level
- Smooth gain changes with attack/release envelope to avoid pumping artifacts
- Apply tanh soft clipping to prevent peaks from exceeding the peak limit
- Maintain streaming state so consecutive chunks transition smoothly
"""

import numpy as np

# ============================================================================
# CONSTANTS
# ============================================================================

SILENCE_THRESHOLD_DBFS = -40.0
INT16_MAX = 32768.0


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _dbfs_to_linear(dbfs: float) -> float:
    """Convert a dBFS value to a linear amplitude value.

    Args:
        dbfs: Level in dBFS.

    Returns:
        Linear amplitude (e.g. -6 dBFS -> ~0.5012).
    """
    return 10.0 ** (dbfs / 20.0)


def _linear_to_dbfs(linear: float) -> float:
    """Convert a linear amplitude value to dBFS.

    Args:
        linear: Linear amplitude (must be > 0).

    Returns:
        Level in dBFS.
    """
    if linear <= 0:
        return -120.0
    return 20.0 * np.log10(linear)


def _compute_smoothing_coefficient(time_ms: float, sample_rate: int, chunk_length: int) -> float:
    """Compute exponential smoothing coefficient for a given time constant.

    The coefficient determines how quickly the gain adapts. A shorter time
    constant means faster adaptation.

    Args:
        time_ms: Time constant in milliseconds.
        sample_rate: Audio sample rate in Hz.
        chunk_length: Number of samples in the chunk being processed.

    Returns:
        Smoothing coefficient in range [0, 1]. Closer to 1 means slower change.
    """
    if time_ms <= 0 or chunk_length <= 0:
        return 0.0
    # Number of chunks per time constant
    chunk_duration_s = chunk_length / sample_rate
    time_s = time_ms / 1000.0
    return np.exp(-chunk_duration_s / time_s)


# ============================================================================
# MAIN CLASS
# ============================================================================

class RMSNormalizer:
    """Streaming RMS-based audio normalizer with peak limiting.

    Processes int16 PCM audio chunks to achieve a consistent RMS level.
    Uses exponential gain smoothing (attack/release) to avoid sudden volume
    jumps, and tanh soft clipping to prevent peaks from exceeding a threshold.

    Designed for real-time voice pipelines where audio arrives in small chunks.

    Args:
        target_rms_dbfs: Desired output RMS level in dBFS. Default -12.0.
        peak_limit_dbfs: Maximum allowed peak level in dBFS. Default -1.0.
        attack_ms: Attack time in ms (how fast gain decreases). Default 50.0.
        release_ms: Release time in ms (how fast gain increases). Default 200.0.
        sample_rate: Audio sample rate in Hz. Default 16000.
    """

    def __init__(
        self,
        target_rms_dbfs: float = -12.0,
        peak_limit_dbfs: float = -1.0,
        attack_ms: float = 50.0,
        release_ms: float = 200.0,
        sample_rate: int = 16000,
    ) -> None:
        self._target_rms_linear = _dbfs_to_linear(target_rms_dbfs)
        self._peak_limit_linear = _dbfs_to_linear(peak_limit_dbfs)
        self._silence_threshold_linear = _dbfs_to_linear(SILENCE_THRESHOLD_DBFS)
        self._attack_ms = attack_ms
        self._release_ms = release_ms
        self._sample_rate = sample_rate
        self._current_gain = 1.0

    def process(self, audio_bytes: bytes) -> bytes:
        """Process a chunk of int16 PCM audio and return the normalized result.

        Args:
            audio_bytes: Raw int16 PCM audio bytes (little-endian).

        Returns:
            Normalized int16 PCM audio bytes, same length as input.
        """
        if len(audio_bytes) == 0:
            return audio_bytes

        # Step 1: Convert int16 bytes to float32 in range [-1.0, 1.0]
        samples_int16 = np.frombuffer(audio_bytes, dtype=np.int16)
        samples_float = samples_int16.astype(np.float32) / INT16_MAX

        # Step 2: Compute RMS of the current chunk
        rms = np.sqrt(np.mean(samples_float ** 2))

        # Step 3: Calculate desired gain (only if above silence threshold)
        if rms > self._silence_threshold_linear:
            desired_gain = self._target_rms_linear / rms
        else:
            # Silent chunk -- keep current gain, don't boost noise
            desired_gain = self._current_gain

        # Step 4: Smooth the gain with attack/release envelope
        chunk_length = len(samples_float)
        if desired_gain < self._current_gain:
            # Signal is louder, need less gain -- use fast attack
            coeff = _compute_smoothing_coefficient(self._attack_ms, self._sample_rate, chunk_length)
        else:
            # Signal is quieter, need more gain -- use slow release
            coeff = _compute_smoothing_coefficient(self._release_ms, self._sample_rate, chunk_length)

        self._current_gain = coeff * self._current_gain + (1.0 - coeff) * desired_gain

        # Step 5: Apply the smoothed gain
        samples_float = samples_float * self._current_gain

        # Step 6: Apply peak limiting via tanh soft clipping
        peak = np.max(np.abs(samples_float))
        if peak > self._peak_limit_linear:
            # Scale into tanh range so that the peak limit maps to tanh(1)
            # tanh(1) ~ 0.7616, so we scale such that output stays below the limit
            scale = self._peak_limit_linear / np.tanh(peak / self._peak_limit_linear)
            samples_float = scale * np.tanh(samples_float / self._peak_limit_linear)

        # Step 7: Convert back to int16
        samples_float = np.clip(samples_float, -1.0, 1.0)
        samples_int16_out = (samples_float * INT16_MAX).astype(np.int16)

        return samples_int16_out.tobytes()

    def reset(self) -> None:
        """Reset internal state. Call this between separate audio streams."""
        self._current_gain = 1.0
