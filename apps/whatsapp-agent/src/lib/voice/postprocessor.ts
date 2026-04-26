/**
 * Shared WhatsApp TTS audio post-processing helpers.
 *
 * Responsibilities:
 * - Apply the same speed and normalization behavior to every TTS provider
 * - Convert processed PCM samples into LiveKit audio frames
 * - Keep provider files focused on provider-specific synthesis
 */

import { AudioByteStream, tts } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import {
  StreamingAudioPostProcessor,
  type AudioPostProcessOptions,
} from "../audio/postprocess.js";
import { NUM_CHANNELS } from "./types.js";

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Creates a streaming PCM post-processor for one TTS stream.
 * @param options - Audio post-processing options
 * @returns Streaming audio post-processor
 */
export function createStreamingPostProcessor(
  options: AudioPostProcessOptions
): StreamingAudioPostProcessor {
  return new StreamingAudioPostProcessor(options);
}

/**
 * Processes a complete PCM buffer.
 * @param samples - Input PCM samples
 * @param options - Audio post-processing options
 * @returns Processed PCM samples
 */
export function processCompletePcm(
  samples: Int16Array,
  options: AudioPostProcessOptions
): Int16Array {
  const processor = createStreamingPostProcessor(options);
  const processed = processor.push(samples);
  const flushed = processor.flush();

  if (flushed.length === 0) {
    return processed;
  }

  const output = new Int16Array(processed.length + flushed.length);
  output.set(processed, 0);
  output.set(flushed, processed.length);
  return output;
}

/**
 * Splits PCM samples into LiveKit audio frames.
 * @param samples - PCM samples
 * @param sampleRate - Audio sample rate
 * @returns Completed LiveKit audio frames
 */
export function buildAudioFrames(samples: Int16Array, sampleRate: number): AudioFrame[] {
  const byteStream = new AudioByteStream(sampleRate, NUM_CHANNELS, Math.floor(sampleRate / 5));
  return [...byteStream.write(int16ToBytes(samples)), ...byteStream.flush()];
}

/**
 * Emits completed audio frames into the LiveKit queue.
 * @param queue - LiveKit queue
 * @param source - Source synthesized audio event
 * @param frames - Completed audio frames
 * @param final - Whether this is the final event
 * @param pendingFrame - Previous pending frame
 * @returns Next pending frame
 */
export function emitAudioFrames(
  queue: {
    put(value: tts.SynthesizedAudio | typeof tts.SynthesizeStream.END_OF_STREAM): void;
  },
  source: tts.SynthesizedAudio,
  frames: AudioFrame[],
  final: boolean,
  pendingFrame: AudioFrame | null
): AudioFrame | null {
  const completeFrames = pendingFrame ? [pendingFrame, ...frames] : frames;
  let nextPendingFrame: AudioFrame | null = null;

  if (!final) {
    if (completeFrames.length === 0) {
      return nextPendingFrame;
    }

    for (let index = 0; index < completeFrames.length - 1; index += 1) {
      queue.put({ ...source, frame: completeFrames[index], final: false, timedTranscripts: undefined });
    }

    nextPendingFrame = completeFrames[completeFrames.length - 1] ?? null;
    return nextPendingFrame;
  }

  for (let index = 0; index < completeFrames.length; index += 1) {
    queue.put({
      ...source,
      frame: completeFrames[index],
      final: index === completeFrames.length - 1,
      timedTranscripts: undefined,
    });
  }

  return null;
}

/**
 * Converts int16 PCM samples to bytes.
 * @param samples - PCM samples
 * @returns Uint8Array view of the PCM buffer
 */
export function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}
