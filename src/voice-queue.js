const label = source => source === 'microphone' ? '麦克风' : '系统声音';
const normalizedText = text => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

// Require a matching transcript and a quieter microphone waveform that is
// almost an exact delayed copy. Uncertain acoustic echoes remain with AEC.
export function mirroredAudio(first, second) {
  if (first.source === second.source) return false;
  const mic = first.source === 'microphone' ? first : second;
  const system = first.source === 'system' ? first : second;
  const a = new Int16Array(mic.pcm), b = new Int16Array(system.pcm);
  const offset = mic.startSample - system.startSample;
  if (mic.endSample < system.startSample - 4000 || system.endSample < mic.startSample - 4000) return false;
  function correlation(lag, stride) {
    const from = Math.max(0, -offset - lag), to = Math.min(a.length, b.length - offset - lag);
    if (to - from < 10400 || to - from < a.length * 0.85) return 0;
    let aa = 0, bb = 0, ab = 0, audible = 0;
    for (let i = from; i < to; i += stride) {
      const x = a[i], y = b[i + offset + lag];
      aa += x * x; bb += y * y; ab += x * y;
      if (Math.abs(x) > 32 && Math.abs(y) > 32) audible++;
    }
    return audible * stride >= 5600 && aa < bb * 0.64 ? Math.abs(ab) / Math.sqrt(aa * bb) : 0;
  }
  const stride = Math.max(32, Math.floor(a.length / 512));
  for (let lag = -4000; lag <= 4000; lag++) {
    if (correlation(lag, stride) >= 0.98 && correlation(lag, 8) >= 0.98) return true;
  }
  return false;
}

export class VoiceQueue {
  constructor({ transcribe, onText, onStatus, onError, onFull, onDrained }) {
    Object.assign(this, { transcribe, onText, onStatus, onError, onFull, onDrained });
    this.waiting = []; this.active = false; this.closed = false; this.full = false;
    this.previousSource = ''; this.recent = [];
  }
  push(chunk) {
    if (this.closed || this.full) return false;
    if (this.waiting.length + Number(this.active) >= 3) {
      this.full = true;
      this.onFull();
      return false;
    }
    this.waiting.push(chunk);
    void this.drain();
    return true;
  }
  status(message) { this.onStatus(this.full ? `收听已暂停，正在处理积压：${message}` : message); }
  async drain() {
    if (this.active || this.closed) return;
    this.active = true;
    try {
      while (!this.closed && this.waiting.length) {
        // Keep FIFO within each track and rotate when both sources are ready.
        let index = this.waiting.findIndex(chunk => chunk.source !== this.previousSource);
        if (index < 0) index = 0;
        const chunk = this.waiting.splice(index, 1)[0];
        this.previousSource = chunk.source;
        this.status(`${label(chunk.source)}正在本机转写…`);
        const result = await this.transcribe(chunk.pcm, chunk.source);
        if (this.closed) return;
        if (result.text) {
          const text = normalizedText(result.text);
          const duplicate = this.recent.some(previous => previous.text === text && mirroredAudio(previous, chunk));
          if (!duplicate) {
            this.onText(result.text, { source: chunk.source, startSample: chunk.startSample, endSample: chunk.endSample });
            this.recent = this.recent.filter(previous => previous.source !== chunk.source);
            this.recent.push({ ...chunk, text });
          }
          this.status(duplicate ? '已合并同时收录的相同声音' : `${label(chunk.source)}转写已提交`);
        } else if (result.reason !== 'cancelled') {
          this.status(result.reason === 'silence' ? `${label(chunk.source)}未检测到人声` : `${label(chunk.source)}本段转写不够清楚，未自动提问`);
        }
      }
    } catch (error) {
      if (!this.closed) { this.cancel(); this.onError(error); }
    } finally {
      this.active = false;
      if (this.full && !this.closed) { this.closed = true; this.recent = []; this.onDrained(); }
    }
  }
  cancel() { this.closed = true; this.waiting = []; this.recent = []; }
}
