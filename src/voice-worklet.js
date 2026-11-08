// This stage only collects candidate audio. The local native Silero model
// makes the speech decision before any transcription or automatic question.
class VoiceChunks extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(Math.round(sampleRate * 12));
    this.prefix = new Float32Array(Math.round(sampleRate * 0.32));
    this.prefixLength = this.prefixEnd = this.length = this.above = this.silence = 0;
    this.floor = 0.00045;
  }
  remember(frame) {
    for (const sample of frame) {
      this.prefix[this.prefixEnd] = sample;
      this.prefixEnd = (this.prefixEnd + 1) % this.prefix.length;
    }
    this.prefixLength = Math.min(this.prefix.length, this.prefixLength + frame.length);
  }
  begin(threshold) {
    const start = (this.prefixEnd + this.prefix.length - this.prefixLength) % this.prefix.length;
    for (let i = 0; i < this.prefixLength; i++) this.samples[i] = this.prefix[(start + i) % this.prefix.length];
    this.length = this.prefixLength; this.threshold = threshold;
  }
  emit(endFrame) {
    const outputLength = Math.floor(this.length * 16000 / sampleRate), pcm = new Int16Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const from = Math.floor(i * sampleRate / 16000), to = Math.min(this.length, Math.max(from + 1, Math.floor((i + 1) * sampleRate / 16000)));
      let sum = 0; for (let j = from; j < to; j++) sum += this.samples[j];
      pcm[i] = Math.round(Math.max(-1, Math.min(1, sum / (to - from))) * 32767);
    }
    const endSample = Math.floor(endFrame * 16000 / sampleRate);
    this.port.postMessage({ pcm: pcm.buffer, startSample: endSample - outputLength, endSample }, [pcm.buffer]);
    this.length = this.above = this.silence = this.prefixLength = this.prefixEnd = 0;
  }
  process(inputs) {
    const frame = inputs[0]?.[0], count = frame?.length;
    if (!count) return true;
    let energy = 0;
    for (const sample of frame) energy += sample ** 2;
    const rms = Math.sqrt(energy / count);
    if (!this.length) {
      const onset = Math.max(0.00125, this.floor * 2.6);
      this.remember(frame);
      if (rms > onset) this.above += count;
      else { this.above = 0; this.floor += (rms - this.floor) * (rms < this.floor ? 0.04 : 0.004); }
      if (this.above >= sampleRate * 0.032) this.begin(Math.max(0.0008, onset * 0.64));
    } else {
      this.silence = rms > this.threshold ? 0 : this.silence + count;
      const written = Math.min(count, this.samples.length - this.length);
      this.samples.set(frame.subarray(0, written), this.length);
      this.length += written;
      // Prefer a natural boundary in a long utterance; always bound memory.
      if (this.length === this.samples.length || this.silence >= sampleRate * 0.76 ||
          (this.length >= sampleRate * 10 && this.silence >= sampleRate * 0.22)) this.emit(currentFrame + written);
    }
    return true;
  }
}
registerProcessor('pairo-voice-chunks', VoiceChunks);
