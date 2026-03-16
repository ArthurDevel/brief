"""
Bidirectional audio transcoding between Twilio mulaw 8kHz and PCM16.

Port of apps/voice-gateway/src/audio-transcoder.ts. Twilio Media Streams
send mulaw-encoded audio at 8kHz. The Pipecat pipeline expects PCM16 at
a configurable rate (typically 16kHz). This module handles conversion in
both directions using pure Python (no external audio libraries).

- mulaw_to_pcm16: decode mulaw 8kHz -> PCM16, upsample to target rate
- pcm16_to_mulaw: downsample PCM16 from source rate -> 8kHz, encode to mulaw
- _decode_mulaw: ITU-T G.711 mulaw single-byte decode
- _encode_mulaw: ITU-T G.711 mulaw single-byte encode
"""

from __future__ import annotations

import struct


# ============================================================================
# CONSTANTS
# ============================================================================

MULAW_BIAS = 0x84
MULAW_CLIP = 32635
MULAW_SIGN_BIT = 0x80
MULAW_QUANT_MASK = 0x0F
MULAW_SEG_MASK = 0x70
MULAW_SEG_SHIFT = 4

TWILIO_SAMPLE_RATE = 8000


# ============================================================================
# MAIN ENTRYPOINT
# ============================================================================

def mulaw_to_pcm16(mulaw_bytes: bytes, target_rate: int) -> bytes:
    """Decode mulaw 8kHz audio to PCM16 and upsample to target rate.

    Uses linear interpolation for resampling, matching the TypeScript
    implementation exactly.

    Args:
        mulaw_bytes: Raw mulaw-encoded bytes at 8kHz (one byte per sample).
        target_rate: Target sample rate in Hz (e.g. 16000).

    Returns:
        PCM16 audio bytes (little-endian, signed 16-bit) at target_rate.
    """
    sample_count = len(mulaw_bytes)
    if sample_count == 0:
        return b""

    # Decode mulaw to PCM16 at 8kHz
    pcm_8k = [_decode_mulaw(b) for b in mulaw_bytes]

    # Resample 8kHz -> target_rate using linear interpolation
    ratio = target_rate / TWILIO_SAMPLE_RATE
    output_length = int(sample_count * ratio)
    output_samples = []

    for i in range(output_length):
        # Map output index back to input position
        src_pos = i / ratio
        src_index = int(src_pos)
        fraction = src_pos - src_index

        if src_index + 1 < sample_count:
            # Linear interpolation between two source samples
            sample = pcm_8k[src_index] * (1 - fraction) + pcm_8k[src_index + 1] * fraction
        else:
            sample = pcm_8k[src_index]

        output_samples.append(round(sample))

    return struct.pack(f"<{len(output_samples)}h", *output_samples)


def pcm16_to_mulaw(pcm16_bytes: bytes, source_rate: int) -> bytes:
    """Downsample PCM16 from source rate to 8kHz and encode to mulaw.

    Uses linear interpolation for resampling, matching the TypeScript
    implementation exactly.

    Args:
        pcm16_bytes: PCM16 audio bytes (little-endian, signed 16-bit) at source_rate.
        source_rate: Source sample rate in Hz (e.g. 16000).

    Returns:
        Mulaw-encoded bytes at 8kHz (one byte per sample).
    """
    input_sample_count = len(pcm16_bytes) // 2
    if input_sample_count == 0:
        return b""

    # Unpack PCM16 samples
    pcm_samples = struct.unpack(f"<{input_sample_count}h", pcm16_bytes[:input_sample_count * 2])

    # Resample source_rate -> 8kHz using linear interpolation
    ratio = source_rate / TWILIO_SAMPLE_RATE
    output_sample_count = int(input_sample_count / ratio)
    output_bytes = bytearray(output_sample_count)

    for i in range(output_sample_count):
        # Map output index to input position
        src_pos = i * ratio
        src_index = int(src_pos)
        fraction = src_pos - src_index

        s0 = pcm_samples[src_index]

        if src_index + 1 < input_sample_count:
            s1 = pcm_samples[src_index + 1]
            sample = s0 * (1 - fraction) + s1 * fraction
        else:
            sample = s0

        output_bytes[i] = _encode_mulaw(round(sample))

    return bytes(output_bytes)


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def _decode_mulaw(mulaw_byte: int) -> int:
    """Decode a single mulaw byte to a signed 16-bit PCM sample.

    Uses the standard ITU-T G.711 mulaw decoding formula:
    complement -> extract sign/exponent/mantissa -> reconstruct magnitude.

    Args:
        mulaw_byte: The mulaw-encoded byte (0-255).

    Returns:
        Signed 16-bit PCM sample.
    """
    complement = ~mulaw_byte & 0xFF

    sign = complement & MULAW_SIGN_BIT
    exponent = (complement & MULAW_SEG_MASK) >> MULAW_SEG_SHIFT
    mantissa = complement & MULAW_QUANT_MASK

    # Reconstruct the magnitude
    magnitude = ((mantissa << 1) + 1 + 32) << (exponent + 2)
    magnitude -= MULAW_BIAS

    return -magnitude if sign else magnitude


def _encode_mulaw(pcm_sample: int) -> int:
    """Encode a signed 16-bit PCM sample to a single mulaw byte.

    Uses the standard ITU-T G.711 mulaw encoding formula:
    extract sign -> clip -> add bias -> find segment -> combine -> complement.

    Args:
        pcm_sample: Signed 16-bit PCM sample (-32768 to 32767).

    Returns:
        Mulaw-encoded byte (0-255).
    """
    # Determine sign and get absolute value
    sign = MULAW_SIGN_BIT if pcm_sample < 0 else 0
    magnitude = abs(pcm_sample)

    # Clip to maximum
    if magnitude > MULAW_CLIP:
        magnitude = MULAW_CLIP

    # Add bias
    magnitude += MULAW_BIAS

    # Find the segment (exponent) by scanning for the highest set bit
    exponent = 7
    mask = 0x4000
    for i in range(8):
        if magnitude & (mask >> i):
            exponent = 7 - i
            break

    # Extract mantissa
    mantissa = (magnitude >> (exponent + 3)) & MULAW_QUANT_MASK

    # Combine and complement
    mulaw_byte = ~(sign | (exponent << MULAW_SEG_SHIFT) | mantissa) & 0xFF
    return mulaw_byte
