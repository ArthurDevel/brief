"""
Audio recorder that captures pipeline frames into a buffer for debug recording.

Passively records audio frames flowing through the Pipecat pipeline without
blocking or interfering with the active call. Two instances are used per session:
one for user audio (InputAudioRawFrame), one for assistant audio (TTSAudioRawFrame).

- AudioBuffer: dataclass holding accumulated raw PCM16 audio chunks
- AudioRecorder: FrameProcessor that captures matching frames into a buffer
- combine_wav_buffers: merges two AudioBuffers into a single mono WAV file
- upload_recording: uploads WAV bytes to Supabase Storage
"""

from __future__ import annotations

import asyncio
import io
import logging
import struct
import time
import wave
from dataclasses import dataclass, field

from pipecat.frames.frames import AudioRawFrame, Frame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from supabase import Client


logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

SAMPLE_RATE: int = 16000
NUM_CHANNELS: int = 1
SAMPLE_WIDTH: int = 2  # bytes per sample (PCM16)
STORAGE_BUCKET: str = "call-recordings"


# ============================================================================
# TYPES
# ============================================================================

@dataclass
class AudioBuffer:
    """Accumulated raw PCM16 audio chunks from a single audio stream.

    Args:
        chunks: List of raw PCM16 audio byte chunks.
        sample_rate: Audio sample rate in Hz.
        num_channels: Number of audio channels (1 for mono).
    """

    chunks: list[bytes] = field(default_factory=list)
    sample_rate: int = SAMPLE_RATE
    num_channels: int = NUM_CHANNELS


# ============================================================================
# MAIN PROCESSOR
# ============================================================================

class AudioRecorder(FrameProcessor):
    """Pipecat FrameProcessor that captures matching audio frames into a buffer.

    Filters for a specific frame type (e.g. InputAudioRawFrame or TTSAudioRawFrame)
    and appends the raw audio bytes to an internal AudioBuffer. All frames are always
    pushed downstream unchanged -- recording never blocks the pipeline.
    """

    def __init__(
        self,
        target_frame_type: type,
        sample_rate: int = SAMPLE_RATE,
        num_channels: int = NUM_CHANNELS,
    ) -> None:
        """Initialize the audio recorder.

        Args:
            target_frame_type: The frame type to capture (e.g. InputAudioRawFrame).
            sample_rate: Audio sample rate in Hz.
            num_channels: Number of audio channels.
        """
        super().__init__()
        self._target_frame_type = target_frame_type
        self._buffer = AudioBuffer(
            chunks=[],
            sample_rate=sample_rate,
            num_channels=num_channels,
        )
        self._start_time: float | None = None
        self._samples_written: int = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Process a pipeline frame. Captures matching frames into the buffer.

        Always pushes the frame downstream unchanged, even if recording fails.

        Args:
            frame: The pipeline frame.
            direction: The direction the frame is traveling.
        """
        await super().process_frame(frame, direction)

        # Capture audio from matching frame types, but never block the pipeline
        if isinstance(frame, self._target_frame_type):
            try:
                audio_frame: AudioRawFrame = frame  # type: ignore[assignment]
                now = time.monotonic()

                # On first frame, record the start time
                if self._start_time is None:
                    self._start_time = now

                # Insert silence for any gap between last written position and now
                elapsed = now - self._start_time
                expected_samples = int(elapsed * self._buffer.sample_rate)
                gap_samples = expected_samples - self._samples_written
                if gap_samples > 0:
                    silence = b"\x00" * (gap_samples * SAMPLE_WIDTH)
                    self._buffer.chunks.append(silence)
                    self._samples_written += gap_samples

                # Append the actual audio
                self._buffer.chunks.append(audio_frame.audio)
                self._samples_written += len(audio_frame.audio) // SAMPLE_WIDTH
            except Exception:
                logger.exception("[recorder] Failed to capture audio frame")

        await self.push_frame(frame, direction)

    def get_buffer(self) -> AudioBuffer:
        """Return the accumulated audio buffer.

        Returns:
            The AudioBuffer containing all captured audio chunks.
        """
        return self._buffer


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def combine_wav_buffers(user_buffer: AudioBuffer, assistant_buffer: AudioBuffer) -> bytes:
    """Combine two PCM16 audio buffers into a single mono WAV file.

    Both buffers are summed sample-by-sample. The shorter buffer is zero-padded
    to match the longer one. Samples are summed using int32 intermediate values
    and clipped to int16 range.

    Args:
        user_buffer: AudioBuffer with user (mic) audio chunks.
        assistant_buffer: AudioBuffer with assistant (TTS) audio chunks.

    Returns:
        Complete WAV file as bytes (PCM16, mono).
    """
    user_pcm = b"".join(user_buffer.chunks)
    assistant_pcm = b"".join(assistant_buffer.chunks)

    # Determine lengths in samples
    user_samples = len(user_pcm) // SAMPLE_WIDTH
    assistant_samples = len(assistant_pcm) // SAMPLE_WIDTH
    max_samples = max(user_samples, assistant_samples)

    if max_samples == 0:
        # Both buffers are empty -- return a valid but empty WAV
        return _write_wav(b"", user_buffer.sample_rate, user_buffer.num_channels)

    # Unpack PCM16 samples as signed int16, zero-pad shorter buffer
    user_vals = list(struct.unpack(f"<{user_samples}h", user_pcm[:user_samples * SAMPLE_WIDTH]))
    assistant_vals = list(struct.unpack(f"<{assistant_samples}h", assistant_pcm[:assistant_samples * SAMPLE_WIDTH]))

    user_vals.extend([0] * (max_samples - user_samples))
    assistant_vals.extend([0] * (max_samples - assistant_samples))

    # Sum with int32 intermediate and clip to int16 range
    mixed = []
    for u, a in zip(user_vals, assistant_vals):
        summed = u + a
        clipped = max(-32768, min(32767, summed))
        mixed.append(clipped)

    mixed_pcm = struct.pack(f"<{max_samples}h", *mixed)

    sample_rate = user_buffer.sample_rate
    num_channels = user_buffer.num_channels
    return _write_wav(mixed_pcm, sample_rate, num_channels)


def _write_wav(pcm_data: bytes, sample_rate: int, num_channels: int) -> bytes:
    """Write raw PCM16 data into a complete WAV file.

    Args:
        pcm_data: Raw PCM16 audio bytes.
        sample_rate: Audio sample rate in Hz.
        num_channels: Number of audio channels.

    Returns:
        Complete WAV file as bytes.
    """
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(num_channels)
        wf.setsampwidth(SAMPLE_WIDTH)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return buf.getvalue()


async def upload_recording(session_id: str, wav_bytes: bytes, supabase: Client) -> None:
    """Upload a WAV recording to Supabase Storage.

    Uses asyncio.to_thread since the Supabase storage upload is blocking I/O.
    All exceptions are logged and swallowed -- upload failure must never
    propagate to the caller.

    Args:
        session_id: The session ID used as the file name.
        wav_bytes: The complete WAV file bytes to upload.
        supabase: Supabase client instance.
    """
    try:
        path = f"{session_id}.wav"
        await asyncio.to_thread(
            supabase.storage.from_(STORAGE_BUCKET).upload,
            path,
            wav_bytes,
            {"content-type": "audio/wav"},
        )
        logger.info("[recorder] Uploaded recording for session %s", session_id)
    except Exception:
        logger.exception("[recorder] Failed to upload recording for session %s", session_id)
