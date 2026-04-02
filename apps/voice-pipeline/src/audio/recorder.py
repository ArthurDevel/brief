"""
WAV file writing and recording upload utilities.

Provides helpers for the voice pipeline to persist call audio:
- write_wav: wraps raw PCM16 bytes into a complete WAV file
- upload_recording: uploads a WAV file to Supabase Storage
"""

from __future__ import annotations

import asyncio
import io
import logging
import wave

from supabase import Client


logger = logging.getLogger(__name__)


# ============================================================================
# CONSTANTS
# ============================================================================

STORAGE_BUCKET: str = "call-recordings"


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def write_wav(pcm_data: bytes, sample_rate: int, num_channels: int) -> bytes:
    """Write raw PCM16 data into a complete WAV file.

    Args:
        pcm_data: Raw PCM16 audio bytes.
        sample_rate: Audio sample rate in Hz.
        num_channels: Number of audio channels.

    Returns:
        Complete WAV file as bytes.
    """
    sample_width = 2  # bytes per sample (PCM16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(num_channels)
        wf.setsampwidth(sample_width)
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
