export const validScreenshotId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(id);

export class ScreenshotTransfers {
  constructor({ send, sendTimeoutMs = 30000, ackTimeoutMs = 10000 }) {
    this.send = send;
    this.sendTimeoutMs = sendTimeoutMs;
    this.ackTimeoutMs = ackTimeoutMs;
    this.pending = new Map();
  }

  transfer(payload, onProgress = () => {}) {
    if (this.pending.size >= 2) return Promise.reject(new Error('截图正在发送，请稍后再试'));
    const id = crypto.randomUUID(), controller = new AbortController();
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    result.catch(() => {});
    const entry = { controller, resolve, reject, onProgress, timer: null };
    this.pending.set(id, entry);
    const fail = error => { if (this.pending.get(id) === entry) this.finish(id, error); };
    entry.timer = setTimeout(() => fail(new Error('截图发送超时，请检查连接后重试')), this.sendTimeoutMs);
    onProgress({ phase: 'sending', fraction: 0 });
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return this.send({ ...payload, type: 'screenshot', id }, { signal: controller.signal,
        onProgress: fraction => { if (this.pending.get(id) === entry) onProgress({ phase: 'sending', fraction }); },
      });
    }).then(() => {
      if (this.pending.get(id) !== entry) return;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => fail(new Error('手机尚未确认收到截图，请确认两端已更新、连接正常后重试')), this.ackTimeoutMs);
      onProgress({ phase: 'waiting', fraction: 1 });
    }).catch(fail);
    return result;
  }

  acknowledge(message) {
    if (message?.type !== 'screenshot-ack' || !validScreenshotId(message.id) || !this.pending.has(message.id)) return false;
    if (message.status === 'received') this.finish(message.id);
    else if (message.status === 'rejected') this.finish(message.id, new Error('手机无法显示这张截图，请重新截图'));
    else return false;
    return true;
  }

  finish(id, error) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id); clearTimeout(entry.timer); entry.controller.abort();
    if (error) entry.reject(error);
    else { entry.onProgress({ phase: 'received', fraction: 1 }); entry.resolve(); }
  }

  cancelAll(reason = '会话已结束，截图发送已取消') {
    for (const id of [...this.pending.keys()]) this.finish(id, new Error(reason));
  }
}
