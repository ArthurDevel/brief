import { AudioByteStream, type APIConnectOptions, tts } from "@livekit/agents";
import { TTS as DeepgramTTS } from "@livekit/agents-plugin-deepgram";
import { AudioFrame } from "@livekit/rtc-node";
import { StreamingAudioPostProcessor } from "../audio/postprocess.js";
import { NUM_CHANNELS, SAMPLE_RATE } from "../shared/constants.js";

function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

interface ProcessedTTSOptions {
  model: string;
  speed: number;
  sampleRate?: number;
  apiKey?: string;
}

export class ProcessedDeepgramTTS extends tts.TTS {
  readonly label = "voiceReview.ProcessedDeepgramTTS";
  private readonly baseTts: DeepgramTTS;
  private readonly voiceModel: string;
  private readonly speed: number;

  constructor(options: ProcessedTTSOptions) {
    super(options.sampleRate ?? SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.voiceModel = options.model;
    this.speed = options.speed;
    this.baseTts = new DeepgramTTS({
      model: options.model,
      sampleRate: options.sampleRate ?? SAMPLE_RATE,
      apiKey: options.apiKey
    });

    this.baseTts.on("metrics_collected", (metrics) => this.emit("metrics_collected", metrics));
    this.baseTts.on("error", (error) => this.emit("error", error));
  }

  get model(): string {
    return this.voiceModel;
  }

  get provider(): string {
    return "Deepgram+WSOLA";
  }

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

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new ProcessedSynthesizeStream(
      this,
      this.baseTts.stream(),
      this.speed,
      this.sampleRate,
      options?.connOptions
    );
  }

  async close(): Promise<void> {
    await this.baseTts.close();
  }
}

class ProcessedChunkedStream extends tts.ChunkedStream {
  readonly label = "voiceReview.ProcessedChunkedStream";
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
      numChannels: NUM_CHANNELS
    });
    const byteStream = new AudioByteStream(this.sampleRate, NUM_CHANNELS, Math.floor(this.sampleRate / 5));
    let pendingFrame: AudioFrame | null = null;

    const emitFrames = (
      source: tts.SynthesizedAudio,
      frames: AudioFrame[],
      final: boolean
    ) => {
      const completeFrames = pendingFrame ? [pendingFrame, ...frames] : frames;
      pendingFrame = null;

      if (!final) {
        if (completeFrames.length === 0) {
          return;
        }

        for (let i = 0; i < completeFrames.length - 1; i += 1) {
          this.queue.put({ ...source, frame: completeFrames[i], final: false, timedTranscripts: undefined });
        }

        pendingFrame = completeFrames[completeFrames.length - 1] ?? null;
        return;
      }

      for (let i = 0; i < completeFrames.length; i += 1) {
        this.queue.put({
          ...source,
          frame: completeFrames[i],
          final: i === completeFrames.length - 1,
          timedTranscripts: undefined
        });
      }
    };

    try {
      for await (const event of this.inner) {
        const processed = processor.push(event.frame.data);
        const frames = processed.length > 0 ? byteStream.write(int16ToBytes(processed)) : [];

        if (event.final) {
          const flushed = processor.flush();
          const flushedFrames = [
            ...frames,
            ...(flushed.length > 0 ? byteStream.write(int16ToBytes(flushed)) : []),
            ...byteStream.flush()
          ];
          emitFrames(event, flushedFrames, true);
        } else {
          emitFrames(event, frames, false);
        }
      }

      if (pendingFrame) {
        this.queue.put({
          requestId: "finalized",
          segmentId: "finalized",
          frame: pendingFrame,
          final: true,
          timedTranscripts: undefined
        });
        pendingFrame = null;
      }
    } finally {
      this.inner.close();
    }
  }
}

class ProcessedSynthesizeStream extends tts.SynthesizeStream {
  readonly label = "voiceReview.ProcessedSynthesizeStream";
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
      numChannels: NUM_CHANNELS
    });
    const byteStream = new AudioByteStream(this.sampleRate, NUM_CHANNELS, Math.floor(this.sampleRate / 5));
    let pendingFrame: AudioFrame | null = null;

    const emitFrames = (
      source: tts.SynthesizedAudio,
      frames: AudioFrame[],
      final: boolean
    ) => {
      const completeFrames = pendingFrame ? [pendingFrame, ...frames] : frames;
      pendingFrame = null;

      if (!final) {
        if (completeFrames.length === 0) {
          return;
        }

        for (let i = 0; i < completeFrames.length - 1; i += 1) {
          this.queue.put({ ...source, frame: completeFrames[i], final: false, timedTranscripts: undefined });
        }

        pendingFrame = completeFrames[completeFrames.length - 1] ?? null;
        return;
      }

      for (let i = 0; i < completeFrames.length; i += 1) {
        this.queue.put({
          ...source,
          frame: completeFrames[i],
          final: i === completeFrames.length - 1,
          timedTranscripts: undefined
        });
      }
    };

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
              timedTranscripts: undefined
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
            ...byteStream.flush()
          ];
          emitFrames(event, flushedFrames, true);
        } else {
          emitFrames(event, frames, false);
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
