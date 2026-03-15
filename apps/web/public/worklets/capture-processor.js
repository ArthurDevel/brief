/**
 * AudioWorklet processor for capturing microphone input as PCM16 24kHz.
 *
 * Receives float32 audio from the browser's audio context (typically 48kHz),
 * resamples to 24kHz, converts to PCM16, and posts the buffer to the main thread.
 *
 * Responsibilities:
 * - Receive raw mic audio from the AudioContext
 * - Resample from the context sample rate to 24kHz
 * - Convert float32 samples to signed 16-bit integers
 * - Post PCM16 buffers to the main thread via the message port
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const TARGET_SAMPLE_RATE = 24000;

// ============================================================================
// PROCESSOR
// ============================================================================

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
  }

  /**
   * Processes a block of audio input from the microphone.
   * Resamples to 24kHz, converts to PCM16, and posts to main thread.
   * @param inputs - Array of input channels
   * @returns true to keep the processor alive
   */
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const float32Data = input[0];
    const inputSampleRate = sampleRate; // Global from AudioWorkletGlobalScope

    // Resample to 24kHz
    const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
    const outputLength = Math.floor(float32Data.length / ratio);
    const pcm16 = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcPos = i * ratio;
      const srcIndex = Math.floor(srcPos);
      const fraction = srcPos - srcIndex;

      let sample;
      if (srcIndex + 1 < float32Data.length) {
        sample = float32Data[srcIndex] * (1 - fraction) + float32Data[srcIndex + 1] * fraction;
      } else {
        sample = float32Data[srcIndex];
      }

      // Clamp and convert float32 [-1, 1] to PCM16 [-32768, 32767]
      const clamped = Math.max(-1, Math.min(1, sample));
      pcm16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
    }

    this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
