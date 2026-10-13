const MAX_BYTES = 4 * 1024 * 1024;
const MAGIC = 0x50414952;
const HEADER_BYTES = 16;
const LOW_WATER = 256 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class DataChannelTransport {
  constructor(channel, { maxMessageSize = () => 65536, onMessage = () => {}, onError = () => {}, timeoutMs = 30000 } = {}) {
    this.channel = channel;
    this.maxMessageSize = maxMessageSize;
    this.onMessage = onMessage;
    this.onError = onError;
    this.timeoutMs = timeoutMs;
    this.closed = false;
    this.controller = new AbortController();
    this.queueBytes = 0;
    this.tail = Promise.resolve();
    this.nextId = 0;
    this.incoming = new Map();
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;
  }

  send(message, { onProgress = () => {}, signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason || new Error('发送已取消'));
    if (this.closed || this.channel.readyState !== 'open') return Promise.reject(new Error('P2P 数据通道尚未就绪'));
    let text, bytes;
    try { text = JSON.stringify(message); bytes = encoder.encode(text); }
    catch (error) { return Promise.reject(error); }
    if (!bytes.length || bytes.length > MAX_BYTES) return Promise.reject(new Error('对端消息超过大小限制'));
    if (this.queueBytes + bytes.length > MAX_BYTES) return Promise.reject(new Error('发送队列繁忙，请稍后重试'));
    this.queueBytes += bytes.length;
    const operation = this.tail.catch(() => {}).then(async () => {
      this.checkOpen(signal);
      onProgress(0);
      const advertised = this.maxMessageSize();
      const limit = advertised > 0 ? advertised : 65536;
      if (bytes.length <= limit && bytes.length <= 16384) {
        await this.waitWritable(signal);
        this.channel.send(text);
        onProgress(1);
        return;
      }
      const chunkSize = Math.floor(Math.min(limit, 16384)) - HEADER_BYTES;
      if (chunkSize < 1) throw new Error('对端数据通道消息上限过小');
      const id = this.nextId = (this.nextId + 1) >>> 0;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        await this.waitWritable(signal);
        const part = bytes.subarray(offset, offset + chunkSize);
        const frame = new Uint8Array(HEADER_BYTES + part.length);
        const header = new DataView(frame.buffer);
        header.setUint32(0, MAGIC);
        header.setUint32(4, id);
        header.setUint32(8, bytes.length);
        header.setUint32(12, offset);
        frame.set(part, HEADER_BYTES);
        this.channel.send(frame.buffer);
        onProgress((offset + part.length) / bytes.length);
      }
    }).finally(() => { this.queueBytes -= bytes.length; });
    this.tail = operation;
    // Keep the internal tail handled even when a caller forgets to await send.
    operation.catch(() => {});
    return operation;
  }

  checkOpen(signal) {
    signal?.throwIfAborted();
    if (this.closed || this.channel.readyState !== 'open') throw new Error('数据通道已关闭');
  }

  async waitWritable(requestSignal) {
    this.checkOpen(requestSignal);
    if (this.channel.bufferedAmount <= LOW_WATER) return;
    await new Promise((resolve, reject) => {
      const signal = this.controller.signal;
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.channel.removeEventListener('bufferedamountlow', ready);
        this.channel.removeEventListener('close', failed);
        this.channel.removeEventListener('error', failed);
        signal.removeEventListener('abort', failed);
        requestSignal?.removeEventListener('abort', failed);
      };
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('数据通道已关闭或发送超时')); };
      this.channel.addEventListener('bufferedamountlow', ready);
      this.channel.addEventListener('close', failed);
      this.channel.addEventListener('error', failed);
      signal.addEventListener('abort', failed, { once: true });
      requestSignal?.addEventListener('abort', failed, { once: true });
      timer = setTimeout(failed, this.timeoutMs);
      if (signal.aborted || requestSignal?.aborted || this.channel.readyState !== 'open') failed();
      else if (this.channel.bufferedAmount <= LOW_WATER) ready();
    });
    this.checkOpen(requestSignal);
  }

  receive(data) {
    if (this.closed) return;
    try {
      if (typeof data === 'string') {
        if (encoder.encode(data).length > MAX_BYTES) throw new Error('已丢弃过大的对端消息');
        this.deliver(data);
        return;
      }
      const frame = data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (!frame || frame.length <= HEADER_BYTES || frame.length > 65536) throw new Error('无效的数据分块');
      const header = new DataView(frame.buffer, frame.byteOffset, HEADER_BYTES);
      const id = header.getUint32(4), total = header.getUint32(8), offset = header.getUint32(12);
      const part = frame.subarray(HEADER_BYTES);
      if (header.getUint32(0) !== MAGIC || !total || total > MAX_BYTES || offset + part.length > total) throw new Error('无效的数据分块');
      let entry = this.incoming.get(id);
      if (!entry) {
        if (offset !== 0 || this.incoming.size >= 2) throw new Error('无效的数据分块顺序');
        entry = { bytes: new Uint8Array(total), received: 0, timer: setTimeout(() => {
          this.incoming.delete(id);
          this.onError(new Error('截图接收超时，请重新发送'));
        }, this.timeoutMs) };
        this.incoming.set(id, entry);
      }
      if (entry.bytes.length !== total || entry.received !== offset) {
        clearTimeout(entry.timer);
        this.incoming.delete(id);
        throw new Error('无效的数据分块顺序');
      }
      entry.bytes.set(part, offset);
      entry.received += part.length;
      if (entry.received === total) {
        clearTimeout(entry.timer);
        this.incoming.delete(id);
        this.deliver(decoder.decode(entry.bytes));
      }
    } catch (error) { this.onError(error); }
  }

  deliver(text) {
    const message = JSON.parse(text);
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('收到无法识别的对端消息');
    Promise.resolve(this.onMessage(message)).catch(this.onError);
  }

  dispose() {
    this.closed = true;
    this.controller.abort();
    for (const entry of this.incoming.values()) clearTimeout(entry.timer);
    this.incoming.clear();
  }
}
