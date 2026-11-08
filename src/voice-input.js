import { VoiceQueue } from './voice-queue.js';

// Tracks are independently downmixed and filtered. Zero gain keeps worklets
// running without playing captured audio on the PC.
export class OfflineVoiceInput {
  constructor({ transcribe, onText, onStatus, onError }) {
    Object.assign(this, { transcribe, onText, onStatus, onError });
    this.generation = 0; this.running = false; this.sources = [];
  }
  async start(inputs) {
    const generation = ++this.generation;
    this.running = true;
    try {
      this.context = new AudioContext({ sampleRate: 16000 });
      await this.context.audioWorklet.addModule(new URL('./voice-worklet.js', import.meta.url));
      if (generation !== this.generation) return;
      this.queue = new VoiceQueue({
        transcribe: this.transcribe, onText: this.onText, onStatus: this.onStatus, onError: this.onError,
        onFull: () => {
          this.disconnectInputs();
          this.onStatus('转写积压，已暂停收听；超出容量的片段未接收，正在处理已排队内容');
        },
        onDrained: () => this.onError(new Error('积压内容已处理，语音输入已停止；可选轻量档或减少同时发言的音源后重试')),
      });
      this.silent = this.context.createGain(); this.silent.gain.value = 0;
      this.silent.connect(this.context.destination);
      this.sources = inputs.map(({ track, source: name }) => {
        const source = this.context.createMediaStreamSource(new MediaStream([track]));
        const highpass = this.context.createBiquadFilter();
        highpass.type = 'highpass'; highpass.frequency.value = 75;
        // Biquad highpass Q is expressed in dB: -3.01 dB corresponds to 1/√2.
        highpass.Q.value = -3.0103;
        const processor = new AudioWorkletNode(this.context, 'pairo-voice-chunks', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
        source.connect(highpass); highpass.connect(processor); processor.connect(this.silent);
        processor.port.onmessage = ({ data }) => {
          if (this.running && generation === this.generation) this.queue.push({ ...data, source: name });
        };
        return { source, highpass, processor };
      });
      await this.context.resume();
    } catch (error) { await this.stop(); throw error; }
  }
  disconnectInputs() {
    for (const { source, highpass, processor } of this.sources) {
      processor.port.onmessage = null;
      source.disconnect(); highpass.disconnect(); processor.disconnect();
    }
    this.sources = [];
  }
  async stop() {
    this.running = false; this.generation++;
    this.queue?.cancel();
    this.disconnectInputs(); this.silent?.disconnect();
    const context = this.context; this.context = null;
    if (context && context.state !== 'closed') await context.close();
    // The shared capture tracks belong to the meeting and must not be stopped here.
  }
}
