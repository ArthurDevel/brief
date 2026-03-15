/**
 * AudioWorklet processor for playing back PCM16 24kHz audio from the server.
 *
 * Receives PCM16 buffers from the main thread, converts to float32,
 * resamples from 24kHz to the output sample rate, and writes to the output.
 */

const SOURCE_SAMPLE_RATE = 24000;

class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /** @type {Float32Array[]} Queued float32 chunks at 24kHz */
    this._chunks = [];
    /** Total samples available across all chunks */
    this._totalSamples = 0;
    /** Fractional read position within the current first chunk */
    this._readPos = 0;

    this.port.onmessage = (event) => {
      const pcm16 = new Int16Array(event.data);
      const float32 = new Float32Array(pcm16.length);
      for (let i = 0; i < pcm16.length; i++) {
        float32[i] = pcm16[i] / 32768;
      }
      this._chunks.push(float32);
      this._totalSamples += float32.length;
    };
  }

  process(_inputs, outputs) {
    const channel = outputs[0]?.[0];
    if (!channel) return true;

    const ratio = SOURCE_SAMPLE_RATE / sampleRate;

    for (let i = 0; i < channel.length; i++) {
      if (this._chunks.length === 0) {
        channel[i] = 0;
        continue;
      }

      const chunk = this._chunks[0];
      const index = Math.floor(this._readPos);

      if (index < chunk.length) {
        channel[i] = chunk[index];
      } else {
        channel[i] = 0;
      }

      this._readPos += ratio;

      // Advance to next chunk when current is consumed
      while (this._chunks.length > 0 && this._readPos >= this._chunks[0].length) {
        this._readPos -= this._chunks[0].length;
        this._totalSamples -= this._chunks[0].length;
        this._chunks.shift();
      }
    }

    return true;
  }
}

registerProcessor("playback-processor", PlaybackProcessor);
