/**
 * Bidirectional audio transcoding between Twilio and OpenAI.
 *
 * Twilio Media Streams send mulaw-encoded audio at 8kHz. OpenAI Realtime API
 * expects PCM16 at 24kHz. This module handles conversion in both directions
 * using pure TypeScript (no external audio libraries).
 *
 * Responsibilities:
 * - mulawToPcm16_24k: Decode mulaw 8kHz -> PCM16, resample to 24kHz
 * - pcm16_24kToMulaw: Resample PCM16 24kHz -> 8kHz, encode to mulaw
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const MULAW_SIGN_BIT = 0x80;
const MULAW_QUANT_MASK = 0x0f;
const MULAW_SEG_MASK = 0x70;
const MULAW_SEG_SHIFT = 4;

/** Resample ratio from 8kHz to 24kHz (multiply sample count by 3). */
const UPSAMPLE_RATIO = 3;

/** Resample ratio from 24kHz to 8kHz (divide sample count by 3). */
const DOWNSAMPLE_RATIO = 3;

// ============================================================================
// MAIN HANDLERS
// ============================================================================

/**
 * Decodes mulaw 8kHz audio to PCM16 and resamples to 24kHz.
 * @param mulawBuffer - Buffer of mulaw-encoded 8kHz audio samples
 * @returns Buffer of PCM16 (little-endian, signed 16-bit) audio at 24kHz
 */
export function mulawToPcm16_24k(mulawBuffer: Buffer): Buffer {
  // Decode mulaw to PCM16 at 8kHz
  const sampleCount = mulawBuffer.length;
  const pcm8k = new Int16Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    pcm8k[i] = decodeMulaw(mulawBuffer[i]);
  }

  // Resample 8kHz -> 24kHz using linear interpolation
  const outputLength = sampleCount * UPSAMPLE_RATIO;
  const outputBuffer = Buffer.alloc(outputLength * 2); // 2 bytes per PCM16 sample

  for (let i = 0; i < outputLength; i++) {
    // Map output index back to input position
    const srcPos = i / UPSAMPLE_RATIO;
    const srcIndex = Math.floor(srcPos);
    const fraction = srcPos - srcIndex;

    let sample: number;
    if (srcIndex + 1 < sampleCount) {
      // Linear interpolation between two source samples
      sample = pcm8k[srcIndex] * (1 - fraction) + pcm8k[srcIndex + 1] * fraction;
    } else {
      sample = pcm8k[srcIndex];
    }

    outputBuffer.writeInt16LE(Math.round(sample), i * 2);
  }

  return outputBuffer;
}

/**
 * Resamples PCM16 24kHz audio to 8kHz and encodes to mulaw.
 * @param pcm16Buffer - Buffer of PCM16 (little-endian, signed 16-bit) audio at 24kHz
 * @returns Buffer of mulaw-encoded 8kHz audio samples
 */
export function pcm16_24kToMulaw(pcm16Buffer: Buffer): Buffer {
  const inputSampleCount = pcm16Buffer.length / 2;
  const outputSampleCount = Math.floor(inputSampleCount / DOWNSAMPLE_RATIO);
  const outputBuffer = Buffer.alloc(outputSampleCount);

  for (let i = 0; i < outputSampleCount; i++) {
    // Map output index to input position
    const srcPos = i * DOWNSAMPLE_RATIO;
    const srcIndex = Math.floor(srcPos);
    const fraction = srcPos - srcIndex;

    const s0 = pcm16Buffer.readInt16LE(srcIndex * 2);
    let sample: number;

    if (srcIndex + 1 < inputSampleCount) {
      const s1 = pcm16Buffer.readInt16LE((srcIndex + 1) * 2);
      sample = s0 * (1 - fraction) + s1 * fraction;
    } else {
      sample = s0;
    }

    outputBuffer[i] = encodeMulaw(Math.round(sample));
  }

  return outputBuffer;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Decodes a single mulaw byte to a signed 16-bit PCM sample.
 * Uses the standard ITU-T G.711 mulaw decoding formula.
 * @param mulawByte - The mulaw-encoded byte (0-255)
 * @returns Signed 16-bit PCM sample
 */
function decodeMulaw(mulawByte: number): number {
  // Complement to obtain the original code
  const complement = ~mulawByte & 0xff;

  const sign = complement & MULAW_SIGN_BIT;
  const exponent = (complement & MULAW_SEG_MASK) >> MULAW_SEG_SHIFT;
  const mantissa = complement & MULAW_QUANT_MASK;

  // Reconstruct the magnitude
  let magnitude = ((mantissa << 1) + 1 + 32) << (exponent + 2);
  magnitude -= MULAW_BIAS;

  return sign ? -magnitude : magnitude;
}

/**
 * Encodes a signed 16-bit PCM sample to a single mulaw byte.
 * Uses the standard ITU-T G.711 mulaw encoding formula.
 * @param pcmSample - Signed 16-bit PCM sample (-32768 to 32767)
 * @returns Mulaw-encoded byte (0-255)
 */
function encodeMulaw(pcmSample: number): number {
  // Determine sign and get absolute value
  const sign = pcmSample < 0 ? MULAW_SIGN_BIT : 0;
  let magnitude = Math.abs(pcmSample);

  // Clip to maximum
  if (magnitude > MULAW_CLIP) {
    magnitude = MULAW_CLIP;
  }

  // Add bias
  magnitude += MULAW_BIAS;

  // Find the segment (exponent)
  let exponent = 7;
  const mask = 0x4000;
  for (let i = 0; i < 8; i++) {
    if (magnitude & (mask >> i)) {
      exponent = 7 - i;
      break;
    }
  }

  // Extract mantissa
  const mantissa = (magnitude >> (exponent + 3)) & MULAW_QUANT_MASK;

  // Combine and complement
  const mulawByte = ~(sign | (exponent << MULAW_SEG_SHIFT) | mantissa) & 0xff;
  return mulawByte;
}
