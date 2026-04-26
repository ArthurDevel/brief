/**
 * Deepgram voice provider for WhatsApp calls.
 *
 * Responsibilities:
 * - Return the configured Deepgram STT model descriptor
 * - Stream Deepgram Aura audio into LiveKit
 * - Apply shared WhatsApp TTS post-processing
 */

import { AudioByteStream, type APIConnectOptions, tts } from "@livekit/agents";
import { TTS as DeepgramTTS } from "@livekit/agents-plugin-deepgram";
import type { AudioFrame } from "@livekit/rtc-node";
import {
  createStreamingPostProcessor,
  emitAudioFrames,
  int16ToBytes,
} from "../postprocessor.js";
import { NUM_CHANNELS, SAMPLE_RATE } from "../types.js";

// ============================================================================
// TYPES
// ============================================================================

interface ProcessedDeepgramTtsOptions {
  apiKey: string;
  model: string;
  speed: number;
  sampleRate?: number;
}

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Returns the Deepgram STT model descriptor for LiveKit AgentSession.
 * @param model - Configured Deepgram STT model descriptor
 * @returns LiveKit STT model descriptor
 */
export function createDeepgramStt(model: string): string {
  return model;
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
  constructor(options: ProcessedDeepgramTtsOptions) {
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
    return new ProcessedDeepgramChunkedStream(
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
    return new ProcessedDeepgramSynthesizeStream(
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

class ProcessedDeepgramChunkedStream extends tts.ChunkedStream {
  readonly label = "whatsapp.ProcessedDeepgramChunkedStream";
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
    const processor = createStreamingPostProcessor({
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
          pendingFrame = emitAudioFrames(this.queue, event, flushedFrames, true, pendingFrame);
        } else {
          pendingFrame = emitAudioFrames(this.queue, event, frames, false, pendingFrame);
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

class ProcessedDeepgramSynthesizeStream extends tts.SynthesizeStream {
  readonly label = "whatsapp.ProcessedDeepgramSynthesizeStream";
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
    const processor = createStreamingPostProcessor({
      speed: this.speed,
      sampleRate: this.sampleRate,
      numChannels: NUM_CHANNELS,
    });
    const byteStream = new AudioByteStream(this.sampleRate, NUM_CHANNELS, Math.floor(this.sampleRate / 5));
    let pendingFrame: AudioFrame | null = null;

    const inputTask = (async () => {
      for await (const item of this.input) {
        if (item === ProcessedDeepgramSynthesizeStream.FLUSH_SENTINEL) {
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
          this.queue.put(ProcessedDeepgramSynthesizeStream.END_OF_STREAM);
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
          pendingFrame = emitAudioFrames(this.queue, event, flushedFrames, true, pendingFrame);
        } else {
          pendingFrame = emitAudioFrames(this.queue, event, frames, false, pendingFrame);
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
