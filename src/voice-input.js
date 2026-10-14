// No speaker connection: the zero-gain worklet output only keeps processing alive.
// Each source is independently downmixed by Web Audio before being mixed together.
export class OfflineVoiceInput {
  constructor({ transcribe, onText, onStatus, onError }) {
    Object.assign(this, { transcribe, onText, onStatus, onError });
    this.generation = 0; this.running = false; this.pending = 0; this.queue = Promise.resolve();
  }
  async start(tracks) {
    const generation = ++this.generation;
    this.running = true;
    try {
      this.context = new AudioContext({ sampleRate: 16000 });
      await this.context.audioWorklet.addModule(new URL('./voice-worklet.js', import.meta.url));
      if (generation !== this.generation) return;
      this.processor = new AudioWorkletNode(this.context, 'pairo-voice-chunks', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      const mixer = this.context.createGain(); mixer.gain.value = 1 / Math.max(1, tracks.length);
      this.sources = tracks.map(track => {
        const source = this.context.createMediaStreamSource(new MediaStream([track]));
        source.connect(mixer); return source;
      });
      mixer.connect(this.processor);
      this.silent = this.context.createGain(); this.silent.gain.value = 0;
      this.processor.connect(this.silent); this.silent.connect(this.context.destination);
      this.processor.port.onmessage = ({ data }) => {
        if (!this.running || generation !== this.generation) return;
        // A bounded queue prevents stale speech accumulating when inference is slower than capture.
        if (this.pending >= 3) { this.onError(new Error('离线转写跟不上音频速度，已停止；请减少其他电脑负载后重试')); return; }
        this.pending += 1;
        this.queue = this.queue.then(async () => {
          if (!this.running || generation !== this.generation) return;
          this.onStatus('本机正在转写…');
          const text = await this.transcribe(data);
          if (this.running && generation === this.generation && text?.trim()) this.onText(text.trim());
        }).catch(error => { if (generation === this.generation) this.onError(error); })
          .finally(() => { this.pending -= 1; });
      };
      await this.context.resume();
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    this.running = false; this.generation += 1;
    if (this.processor) { this.processor.port.onmessage = null; this.processor.disconnect(); }
    this.sources?.forEach(source => source.disconnect()); this.silent?.disconnect();
    const context = this.context; this.context = null;
    if (context && context.state !== 'closed') await context.close();
    // The shared capture tracks belong to the meeting and must not be stopped here.
  }
}
