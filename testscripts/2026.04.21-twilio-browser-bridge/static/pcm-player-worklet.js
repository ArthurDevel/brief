class PcmPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.currentChunk = null;
    this.currentOffset = 0;

    this.port.onmessage = (event) => {
      const pcmChunk = new Int16Array(event.data);
      const floatChunk = new Float32Array(pcmChunk.length);
      for (let index = 0; index < pcmChunk.length; index += 1) {
        floatChunk[index] = pcmChunk[index] / 32768;
      }
      this.queue.push(floatChunk);
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) {
      return true;
    }

    for (let sampleIndex = 0; sampleIndex < output.length; sampleIndex += 1) {
      if (!this.currentChunk || this.currentOffset >= this.currentChunk.length) {
        this.currentChunk = this.queue.shift() ?? null;
        this.currentOffset = 0;
      }

      if (!this.currentChunk) {
        output[sampleIndex] = 0;
        continue;
      }

      output[sampleIndex] = this.currentChunk[this.currentOffset] ?? 0;
      this.currentOffset += 1;
    }

    return true;
  }
}

registerProcessor("pcm-player-processor", PcmPlayerProcessor);
