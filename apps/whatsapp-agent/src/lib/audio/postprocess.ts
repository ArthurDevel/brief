/**
 * Post-processing helpers for WhatsApp TTS audio.
 *
 * Responsibilities:
 * - Apply speed changes to synthesized audio
 * - Normalize output loudness for call playback
 */

import { RMSNormalizer } from "./normalizer.js";
import { WSOLAStreamer } from "./speed.js";

// ============================================================================
// TYPES
// ============================================================================

export interface AudioPostProcessOptions {
  speed: number;
  sampleRate: number;
  numChannels: number;
}

// ============================================================================
// MAIN CLASS
// ============================================================================

/**
 * Streaming post-processor for synthesized audio.
 */
export class StreamingAudioPostProcessor {
  private readonly speed: number;
  private readonly normalizer: RMSNormalizer;
  private readonly stretcher: WSOLAStreamer | null;

  /**
   * Creates the streaming post-processor.
   * @param options - Audio post-processing options
   */
  constructor(options: AudioPostProcessOptions) {
    this.speed = options.speed;
    this.normalizer = new RMSNormalizer(undefined, undefined, undefined, undefined, options.sampleRate);
    this.stretcher =
      this.speed === 1
        ? null
        : new WSOLAStreamer(options.sampleRate, options.numChannels, this.speed);
  }

  /**
   * Processes one PCM chunk.
   * @param samples - PCM audio chunk
   * @returns Processed PCM audio chunk
   */
  push(samples: Int16Array): Int16Array {
    const stretched = this.stretcher ? this.stretcher.process(samples) : samples;
    if (stretched.length === 0) {
      return stretched;
    }

    return this.normalizer.process(stretched);
  }

  /**
   * Flushes the internal buffers.
   * @returns Remaining processed PCM audio
   */
  flush(): Int16Array {
    const stretched = this.stretcher ? this.stretcher.flush() : new Int16Array(0);
    if (stretched.length === 0) {
      return stretched;
    }

    return this.normalizer.process(stretched);
  }
}
