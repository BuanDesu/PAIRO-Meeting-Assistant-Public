class VoiceChunks extends AudioWorkletProcessor {
  constructor() {
    super(); this.samples = new Float32Array(sampleRate * 12); this.length = 0;
    this.voiceSamples = 0; this.silence = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const count = channels[0].length;
    let energy = 0;
    for (let i = 0; i < count; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      this.samples[this.length++] = value; energy += value * value;
    }
    if (Math.sqrt(energy / count) > 0.008) { this.voiceSamples += count; this.silence = 0; }
    else this.silence += count;
    // End at a quiet boundary after speech, or after 12 s. Skip silence entirely.
    if (this.length >= sampleRate * 12 || (this.voiceSamples > sampleRate * 0.3 && this.silence >= sampleRate * 0.8)) {
      if (this.voiceSamples > sampleRate * 0.3) {
        const outputLength = Math.floor(this.length * 16000 / sampleRate);
        const pcm = new Int16Array(outputLength);
        for (let i = 0; i < outputLength; i++) {
          const from = Math.floor(i * sampleRate / 16000), to = Math.min(this.length, Math.max(from + 1, Math.floor((i + 1) * sampleRate / 16000)));
          let value = 0; for (let j = from; j < to; j++) value += this.samples[j];
          pcm[i] = Math.max(-32768, Math.min(32767, Math.round(value / (to - from) * 32767)));
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
      }
      this.length = 0; this.voiceSamples = 0; this.silence = 0;
    }
    return true;
  }
}
registerProcessor('pairo-voice-chunks', VoiceChunks);
