"""
SoundTouch pitch-preserving speed processor for TTS audio.

Uses the soundtouch Python package to apply tempo changes to audio
frames without altering pitch.

- SoundTouchStreamer: low-level wrapper around soundtouch for streaming audio
- AudioSpeedProcessor: Pipecat FrameProcessor that intercepts TTS audio frames
"""

from __future__ import annotations

import numpy as np
import soundtouch

from pipecat.frames.frames import Frame, TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


# ============================================================================
# SOUNDTOUCH STREAMER
# ============================================================================

class SoundTouchStreamer:
    """Streaming wrapper around the soundtouch Python package.

    Feeds int16 PCM audio in and retrieves tempo-adjusted int16 PCM out.
    """

    def __init__(self, sample_rate: int, num_channels: int, tempo: float) -> None:
        """Initialize SoundTouch instance with audio parameters.

        Args:
            sample_rate: Audio sample rate in Hz (e.g., 16000).
            num_channels: Number of audio channels (1 for mono, 2 for stereo).
            tempo: Playback speed multiplier (1.0 = normal, 1.5 = 50% faster).
        """
        self._st = soundtouch.SoundTouch()
        self._st.setSampleRate(sample_rate)
        self._st.setChannels(num_channels)
        self._st.setTempo(tempo)
        self._num_channels = num_channels

    def set_tempo(self, tempo: float) -> None:
        """Update the playback speed.

        Args:
            tempo: New speed multiplier (1.0 = normal).
        """
        self._st.setTempo(tempo)

    def process(self, audio: bytes) -> bytes:
        """Feed int16 PCM audio in and return tempo-adjusted int16 PCM out.

        Args:
            audio: Raw int16 PCM audio bytes.

        Returns:
            Tempo-adjusted int16 PCM audio bytes. May return empty bytes
            if SoundTouch is still buffering.
        """
        samples = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0
        self._st.putSamples(samples, len(samples) // self._num_channels)

        # Retrieve all available output samples
        out_samples = self._st.receiveSamples(len(samples) // self._num_channels)
        if out_samples is None or len(out_samples) == 0:
            return b""

        # Convert back to int16
        out_int16 = (out_samples * 32768.0).clip(-32768, 32767).astype(np.int16)
        return out_int16.tobytes()

    def destroy(self) -> None:
        """Clean up the SoundTouch instance."""
        self._st.clear()


# ============================================================================
# PIPECAT FRAME PROCESSOR
# ============================================================================

class AudioSpeedProcessor(FrameProcessor):
    """Pipecat FrameProcessor that applies pitch-preserving tempo change to TTS audio.

    Intercepts TTSAudioRawFrame, processes through SoundTouch, and passes
    through all other frame types unchanged.
    """

    def __init__(self, sample_rate: int = 16000, num_channels: int = 1, tempo: float = 1.0) -> None:
        """Initialize the speed processor.

        Args:
            sample_rate: Audio sample rate in Hz.
            num_channels: Number of audio channels.
            tempo: Initial playback speed multiplier.
        """
        super().__init__()
        self._streamer = SoundTouchStreamer(sample_rate, num_channels, tempo)

    def set_tempo(self, tempo: float) -> None:
        """Update the playback speed.

        Args:
            tempo: New speed multiplier (1.0 = normal).
        """
        self._streamer.set_tempo(tempo)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Process a pipeline frame. Applies tempo change to TTS audio frames.

        Args:
            frame: The pipeline frame.
            direction: The direction the frame is traveling.
        """
        await super().process_frame(frame, direction)

        if isinstance(frame, TTSAudioRawFrame):
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

    async def cleanup(self) -> None:
        """Clean up the SoundTouch streamer."""
        await super().cleanup()
        self._streamer.destroy()
