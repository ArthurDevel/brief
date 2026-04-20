/**
 * Pitch-preserving WSOLA speed processor for WhatsApp TTS audio.
 *
 * Responsibilities:
 * - Speed up or slow down mono PCM audio
 * - Preserve pitch while changing tempo
 * - Support streaming chunk-by-chunk processing
 */

// ============================================================================
// CONSTANTS
// ============================================================================

const WINDOW_SIZE_MS = 25;
const OVERLAP_RATIO = 0.5;
const MAX_SEEK_MS = 10;

// ============================================================================
// MAIN CLASS
// ============================================================================

/**
 * Streaming WSOLA-based speed processor for mono PCM audio.
 */
export class WSOLAStreamer {
  private readonly tempo: number;
  private readonly windowSize: number;
  private readonly overlapSize: number;
  private readonly maxSeek: number;
  private readonly analysisHop: number;
  private readonly window: Float32Array<ArrayBufferLike>;
  private inputBuffer: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private outputBuffer: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private readPos = 0;
  private firstWindow = true;

  /**
   * Creates the speed processor.
   * @param sampleRate - Audio sample rate
   * @param numChannels - Number of audio channels
   * @param tempo - Playback speed multiplier
   */
  constructor(sampleRate: number, numChannels: number, tempo: number) {
    if (tempo < 0.5 || tempo > 2.0) {
      throw new Error(`Tempo must be between 0.5 and 2.0, got ${tempo}`);
    }

    if (numChannels !== 1) {
      throw new Error(`Only mono audio is supported, got ${numChannels} channels`);
    }

    this.tempo = tempo;
    this.windowSize = Math.floor(sampleRate * WINDOW_SIZE_MS / 1000);
    this.overlapSize = Math.floor(this.windowSize * OVERLAP_RATIO);
    this.maxSeek = Math.floor(sampleRate * MAX_SEEK_MS / 1000);
    const synthesisHop = this.windowSize - this.overlapSize;
    this.analysisHop = Math.max(1, Math.floor(synthesisHop * tempo));
    this.window = new Float32Array(this.windowSize);

    for (let i = 0; i < this.windowSize; i += 1) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, this.windowSize - 1));
    }
  }

  /**
   * Processes one PCM chunk.
   * @param audio - PCM audio chunk
   * @returns Speed-adjusted PCM chunk
   */
  process(audio: Int16Array): Int16Array {
    if (audio.length === 0) {
      return new Int16Array(0);
    }

    this.inputBuffer = concatFloat32([this.inputBuffer, int16ToFloat32(audio)]);
    const outputChunks: Float32Array[] = [];

    while (this.canProcessWindow()) {
      const chunk = this.processOneWindow();
      if (chunk.length > 0) {
        outputChunks.push(chunk);
      }
    }

    if (outputChunks.length === 0) {
      return new Int16Array(0);
    }

    return floatToInt16(concatFloat32(outputChunks));
  }

  /**
   * Flushes the internal buffers.
   * @returns Remaining speed-adjusted PCM audio
   */
  flush(): Int16Array {
    const padding = new Float32Array(this.windowSize + this.maxSeek);
    this.inputBuffer = concatFloat32([this.inputBuffer, padding]);

    const outputChunks: Float32Array[] = [];
    while (this.canProcessWindow()) {
      const chunk = this.processOneWindow();
      if (chunk.length > 0) {
        outputChunks.push(chunk);
      }
    }

    if (this.outputBuffer.length > 0) {
      outputChunks.push(this.outputBuffer);
      this.outputBuffer = new Float32Array(0);
    }

    if (outputChunks.length === 0) {
      return new Int16Array(0);
    }

    return floatToInt16(concatFloat32(outputChunks));
  }

  /**
   * Returns true when enough buffered audio exists for another window.
   * @returns Whether one more window can be processed
   */
  private canProcessWindow(): boolean {
    const required = this.readPos + this.windowSize + this.maxSeek;
    return required <= this.inputBuffer.length;
  }

  /**
   * Processes the next WSOLA window.
   * @returns Finalized output chunk
   */
  private processOneWindow(): Float32Array<ArrayBufferLike> {
    if (this.firstWindow) {
      const segment = sliceFloat32(this.inputBuffer, this.readPos, this.readPos + this.windowSize);
      const windowed = this.applyWindow(segment);
      this.firstWindow = false;
      this.readPos += this.analysisHop;
      this.outputBuffer = windowed;
      return new Float32Array(0);
    }

    const bestOffset = this.findBestOffset();
    const actualPos = this.readPos + bestOffset;
    const segment = sliceFloat32(this.inputBuffer, actualPos, actualPos + this.windowSize);
    const windowed = this.applyWindow(segment);

    let finalized: Float32Array<ArrayBufferLike> = new Float32Array(0);
    if (this.outputBuffer.length >= this.overlapSize) {
      const outputLength = this.outputBuffer.length;
      finalized = sliceFloat32(this.outputBuffer, 0, outputLength - this.overlapSize);
      const overlapTail = sliceFloat32(this.outputBuffer, outputLength - this.overlapSize);
      const overlapHead = sliceFloat32(windowed, 0, this.overlapSize);
      const crossfaded = new Float32Array(this.overlapSize);

      for (let i = 0; i < this.overlapSize; i += 1) {
        crossfaded[i] = (overlapTail[i] ?? 0) + (overlapHead[i] ?? 0);
      }

      this.outputBuffer = concatFloat32([
        crossfaded,
        sliceFloat32(windowed, this.overlapSize)
      ]);
    } else {
      this.outputBuffer = concatFloat32([this.outputBuffer, windowed]);
    }

    this.readPos += this.analysisHop;
    this.compactInputBuffer();
    return finalized;
  }

  /**
   * Applies the Hann window to a segment.
   * @param segment - Audio segment
   * @returns Windowed audio segment
   */
  private applyWindow(
    segment: Float32Array<ArrayBufferLike>
  ): Float32Array<ArrayBufferLike> {
    const output: Float32Array<ArrayBufferLike> = new Float32Array(segment.length);
    for (let i = 0; i < segment.length; i += 1) {
      output[i] = (segment[i] ?? 0) * (this.window[i] ?? 0);
    }
    return output;
  }

  /**
   * Finds the best matching overlap offset.
   * @returns Offset into the current input buffer
   */
  private findBestOffset(): number {
    if (this.outputBuffer.length < this.overlapSize) {
      return 0;
    }

    const reference = sliceFloat32(
      this.outputBuffer,
      this.outputBuffer.length - this.overlapSize
    );

    let bestOffset = 0;
    let bestCorrelation = -1;

    for (let offset = 0; offset <= this.maxSeek; offset += 1) {
      const position = this.readPos + offset;
      if (position + this.overlapSize > this.inputBuffer.length) {
        continue;
      }

      const candidate = sliceFloat32(this.inputBuffer, position, position + this.overlapSize);
      const correlation = normalizedCrossCorrelation(reference, candidate);
      if (correlation > bestCorrelation) {
        bestCorrelation = correlation;
        bestOffset = offset;
      }
    }

    return bestOffset;
  }

  /**
   * Compacts buffered input that is no longer needed.
   * @returns Nothing
   */
  private compactInputBuffer(): void {
    const safePosition = Math.max(0, this.readPos - this.maxSeek);
    if (safePosition > 0) {
      this.inputBuffer = sliceFloat32(this.inputBuffer, safePosition);
      this.readPos -= safePosition;
    }
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Computes normalized cross correlation for two windows.
 * @param left - Left comparison window
 * @param right - Right comparison window
 * @returns Correlation score
 */
function normalizedCrossCorrelation(
  left: Float32Array<ArrayBufferLike>,
  right: Float32Array<ArrayBufferLike>
): number {
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;

  for (let i = 0; i < left.length; i += 1) {
    const leftSample = left[i] ?? 0;
    const rightSample = right[i] ?? 0;
    dot += leftSample * rightSample;
    normLeft += leftSample * leftSample;
    normRight += rightSample * rightSample;
  }

  if (normLeft < 1e-8 || normRight < 1e-8) {
    return 0;
  }

  return dot / Math.sqrt(normLeft * normRight);
}

/**
 * Concatenates Float32Array chunks.
 * @param parts - Chunks to concatenate
 * @returns Combined Float32Array
 */
function concatFloat32(
  parts: Float32Array<ArrayBufferLike>[]
): Float32Array<ArrayBufferLike> {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Float32Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

/**
 * Converts normalized floats to int16 PCM.
 * @param samples - Normalized audio samples
 * @returns PCM audio
 */
function floatToInt16(samples: Float32Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
    output[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
  }
  return output;
}

/**
 * Converts int16 PCM to normalized floats.
 * @param samples - PCM audio samples
 * @returns Normalized float samples
 */
function int16ToFloat32(samples: Int16Array): Float32Array<ArrayBufferLike> {
  const output: Float32Array<ArrayBufferLike> = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    output[i] = (samples[i] ?? 0) / 32768;
  }
  return output;
}

/**
 * Slices a Float32Array.
 * @param source - Source array
 * @param start - Slice start
 * @param end - Optional slice end
 * @returns Sliced Float32Array
 */
function sliceFloat32(
  source: Float32Array<ArrayBufferLike>,
  start: number,
  end?: number
): Float32Array<ArrayBufferLike> {
  return source.slice(start, end);
}
