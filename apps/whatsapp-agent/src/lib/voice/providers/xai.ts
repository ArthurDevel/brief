/**
 * xAI voice provider for WhatsApp calls.
 *
 * Responsibilities:
 * - Return the configured xAI STT model descriptor
 * - Convert text into xAI PCM audio
 * - Apply shared WhatsApp TTS post-processing
 */

import { randomUUID } from "node:crypto";
import { type APIConnectOptions, tts } from "@livekit/agents";
import {
  buildAudioFrames,
  processCompletePcm,
} from "../postprocessor.js";
import { NUM_CHANNELS, SAMPLE_RATE } from "../types.js";

// ============================================================================
// TYPES
// ============================================================================

interface ProcessedXaiTtsOptions {
  apiKey: string;
  voiceId: string;
  speed: number;
  sampleRate?: number;
  fetchImplementation?: typeof fetch;
}

interface PendingSegment {
  segmentId: string;
  text: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const XAI_TTS_URL = "https://api.x.ai/v1/tts";
const XAI_TTS_LANGUAGE = "en";

// ============================================================================
// MAIN HELPERS
// ============================================================================

/**
 * Returns the xAI STT model descriptor for LiveKit AgentSession.
 * @param model - Configured xAI STT model descriptor
 * @returns LiveKit STT model descriptor
 */
export function createXaiStt(model: string): string {
  return model;
}

// ============================================================================
// MAIN CLASS
// ============================================================================

/**
 * xAI TTS implementation with WhatsApp-specific audio post-processing.
 */
export class ProcessedXaiTTS extends tts.TTS {
  readonly label = "whatsapp.ProcessedXaiTTS";
  private readonly apiKey: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly speed: number;
  private readonly voiceId: string;

  /**
   * Creates the processed xAI TTS wrapper.
   * @param options - TTS voice and audio settings
   */
  constructor(options: ProcessedXaiTtsOptions) {
    super(options.sampleRate ?? SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.apiKey = options.apiKey;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.speed = options.speed;
    this.voiceId = options.voiceId;
  }

  /**
   * Returns the active voice ID.
   * @returns xAI voice ID
   */
  get model(): string {
    return this.voiceId;
  }

  /**
   * Returns the provider label for metrics/debugging.
   * @returns Provider label
   */
  get provider(): string {
    return "xAI+WSOLA";
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
    return new ProcessedXaiChunkedStream(this, text, connOptions, abortSignal);
  }

  /**
   * Creates a streaming synthesis stream that synthesizes at flush boundaries.
   * @param options - Optional connection options
   * @returns Streaming synthesis stream
   */
  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new ProcessedXaiSynthesizeStream(this, options?.connOptions);
  }

  /**
   * Generates processed PCM for one text segment.
   * @param text - Text to synthesize
   * @returns Processed PCM16 samples
   */
  async generatePcm(text: string): Promise<Int16Array> {
    const rawPcm = await callXaiTts(
      this.fetchImplementation,
      text,
      this.voiceId,
      this.apiKey,
      this.sampleRate
    );

    return processCompletePcm(rawPcm, {
      speed: this.speed,
      sampleRate: this.sampleRate,
      numChannels: NUM_CHANNELS,
    });
  }
}

// ============================================================================
// INTERNAL STREAMS
// ============================================================================

class ProcessedXaiChunkedStream extends tts.ChunkedStream {
  readonly label = "whatsapp.ProcessedXaiChunkedStream";
  private readonly ttsInstance: ProcessedXaiTTS;

  constructor(
    ttsInstance: ProcessedXaiTTS,
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
    const frames = buildAudioFrames(pcm, this.ttsInstance.sampleRate);

    for (let index = 0; index < frames.length; index += 1) {
      this.queue.put({
        requestId,
        segmentId,
        frame: frames[index],
        deltaText: index === 0 ? this.inputText : undefined,
        final: index === frames.length - 1,
        timedTranscripts: undefined,
      });
    }
  }
}

class ProcessedXaiSynthesizeStream extends tts.SynthesizeStream {
  readonly label = "whatsapp.ProcessedXaiSynthesizeStream";
  private readonly ttsInstance: ProcessedXaiTTS;

  constructor(ttsInstance: ProcessedXaiTTS, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.ttsInstance = ttsInstance;
  }

  protected async run(): Promise<void> {
    let textBuffer = "";
    let pendingSegment: PendingSegment | null = null;

    for await (const item of this.input) {
      if (item === ProcessedXaiSynthesizeStream.FLUSH_SENTINEL) {
        if (!textBuffer.trim()) {
          continue;
        }

        pendingSegment = {
          segmentId: randomUUID(),
          text: textBuffer,
        };

        await this.emitSegment(pendingSegment);
        textBuffer = "";
        pendingSegment = null;
        continue;
      }

      textBuffer += item;
    }

    if (textBuffer.trim()) {
      await this.emitSegment({
        segmentId: randomUUID(),
        text: textBuffer,
      });
    }

    this.queue.put(ProcessedXaiSynthesizeStream.END_OF_STREAM);
  }

  /**
   * Synthesizes and emits one buffered segment.
   * @param segment - Pending text segment
   * @returns Promise that resolves after queued frames are emitted
   */
  private async emitSegment(segment: PendingSegment): Promise<void> {
    const pcm = await this.ttsInstance.generatePcm(segment.text);
    const frames = buildAudioFrames(pcm, this.ttsInstance.sampleRate);
    const requestId = randomUUID();

    for (let index = 0; index < frames.length; index += 1) {
      this.queue.put({
        requestId,
        segmentId: segment.segmentId,
        frame: frames[index],
        deltaText: index === 0 ? segment.text : undefined,
        final: index === frames.length - 1,
        timedTranscripts: undefined,
      });
    }
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Synthesizes speech with xAI and returns raw PCM16 audio.
 * @param fetchImplementation - Fetch implementation used for the request
 * @param text - Text to synthesize
 * @param voiceId - xAI voice ID
 * @param apiKey - xAI API key
 * @param sampleRate - Requested PCM sample rate
 * @returns PCM16 audio samples
 */
async function callXaiTts(
  fetchImplementation: typeof fetch,
  text: string,
  voiceId: string,
  apiKey: string,
  sampleRate: number
): Promise<Int16Array> {
  const response = await fetchImplementation(XAI_TTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice_id: voiceId,
      language: XAI_TTS_LANGUAGE,
      output_format: {
        codec: "pcm",
        sample_rate: sampleRate,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`xAI TTS failed (${response.status}): ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Int16Array(arrayBuffer.slice(0));
}
