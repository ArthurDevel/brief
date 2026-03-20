"""
Tests for the RMSNormalizer and AudioNormalizerProcessor.

Verifies that:
- Quiet audio is boosted to the target RMS level
- Peak limiter prevents clipping beyond the peak limit
- Silent audio is not amplified
- Streaming (small chunks) and batch (one block) produce consistent output
- Empty input returns empty output
- AudioNormalizerProcessor normalizes TTSAudioRawFrame and passes other frames through unchanged
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import numpy as np
import pytest  # type: ignore[import-untyped]

from pipecat.frames.frames import Frame, TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection

from src.audio.normalizer import RMSNormalizer, AudioNormalizerProcessor, INT16_MAX


# ============================================================================
# CONSTANTS
# ============================================================================

SAMPLE_RATE = 16000
DURATION_S = 0.5
NUM_SAMPLES = int(SAMPLE_RATE * DURATION_S)


# ============================================================================
# HELPERS
# ============================================================================

def _generate_sine_tone_bytes(frequency_hz: float, rms_dbfs: float, num_samples: int = NUM_SAMPLES) -> bytes:
    """Generate a sine wave at a specific RMS level and return as int16 PCM bytes.

    Args:
        frequency_hz: Frequency of the sine wave in Hz.
        rms_dbfs: Desired RMS level in dBFS.
        num_samples: Number of samples to generate.

    Returns:
        Int16 PCM bytes (little-endian).
    """
    t = np.arange(num_samples) / SAMPLE_RATE
    # Sine wave has RMS = amplitude / sqrt(2)
    target_rms_linear = 10.0 ** (rms_dbfs / 20.0)
    amplitude = target_rms_linear * np.sqrt(2)
    samples_float = amplitude * np.sin(2 * np.pi * frequency_hz * t)
    samples_int16 = (samples_float * INT16_MAX).astype(np.int16)
    return samples_int16.tobytes()


def _compute_rms_dbfs(audio_bytes: bytes) -> float:
    """Compute the RMS level in dBFS from int16 PCM bytes.

    Args:
        audio_bytes: Int16 PCM bytes (little-endian).

    Returns:
        RMS level in dBFS.
    """
    samples_int16 = np.frombuffer(audio_bytes, dtype=np.int16)
    samples_float = samples_int16.astype(np.float32) / INT16_MAX
    rms = np.sqrt(np.mean(samples_float ** 2))
    if rms <= 0:
        return -120.0
    return 20.0 * np.log10(rms)


def _compute_peak_dbfs(audio_bytes: bytes) -> float:
    """Compute the peak level in dBFS from int16 PCM bytes.

    Args:
        audio_bytes: Int16 PCM bytes (little-endian).

    Returns:
        Peak level in dBFS.
    """
    samples_int16 = np.frombuffer(audio_bytes, dtype=np.int16)
    samples_float = samples_int16.astype(np.float32) / INT16_MAX
    peak = np.max(np.abs(samples_float))
    if peak <= 0:
        return -120.0
    return 20.0 * np.log10(peak)


# ============================================================================
# TESTS
# ============================================================================

def test_normalizer_boosts_quiet_audio_to_target_rms() -> None:
    """Quiet audio (~-18 dBFS RMS) is boosted to near -15 dBFS after normalization.

    Creates a constant-amplitude sine tone at -18 dBFS RMS, processes it through
    RMSNormalizer, and verifies the output RMS is within 2 dB of -15 dBFS.
    """
    # Arrange
    input_audio = _generate_sine_tone_bytes(frequency_hz=440.0, rms_dbfs=-18.0)
    normalizer = RMSNormalizer(sample_rate=SAMPLE_RATE)

    # Act
    output_audio = normalizer.process(input_audio)

    # Assert
    output_rms = _compute_rms_dbfs(output_audio)
    assert abs(output_rms - (-15.0)) < 2.0, (
        f"Expected output RMS near -15 dBFS, got {output_rms:.1f} dBFS"
    )


def test_peak_limiter_prevents_clipping() -> None:
    """A signal with peaks near 0 dBFS does not exceed -1 dBFS after normalization.

    Creates a loud sine tone with peaks near 0 dBFS, processes it through
    RMSNormalizer, and verifies no peaks exceed -1 dBFS.
    """
    # Arrange -- sine at -1.5 dBFS RMS means peaks at roughly -1.5 + 3 = +1.5 dBFS raw amplitude
    # which after gain would push peaks above 0 dBFS, triggering the limiter
    input_audio = _generate_sine_tone_bytes(frequency_hz=440.0, rms_dbfs=-1.5)
    normalizer = RMSNormalizer(sample_rate=SAMPLE_RATE)

    # Act
    output_audio = normalizer.process(input_audio)

    # Assert
    output_peak = _compute_peak_dbfs(output_audio)
    assert output_peak <= -1.0, (
        f"Expected peak at or below -1 dBFS, got {output_peak:.1f} dBFS"
    )


def test_silent_audio_is_not_amplified() -> None:
    """Audio below -40 dBFS is not boosted significantly.

    Creates very quiet audio at -50 dBFS, processes it through RMSNormalizer,
    and verifies the output stays below -35 dBFS.
    """
    # Arrange
    input_audio = _generate_sine_tone_bytes(frequency_hz=440.0, rms_dbfs=-50.0)
    normalizer = RMSNormalizer(sample_rate=SAMPLE_RATE)

    # Act
    output_audio = normalizer.process(input_audio)

    # Assert
    output_rms = _compute_rms_dbfs(output_audio)
    assert output_rms < -35.0, (
        f"Expected silent audio to stay below -35 dBFS, got {output_rms:.1f} dBFS"
    )


def test_streaming_consistency() -> None:
    """Processing audio in small chunks produces comparable output to one block.

    Processes the same audio as a single block vs in 10ms chunks (160 samples).
    The RMS of both outputs should be within 2 dB of each other.
    """
    # Arrange
    input_audio = _generate_sine_tone_bytes(frequency_hz=440.0, rms_dbfs=-18.0)
    chunk_size_samples = 160  # 10ms at 16kHz
    chunk_size_bytes = chunk_size_samples * 2  # int16 = 2 bytes per sample

    # Act -- single block
    normalizer_block = RMSNormalizer(sample_rate=SAMPLE_RATE)
    output_block = normalizer_block.process(input_audio)

    # Act -- streaming in small chunks
    normalizer_stream = RMSNormalizer(sample_rate=SAMPLE_RATE)
    output_chunks = []
    for i in range(0, len(input_audio), chunk_size_bytes):
        chunk = input_audio[i : i + chunk_size_bytes]
        output_chunks.append(normalizer_stream.process(chunk))
    output_stream = b"".join(output_chunks)

    # Assert
    rms_block = _compute_rms_dbfs(output_block)
    rms_stream = _compute_rms_dbfs(output_stream)
    assert abs(rms_block - rms_stream) < 2.0, (
        f"Block RMS ({rms_block:.1f} dBFS) and stream RMS ({rms_stream:.1f} dBFS) "
        f"differ by more than 2 dB"
    )


def test_empty_input_returns_empty_output() -> None:
    """RMSNormalizer.process(b'') returns b''."""
    normalizer = RMSNormalizer()
    result = normalizer.process(b"")
    assert result == b""


@pytest.mark.asyncio
async def test_processor_normalizes_tts_frame_and_passes_other_frames() -> None:
    """AudioNormalizerProcessor normalizes TTSAudioRawFrame and passes other frames unchanged.

    Creates a TTSAudioRawFrame with quiet audio, processes it through the processor,
    and verifies the output frame has louder (different) audio. Also verifies a
    non-audio frame passes through unchanged.
    """
    # Arrange
    config = {"enabled": True}
    processor = AudioNormalizerProcessor(config=config, sample_rate=SAMPLE_RATE)

    captured_frames: list[Frame] = []

    async def mock_push_frame(frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        captured_frames.append(frame)

    processor.push_frame = AsyncMock(side_effect=mock_push_frame)

    # -- Test 1: TTSAudioRawFrame is normalized
    quiet_audio = _generate_sine_tone_bytes(frequency_hz=440.0, rms_dbfs=-18.0)
    tts_frame = TTSAudioRawFrame(audio=quiet_audio, sample_rate=SAMPLE_RATE, num_channels=1)

    await processor.process_frame(tts_frame, FrameDirection.DOWNSTREAM)

    assert len(captured_frames) == 1, "Expected exactly one frame to be pushed"
    output_frame = captured_frames[0]
    assert isinstance(output_frame, TTSAudioRawFrame), "Output should be a TTSAudioRawFrame"
    assert output_frame.audio != quiet_audio, "Output audio should differ from input (louder)"

    output_rms = _compute_rms_dbfs(output_frame.audio)
    input_rms = _compute_rms_dbfs(quiet_audio)
    assert output_rms > input_rms, (
        f"Output RMS ({output_rms:.1f} dBFS) should be louder than input ({input_rms:.1f} dBFS)"
    )

    # -- Test 2: Non-audio frame passes through unchanged
    captured_frames.clear()
    plain_frame = Frame()

    await processor.process_frame(plain_frame, FrameDirection.DOWNSTREAM)

    assert len(captured_frames) == 1, "Expected exactly one frame to be pushed"
    assert captured_frames[0] is plain_frame, "Non-audio frame should pass through unchanged"
