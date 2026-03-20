"""
Tests for the AudioRecorder FrameProcessor and related helper functions.

Verifies that:
- AudioRecorder captures matching frame types and produces valid WAV output
- AudioRecorder always pushes frames downstream, even on internal error
- upload_recording swallows exceptions and does not raise
- combine_wav_buffers produces a valid mixed WAV from two buffers
"""

from __future__ import annotations

import struct
import time
import wave
import io
from unittest.mock import AsyncMock, MagicMock, patch

import pytest  # type: ignore[import-untyped]

from pipecat.frames.frames import InputAudioRawFrame, TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection

from src.audio.recorder import AudioBuffer, AudioRecorder, combine_wav_buffers, upload_recording


# ============================================================================
# HELPERS
# ============================================================================

def _make_input_audio_frame(pcm_data: bytes, sample_rate: int = 16000, num_channels: int = 1) -> InputAudioRawFrame:
    """Create an InputAudioRawFrame with the given PCM data."""
    return InputAudioRawFrame(audio=pcm_data, sample_rate=sample_rate, num_channels=num_channels)


def _make_tts_audio_frame(pcm_data: bytes, sample_rate: int = 16000, num_channels: int = 1) -> TTSAudioRawFrame:
    """Create a TTSAudioRawFrame with the given PCM data."""
    return TTSAudioRawFrame(audio=pcm_data, sample_rate=sample_rate, num_channels=num_channels)


def _parse_wav(wav_bytes: bytes) -> tuple[int, int, int, bytes]:
    """Parse WAV bytes and return (sample_rate, num_channels, sample_width, raw_frames).

    Args:
        wav_bytes: Complete WAV file bytes.

    Returns:
        Tuple of (sample_rate, num_channels, sample_width, raw_pcm_frames).
    """
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, "rb") as wf:
        sample_rate = wf.getframerate()
        num_channels = wf.getnchannels()
        sample_width = wf.getsampwidth()
        frames = wf.readframes(wf.getnframes())
    return sample_rate, num_channels, sample_width, frames


# ============================================================================
# TESTS
# ============================================================================

@pytest.mark.asyncio
async def test_recorder_captures_matching_frames_and_produces_valid_wav() -> None:
    """AudioRecorder captures matching frame types into a buffer and produces valid WAV.

    Feeds several InputAudioRawFrame frames and a TTSAudioRawFrame (which should
    be ignored). Verifies the output is a valid WAV with correct header, sample rate,
    non-zero audio data, and only contains audio from the matching frame type.
    """
    recorder = AudioRecorder(target_frame_type=InputAudioRawFrame)
    recorder.push_frame = AsyncMock()

    # Create PCM16 test data: 100 samples of value 1000
    input_pcm = struct.pack("<100h", *([1000] * 100))
    tts_pcm = struct.pack("<50h", *([2000] * 50))

    # Feed input audio frames (should be captured)
    frame1 = _make_input_audio_frame(input_pcm[:100])  # first 50 samples
    frame2 = _make_input_audio_frame(input_pcm[100:])   # next 50 samples
    # Feed a TTS frame (should be ignored by this recorder)
    tts_frame = _make_tts_audio_frame(tts_pcm)

    await recorder.process_frame(frame1, FrameDirection.DOWNSTREAM)
    await recorder.process_frame(frame2, FrameDirection.DOWNSTREAM)
    await recorder.process_frame(tts_frame, FrameDirection.DOWNSTREAM)

    buffer = recorder.get_buffer()
    assert len(buffer.chunks) == 2, "Should have captured exactly 2 input frames"

    # Combine with an empty assistant buffer to get a WAV
    empty_buffer = AudioBuffer(chunks=[], sample_rate=16000, num_channels=1)
    wav_bytes = combine_wav_buffers(buffer, empty_buffer)

    # Verify valid WAV
    sample_rate, num_channels, sample_width, frames = _parse_wav(wav_bytes)
    assert sample_rate == 16000
    assert num_channels == 1
    assert sample_width == 2
    assert len(frames) == len(input_pcm), "WAV should contain all captured audio data"
    assert frames == input_pcm, "WAV audio should match the original input PCM"


@pytest.mark.asyncio
async def test_recorder_pushes_frame_downstream_on_internal_error() -> None:
    """AudioRecorder always pushes frames downstream, even on internal error.

    Monkey-patches the internal buffer append to raise an exception. Verifies
    the frame is still pushed downstream unchanged.
    """
    recorder = AudioRecorder(target_frame_type=InputAudioRawFrame)
    recorder.push_frame = AsyncMock()

    # Make the buffer's append raise an exception
    recorder._buffer.chunks = MagicMock()
    recorder._buffer.chunks.append = MagicMock(side_effect=RuntimeError("disk full"))

    input_pcm = struct.pack("<10h", *([500] * 10))
    frame = _make_input_audio_frame(input_pcm)

    await recorder.process_frame(frame, FrameDirection.DOWNSTREAM)

    # Frame must have been pushed downstream despite the error
    recorder.push_frame.assert_called_once_with(frame, FrameDirection.DOWNSTREAM)


@pytest.mark.asyncio
async def test_upload_recording_swallows_exceptions() -> None:
    """upload_recording swallows exceptions and does not raise.

    Calls upload_recording with a mock Supabase client whose upload raises.
    Verifies no exception propagates.
    """
    mock_supabase = MagicMock()
    mock_supabase.storage.from_.return_value.upload.side_effect = RuntimeError("network error")

    # This should not raise
    await upload_recording("test-session-123", b"fake-wav-data", mock_supabase)


@pytest.mark.asyncio
async def test_combine_wav_buffers_mixes_two_buffers() -> None:
    """combine_wav_buffers produces a valid mixed WAV from two buffers.

    Creates two AudioBuffer instances with known PCM16 data (different byte
    patterns), calls combine_wav_buffers, and verifies the result is a valid WAV
    where both signals are present (summed).
    """
    # User buffer: 100 samples of value 5000
    user_pcm = struct.pack("<100h", *([5000] * 100))
    user_buffer = AudioBuffer(chunks=[user_pcm], sample_rate=16000, num_channels=1)

    # Assistant buffer: 80 samples of value 3000 (shorter -- should be zero-padded)
    assistant_pcm = struct.pack("<80h", *([3000] * 80))
    assistant_buffer = AudioBuffer(chunks=[assistant_pcm], sample_rate=16000, num_channels=1)

    wav_bytes = combine_wav_buffers(user_buffer, assistant_buffer)

    # Parse the WAV
    sample_rate, num_channels, sample_width, frames = _parse_wav(wav_bytes)
    assert sample_rate == 16000
    assert num_channels == 1
    assert sample_width == 2

    # Should have 100 samples (length of the longer buffer)
    samples = struct.unpack(f"<{len(frames) // 2}h", frames)
    assert len(samples) == 100

    # First 80 samples: 5000 + 3000 = 8000
    for i in range(80):
        assert samples[i] == 8000, f"Sample {i} should be 8000 (summed), got {samples[i]}"

    # Last 20 samples: 5000 + 0 = 5000 (assistant was zero-padded)
    for i in range(80, 100):
        assert samples[i] == 5000, f"Sample {i} should be 5000 (user only), got {samples[i]}"


@pytest.mark.asyncio
async def test_assistant_recorder_inserts_silence_for_time_gaps() -> None:
    """Assistant recorder must insert silence to preserve timing between TTS chunks.

    TTS only emits frames when the assistant is speaking. The gaps (when the user
    is talking or the system is thinking) must be filled with silence so that the
    assistant recording stays time-aligned with the user recording.

    Simulates: 0.1s of TTS audio -> 1.0s gap -> 0.1s of TTS audio.
    The resulting buffer should contain ~1.2s of audio (not 0.2s).
    """
    recorder = AudioRecorder(target_frame_type=TTSAudioRawFrame)
    recorder.push_frame = AsyncMock()

    # 0.1s of audio = 1600 samples at 16kHz
    chunk_samples = 1600
    tts_pcm = struct.pack(f"<{chunk_samples}h", *([1000] * chunk_samples))

    # First TTS frame at t=0
    frame1 = _make_tts_audio_frame(tts_pcm)
    with patch("time.monotonic", return_value=0.0):
        await recorder.process_frame(frame1, FrameDirection.DOWNSTREAM)

    # Second TTS frame at t=1.1 (after a 1.0s gap)
    frame2 = _make_tts_audio_frame(tts_pcm)
    with patch("time.monotonic", return_value=1.1):
        await recorder.process_frame(frame2, FrameDirection.DOWNSTREAM)

    buffer = recorder.get_buffer()
    total_pcm = b"".join(buffer.chunks)
    total_samples = len(total_pcm) // 2  # PCM16 = 2 bytes per sample

    # Expected: 1600 (first chunk) + 16000 (1.0s silence) + 1600 (second chunk) = 19200
    # Allow small tolerance for rounding
    expected_samples = chunk_samples + 16000 + chunk_samples  # 19200
    assert total_samples >= expected_samples - 10, (
        f"Expected ~{expected_samples} samples (with silence gap), got {total_samples}. "
        f"Silence between TTS chunks is not being inserted."
    )
