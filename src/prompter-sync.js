const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(value);
const statuses = new Set(['queued', 'generating', 'complete', 'failed', 'cancelled']);
export function validSnapshot(value) {
  return value && validId(value.session) && Array.isArray(value.entries) && value.entries.length <= 8
    && new Set(value.entries.map(e => e?.id)).size === value.entries.length
    && value.entries.every(e => e && validId(e.id) && statuses.has(e.status)
      && typeof e.question === 'string' && e.question.length <= 12000
      && typeof e.text === 'string' && e.text.length <= 24000
      && typeof e.error === 'string' && e.error.length <= 1000
      && Array.isArray(e.sources) && e.sources.length <= 6 && e.sources.every(s => typeof s === 'string' && s.length <= 250));
}
// Coalesce cumulative snapshots: at most one send in flight and one pending state.
// DataChannelTransport supplies ordered chunks, queue limits and bufferedAmount backpressure.
export class PrompterPublisher {
  constructor({ send, snapshot, delay = 70, onDelivery = () => {} }) {
    Object.assign(this, { send, snapshot, delay, onDelivery }); this.revision = 0; this.nonce = ''; this.dirty = false;
  }
  ready(message) {
    if (message.type !== 'prompter-ready' || !validId(message.nonce)) return;
    if (message.nonce !== this.nonce) this.clearDelivery();
    this.nonce = message.nonce; this.changed();
    this.onDelivery();
  }
  clearDelivery() { this.sent = null; this.failed = false; }
  disconnected() {
    this.nonce = ''; clearTimeout(this.timer); this.timer = null;
    this.clearDelivery(); this.onDelivery();
  }
  delivery(session, entryId) {
    if (this.failed) return 'failed';
    return this.sent?.session === session && this.sent.entryId === entryId ? 'sent' : 'pending';
  }
  changed() {
    this.dirty = true;
    if (!this.nonce || this.sending || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.delay);
  }
  async flush() {
    if (!this.nonce || this.sending || !this.dirty) return;
    const nonce = this.nonce; this.dirty = false; this.sending = true;
    const snapshot = this.snapshot();
    try {
      await this.send({ type: 'prompter-state', nonce, revision: ++this.revision, ...snapshot });
      // RTCDataChannel.send queues the bytes locally. There is no phone ACK.
      if (nonce === this.nonce) {
        const latest = snapshot.entries.at(-1);
        this.sent = latest?.status === 'complete' ? { session: snapshot.session, entryId: latest.id } : null;
        this.onDelivery();
      }
    } catch {
      if (nonce === this.nonce) {
        this.nonce = ''; this.sent = null; this.failed = true; this.onDelivery();
      }
    }
    finally { this.sending = false; if (this.dirty) this.changed(); }
  }
}
export class PrompterReceiver {
  constructor({ render, id = () => crypto.randomUUID() }) { this.render = render; this.id = id; this.nonce = ''; this.revision = -1; }
  connect() { this.nonce = this.id(); this.revision = -1; return { type: 'prompter-ready', nonce: this.nonce }; }
  disconnect() { this.nonce = ''; }
  receive(message) {
    if (message.type !== 'prompter-state' || !this.nonce || message.nonce !== this.nonce
      || !Number.isSafeInteger(message.revision) || message.revision <= this.revision || !validSnapshot(message)) return false;
    this.revision = message.revision; this.render(message); return true;
  }
}
