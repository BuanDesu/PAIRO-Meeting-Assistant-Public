// Shared by browser fetch and the Android native transport. No credentials here.
export class CompletionStream {
  constructor(onText = () => {}, errorMessage = () => '模型流式请求失败') {
    this.onText = onText;
    this.errorMessage = errorMessage;
    this.buffer = '';
    this.data = [];
    this.eventSize = 0;
    this.text = '';
    this.done = false;
    this.terminal = false;
  }

  push(chunk) {
    if (this.done) return;
    this.buffer += chunk;
    if (this.buffer.length > 262144) throw new Error('模型响应片段过大，请换用兼容的服务');
    while (!this.done) {
      const index = this.buffer.search(/[\r\n]/);
      if (index < 0 || (this.buffer[index] === '\r' && index === this.buffer.length - 1)) break;
      const length = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + length);
      this.line(line);
    }
  }

  line(line) {
    if (!line) { this.event(); return; }
    if (!line.startsWith('data:')) return;
    const value = line.slice(5).replace(/^ /, '');
    this.eventSize += value.length;
    if (this.eventSize > 131072) throw new Error('模型响应事件过大');
    this.data.push(value);
  }

  event() {
    if (!this.data.length) return;
    const value = this.data.join('\n');
    this.data = []; this.eventSize = 0;
    if (value.trim() === '[DONE]') { this.done = true; return; }
    let event;
    try { event = JSON.parse(value); } catch { throw new Error('模型返回了无法识别的流式数据'); }
    if (event?.error) throw new Error(this.errorMessage(event.error.message));
    const choice = event?.choices?.[0];
    const content = choice?.delta?.content;
    const delta = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('') : '';
    if (delta) {
      if (this.text.length + delta.length > 100000) throw new Error('回答过长，请缩小问题范围后重试');
      this.text += delta;
      this.onText(this.text);
    }
    if (choice?.finish_reason === 'length') throw new Error('回答达到模型长度限制，尚未完成；请缩小问题范围后重试');
    if (choice?.finish_reason === 'content_filter') throw new Error('服务商限制了这次回答，请调整问题后重试');
    if (choice?.finish_reason === 'stop') this.terminal = true;
  }

  finish() {
    if (!this.done) {
      if (this.buffer) this.line(this.buffer.replace(/\r$/, ''));
      this.buffer = '';
      this.event();
    }
    if (!this.done && !this.terminal) throw new Error('回答传输中断，尚未完成；请重试');
    if (!this.text.trim()) throw new Error('模型响应中没有可显示的文本');
    return this.text.trim();
  }
}

export async function readCompletionStream(response, { signal, onText, errorMessage } = {}) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('此服务无法提供流式响应');
  const parser = new CompletionStream(onText, errorMessage);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (!parser.done) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) { parser.push(decoder.decode()); break; }
      parser.push(decoder.decode(value, { stream: true }));
    }
    return parser.finish();
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
