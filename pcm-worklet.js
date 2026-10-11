// Web Audio runs this processor off the main thread. Stream mono PCM16 at 16 kHz
// in 20 ms chunks, irrespective of the browser/device's actual sample rate.
class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.weight = 0;
    this.sum = 0;
    this.position = 0;
    this.energy = 0;
    this.buffer = new ArrayBuffer(320 * 2);
    this.view = new DataView(this.buffer);
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      let remaining = 1;
      while (remaining > 1e-8) {
        const amount = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * amount;
        this.weight += amount;
        remaining -= amount;
        if (this.weight >= this.ratio - 1e-8) {
          const value = Math.max(-1, Math.min(1, this.sum / this.weight));
          this.view.setInt16(this.position * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
          this.energy += value * value;
          this.position++;
          this.weight = 0;
          this.sum = 0;
          if (this.position === 320) {
            this.port.postMessage({ pcm: this.buffer, level: Math.sqrt(this.energy / 320) }, [this.buffer]);
            this.buffer = new ArrayBuffer(320 * 2);
            this.view = new DataView(this.buffer);
            this.position = 0;
            this.energy = 0;
          }
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-recorder", PCMRecorder);
