// The PC owns generation. The phone receives only bounded, authoritative reading state.
export const MAX_ANSWER = 24000;
export class MeetingEngine {
  constructor({ ask, configuration, retrieve = async () => null, onChange = () => {}, id = () => crypto.randomUUID() }) {
    Object.assign(this, { ask, configuration, retrieve, onChange, id });
    this.generation = 0; this.entries = []; this.history = []; this.controllers = new Set();
    this.pending = 0; this.tail = Promise.resolve(); this.lastAnswer = ''; this.retry = null; this.knowledgeAnchor = '';
    this.session = id();
  }
  changed() { this.onChange(this.snapshot()); }
  snapshot() {
    return { session: this.session, entries: this.entries.map(({ id, question, text, status, error, sources }) => ({ id, question, text, status, error, sources })) };
  }
  cancel() {
    this.generation++; this.lastAnswer = ''; this.knowledgeAnchor = '';
    for (const c of this.controllers) c.abort();
    this.controllers.clear(); this.pending = 0; this.tail = Promise.resolve();
    for (const entry of this.entries) if (['queued', 'generating'].includes(entry.status)) { entry.status = 'cancelled'; entry.error = '已取消，以下内容尚未完成'; }
    this.changed();
  }
  clear() {
    this.cancel(); this.entries = []; this.history = []; this.retry = null; this.session = this.id(); this.changed();
  }
  submit(question, image = '') {
    this.lastAnswer = ''; this.changed();
    const config = this.configuration();
    if (!config.apiKey?.trim()) throw new Error('请先在电脑填写 API Key。Key 仅留在本次运行的内存中。');
    if (this.pending >= 8) throw new Error('等待的问题过多，请稍后再试');
    question = String(question || '').trim().slice(0, 12000) || '请回答图中的问题。';
    const entry = { id: this.id(), question, text: '', status: 'queued', error: '', sources: [] };
    this.lastAnswer = ''; this.retry = null; this.entries.push(entry);
    // Trim completed reading history on enqueue. Eight entries also impose a hard 288k text bound.
    while (this.entries.length > 8 || this.entries.reduce((n, e) => n + e.question.length + e.text.length, 0) > 72000) {
      if (['queued', 'generating'].includes(this.entries[0].status)) break;
      this.entries.shift();
    }
    const generation = this.generation, controller = new AbortController();
    const current = () => generation === this.generation && !controller.signal.aborted;
    this.controllers.add(controller); this.pending++; this.changed();
    const job = this.tail.catch(() => {}).then(async () => {
      if (!current()) return;
      entry.status = 'generating'; this.changed();
      try {
        const previousQuestion = this.knowledgeAnchor;
        this.knowledgeAnchor = '';
        const knowledge = await this.retrieve(question, previousQuestion, controller.signal);
        if (!current()) return;
        entry.sources = knowledge?.sources || [];
        const answer = await this.ask({ ...config, question, imageDataUrl: image, history: this.history,
          knowledgeContext: knowledge?.context || '', signal: controller.signal,
          onPartial: text => {
            if (!current()) return;
            if (text.length > MAX_ANSWER) { controller.abort(); throw new Error('回答过长，请缩小问题后重试'); }
            entry.text = text; this.changed();
          } });
        if (!current()) return;
        if (!answer?.trim() || answer.length > MAX_ANSWER) throw new Error('没有可用的完整回答，请缩小问题后重试');
        entry.text = answer; entry.status = 'complete';
        if (knowledge?.route === 'knowledge') this.knowledgeAnchor = knowledge.inherited ? previousQuestion : question;
        this.history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
        this.history = this.history.slice(-8);
        // An older queued success cannot become the current typable answer.
        if (this.entries.at(-1) === entry) this.lastAnswer = answer;
      } catch (error) {
        if (generation !== this.generation) return;
        entry.status = 'failed'; entry.error = String(error.message || '回答未完成，请重试').slice(0, 1000);
        this.lastAnswer = '';
        // A failure behind a newer question must not leave a stale retry button.
        if (this.entries.at(-1) === entry) this.retry = { question, image };
      } finally {
        this.controllers.delete(controller);
        if (generation === this.generation) { this.pending--; this.changed(); }
      }
    });
    this.tail = job; return job;
  }
}
