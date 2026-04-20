/**
 * Deepgram TTS wrapper for WhatsApp calls.
 *
 * Responsibilities:
 * - Stream Deepgram Aura audio into LiveKit
 * - Apply speed adjustment and loudness normalization
 * - Keep the WhatsApp agent TTS creation simple
 */

import { AudioByteStream, type APIConnectOptions, tts } from "@livekit/agents";
import { TTS as DeepgramTTS } from "@livekit/agents-plugin-deepgram";
import { AudioFrame } from "@livekit/rtc-node";
import { StreamingAudioPostProcessor } from "../audio/postprocess.js";
import { NUM_CHANNELS, SAMPLE_RATE } from "../whatsappVoice.js";

// ============================================================================
// TYPES
// ============================================================================

interface ProcessedTtsOptions {
  model: string;
  speed: number;
  sampleRate?: number;
  apiKey: string;
}

// ============================================================================
// MAIN CLASS
// ============================================================================

/**
 * Deepgram TTS implementation with WhatsApp-specific audio post-processing.
 */
export class ProcessedDeepgramTTS extends tts.TTS {
  readonly label = "whatsapp.ProcessedDeepgramTTS";
  private readonly baseTts: DeepgramTTS;
  private readonly speed: number;
  private readonly voiceModel: string;

  /**
   * Creates the processed Deepgram TTS wrapper.
   * @param options - TTS model and audio settings
   */
  constructor(options: ProcessedTtsOptions) {
    super(options.sampleRate ?? SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.speed = options.speed;
    this.voiceModel = options.model;
    this.baseTts = new DeepgramTTS({
      model: options.model,
      sampleRate: options.sampleRate ?? SAMPLE_RATE,
      apiKey: options.apiKey,
    });

    this.baseTts.on("metrics_collected", (metrics) => this.emit("metrics_collected", metrics));
    this.baseTts.on("error", (error) => this.emit("error", error));
  }

  /**
   * Returns the active voice model.
   * @returns Deepgram voice model name
   */
  get model(): string {
    return this.voiceModel;
  }

  /**
   * Returns the provider label for metrics/debugging.
   * @returns Provider label
   */
  get provider(): string {
    return "Deepgram+WSOLA";
  }

  /**
   * Creates a chunked synthesis stream.
   * @param text - Text to synthesize
   * @param connOptions - Optional LiveKit connection options
   * @param abortSignal - Optional abort signal
   * @returns Chunked synthesis stream
   */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal
  ): tts.ChunkedStream {
    return new ProcessedChunkedStream(
      this,
      this.baseTts.synthesize(text, connOptions, abortSignal),
      text,
      this.speed,
      this.sampleRate,
      connOptions,
      abortSignal
    );
  }

  /**
   * Creates a streaming synthesis stream.
   * @param options - Optional connection options
   * @returns Streaming synthesis stream
   */
  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new ProcessedSynthesizeStream(
      this,
      this.baseTts.stream(),
      this.speed,
      this.sampleRate,
      options?.connOptions
    );
  }

  /**
   * Closes the underlying Deepgram stream.
   * @returns Promise that resolves when the stream is closed
   */
  async close(): Promise<void> {
    await this.baseTts.close();
  }
}

// ============================================================================
// INTERNAL STREAMS
// ============================================================================

class ProcessedChunkedStream extends tts.ChunkedStream {
  readonly label = "whatsapp.ProcessedChunkedStream";
  private readonly inner: tts.ChunkedStream;
  private readonly speed: number;
  private readonly sampleRate: number;

  constructor(
    ttsInstance: ProcessedDeepgramTTS,
    inner: tts.ChunkedStream,
    text: string,
    speed: number,
    sampleRate: number,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.inner = inner;
    this.speed = speed;
    this.sampleRate = sampleRate;
  }

  protected async run(): Promise<void> {
    const processor = new StreamingAudioPostProcessor({
      speed: this.speed,
      sampleRate: this.sampleRate,
      numChannels: NUM_CHANNELS,
    });
    const byteStream = new AudioByteStream(this.sampleRate, NUM_CHANNELS, Math.floor(this.sampleRate / 5));
    let pendingFrame: AudioFrame | null = null;

    try {
      for await (const event of this.inner) {
        const processed = processor.push(event.frame.data);
        const frames = processed.length > 0 ? byteStream.write(int16ToBytes(processed)) : [];

        if (event.final) {
          const flushed = processor.flush();
          const flushedFrames = [
            ...frames,
            ...(flushed.length > 0 ? byteStream.write(int16ToBytes(flushed)) : []),
            ...byteStream.flush(),
          ];
          pendingFrame = emitFrames(this.queue, event, flushedFrames, true, pendingFrame);
        } else {
          pendingFrame = emitFrames(this.queue, event, frames, false, pendingFrame);
        }
      }

      if (pendingFrame) {
        this.queue.put({
          requestId: "finalized",
          segmentId: "finalized",
          frame: pendingFrame,
          final: true,
          timedTranscripts: undefined,
        });
      }
    } finally {
      this.inner.close();
    }
  }
}

class ProcessedSynthesizeStream extends tts.SynthesizeStream {
  readonly label = "whatsapp.ProcessedSynthesizeStream";
  private readonly inner: tts.SynthesizeStream;
  private readonly speed: number;
  private readonly sampleRate: number;

  constructor(
    ttsInstance: ProcessedDeepgramTTS,
    inner: tts.SynthesizeStream,
    speed: number,
    sampleRate: number,
    connOptions?: APIConnectOptions
  ) {
    super(ttsInstance, connOptions);
    this.inner = inner;
    this.speed = speed;
    this.sampleRate = sampleRate;
  }

  protected async run(): Promise<void> {
    const processor = new StreamingAudioPostProcessor({
      speed: this.speed,
      sampleRate: this.sampleRate,
      numChannels: NUM_CHANNELS,
    });
    const byteStream = new AudioByteStream(this.sampleRate, NUM_CHANNELS, Math.floor(this.sampleRate / 5));
    let pendingFrame: AudioFrame | null = null;

    const inputTask = (async () => {
      for await (const item of this.input) {
        if (item === ProcessedSynthesizeStream.FLUSH_SENTINEL) {
          this.inner.flush();
        } else {
          this.inner.pushText(item);
        }
      }
      this.inner.endInput();
    })();

    const outputTask = (async () => {
      for await (const event of this.inner) {
        if (event === tts.SynthesizeStream.END_OF_STREAM) {
          if (pendingFrame) {
            this.queue.put({
              requestId: "finalized",
              segmentId: "finalized",
              frame: pendingFrame,
              final: true,
              timedTranscripts: undefined,
            });
            pendingFrame = null;
          }
          this.queue.put(ProcessedSynthesizeStream.END_OF_STREAM);
          continue;
        }

        const processed = processor.push(event.frame.data);
        const frames = processed.length > 0 ? byteStream.write(int16ToBytes(processed)) : [];

        if (event.final) {
          const flushed = processor.flush();
          const flushedFrames = [
            ...frames,
            ...(flushed.length > 0 ? byteStream.write(int16ToBytes(flushed)) : []),
            ...byteStream.flush(),
          ];
          pendingFrame = emitFrames(this.queue, event, flushedFrames, true, pendingFrame);
        } else {
          pendingFrame = emitFrames(this.queue, event, frames, false, pendingFrame);
        }
      }
    })();

    try {
      await Promise.all([inputTask, outputTask]);
    } finally {
      this.inner.close();
    }
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Converts int16 PCM samples to bytes.
 * @param samples - PCM samples
 * @returns Uint8Array view of the PCM buffer
 */
function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
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
function emitFrames(
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
