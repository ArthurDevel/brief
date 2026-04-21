/**
 * xAI TTS wrapper for the LiveKit voice review app.
 *
 * Responsibilities:
 * - Convert text into xAI PCM audio
 * - Apply the existing speed and loudness post-processing
 * - Adapt unary synthesis into the LiveKit TTS interfaces
 */

import { randomUUID } from "node:crypto";
import { AudioByteStream, type APIConnectOptions, tts } from "@livekit/agents";
import { postProcessPcm } from "../audio/postprocess.js";
import { callXaiTts } from "../lib/xai.js";
import { NUM_CHANNELS, SAMPLE_RATE } from "../shared/constants.js";

// ============================================================================
// TYPES
// ============================================================================

interface XaiTtsOptions {
  apiKey: string;
  voice: string;
  speed: number;
  sampleRate?: number;
}

interface PendingSegment {
  segmentId: string;
  text: string;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Converts PCM16 samples into a byte view.
 * @param samples - PCM16 audio samples
 * @returns Byte view over the same buffer
 */
function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

/**
 * Splits synthesized PCM into LiveKit audio frames.
 * @param samples - PCM16 audio samples
 * @param sampleRate - Audio sample rate
 * @returns Framed audio ready for LiveKit TTS events
 */
function buildFrames(samples: Int16Array, sampleRate: number): ReturnType<AudioByteStream["write"]> {
  const byteStream = new AudioByteStream(sampleRate, NUM_CHANNELS, Math.floor(sampleRate / 5));
  return [...byteStream.write(int16ToBytes(samples)), ...byteStream.flush()];
}

// ============================================================================
// MAIN CLASS
// ============================================================================

/**
 * xAI TTS implementation that fits the LiveKit TTS interface.
 */
export class XaiTTS extends tts.TTS {
  readonly label = "voiceReview.XaiTTS";
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly speed: number;

  /**
   * Creates the xAI TTS adapter.
   * @param options - TTS credentials and audio settings
   */
  constructor(options: XaiTtsOptions) {
    super(options.sampleRate ?? SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.apiKey = options.apiKey;
    this.voiceId = options.voice;
    this.speed = options.speed;
  }

  /**
   * Returns the active voice ID.
   * @returns Voice ID
   */
  get model(): string {
    return this.voiceId;
  }

  /**
   * Returns the provider label for metrics and debugging.
   * @returns Provider label
   */
  get provider(): string {
    return "xAI+WSOLA";
  }

  /**
   * Synthesizes one text segment.
   * @param text - Text to convert to speech
   * @param connOptions - Optional LiveKit connection options
   * @param abortSignal - Optional abort signal
   * @returns Chunked stream for one synthesized segment
   */
  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal
  ): tts.ChunkedStream {
    return new XaiChunkedStream(this, text, connOptions, abortSignal);
  }

  /**
   * Creates a stream that buffers text until flush boundaries.
   * @param options - Optional LiveKit connection options
   * @returns Streaming TTS adapter
   */
  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new XaiSynthesizeStream(this, options?.connOptions);
  }

  /**
   * Generates processed PCM for one segment.
   * @param text - Text to synthesize
   * @returns Post-processed PCM16 samples
   */
  async generatePcm(text: string): Promise<Int16Array> {
    const rawPcm = await callXaiTts(text, this.voiceId, this.apiKey, this.sampleRate);
    return postProcessPcm(rawPcm, {
      speed: this.speed,
      sampleRate: this.sampleRate,
      numChannels: NUM_CHANNELS,
    });
  }
}

// ============================================================================
// INTERNAL STREAMS
// ============================================================================

class XaiChunkedStream extends tts.ChunkedStream {
  readonly label = "voiceReview.XaiChunkedStream";
  private readonly ttsInstance: XaiTTS;

  constructor(
    ttsInstance: XaiTTS,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.ttsInstance = ttsInstance;
  }

  protected async run(): Promise<void> {
    const requestId = randomUUID();
    const segmentId = randomUUID();
    const pcm = await this.ttsInstance.generatePcm(this.inputText);
    const frames = buildFrames(pcm, this.ttsInstance.sampleRate);

    for (let i = 0; i < frames.length; i += 1) {
      this.queue.put({
        requestId,
        segmentId,
        frame: frames[i],
        deltaText: i === 0 ? this.inputText : undefined,
        final: i === frames.length - 1,
        timedTranscripts: undefined,
      });
    }
  }
}

class XaiSynthesizeStream extends tts.SynthesizeStream {
  readonly label = "voiceReview.XaiSynthesizeStream";
  private readonly ttsInstance: XaiTTS;

  constructor(ttsInstance: XaiTTS, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.ttsInstance = ttsInstance;
  }

  protected async run(): Promise<void> {
    let textBuffer = "";
    let pendingSegment: PendingSegment | null = null;

    for await (const item of this.input) {
      if (item === XaiSynthesizeStream.FLUSH_SENTINEL) {
        if (!textBuffer.trim()) {
          continue;
        }

        pendingSegment = {
          segmentId: randomUUID(),
          text: textBuffer,
        };

        const pcm = await this.ttsInstance.generatePcm(pendingSegment.text);
        const frames = buildFrames(pcm, this.ttsInstance.sampleRate);
        const requestId = randomUUID();

        for (let i = 0; i < frames.length; i += 1) {
          this.queue.put({
            requestId,
            segmentId: pendingSegment.segmentId,
            frame: frames[i],
            deltaText: i === 0 ? pendingSegment.text : undefined,
            final: i === frames.length - 1,
            timedTranscripts: undefined,
          });
        }

        textBuffer = "";
        pendingSegment = null;
        continue;
      }

      textBuffer += item;
    }

    if (textBuffer.trim()) {
      const finalSegmentId = randomUUID();
      const pcm = await this.ttsInstance.generatePcm(textBuffer);
      const frames = buildFrames(pcm, this.ttsInstance.sampleRate);
      const requestId = randomUUID();

      for (let i = 0; i < frames.length; i += 1) {
        this.queue.put({
          requestId,
          segmentId: finalSegmentId,
          frame: frames[i],
          deltaText: i === 0 ? textBuffer : undefined,
          final: i === frames.length - 1,
          timedTranscripts: undefined,
        });
      }
    }

    this.queue.put(XaiSynthesizeStream.END_OF_STREAM);
  }
}
