import { registerPlugin } from '@capacitor/core';
import { CompletionStream } from './completion-stream.js';

const ModelStream = registerPlugin('ModelStream');

export async function readNativeCompletion({ url, apiKey, body, signal, onText, httpError, responseText, plugin = ModelStream }) {
  signal?.throwIfAborted();
  const id = crypto.randomUUID();
  let settled = false, status = 0, streaming = false, text = '', resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A native event can arrive while start() is still awaiting its acknowledgement.
  result.catch(() => {});
  const settle = (error, answer) => {
    if (settled) return;
    settled = true;
    error ? reject(error) : resolve(answer);
  };
  const parser = new CompletionStream(onText, detail => httpError(502, detail, apiKey));
  const handleEvent = event => {
    if (event.id !== id || settled || signal?.aborted) return;
    try {
      if (event.type === 'headers') { status = event.status; streaming = /text\/event-stream/i.test(event.contentType || '') && status >= 200 && status < 300; }
      if (event.type === 'chunk') {
        if (streaming) {
          parser.push(event.text);
          if (parser.done) settle(null, parser.finish());
        } else {
          text += event.text;
          if (text.length > 262144) throw new Error('模型响应过大，请缩小问题范围');
        }
      }
      if (event.type === 'end') {
        if (streaming) { settle(null, parser.finish()); return; }
        let data;
        try { data = JSON.parse(text); } catch { data = {}; }
        if (status < 200 || status >= 300) throw new Error(httpError(status, data?.error?.message || data?.message || '', apiKey));
        const answer = responseText(data);
        onText?.(answer);
        settle(null, answer);
      }
      if (event.type === 'error') throw new Error(httpError(502, event.message, apiKey));
    } catch (error) { settle(error); }
  };
  const abort = () => settle(signal.reason || new DOMException('请求已取消', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  let listener, registration;
  try {
    if (signal?.aborted) abort();
    if (!settled) {
      registration = plugin.addListener('stream', handleEvent);
      listener = await Promise.race([registration, result]);
    }
    if (!settled) {
      // No automatic resend/fallback: retrying a received request can incur another charge.
      void plugin.start({ id, url: String(url), apiKey, body: JSON.stringify(body) }).catch(error => settle(new Error(httpError(502, error.message, apiKey))));
    }
    return await result;
  } finally {
    settled = true;
    signal?.removeEventListener('abort', abort);
    if (!listener && registration) {
      // An aborted registration may acknowledge later; release that listener too.
      void registration.then(handle => handle.remove()).catch(() => {});
    }
    await Promise.allSettled([listener?.remove(), plugin.cancel({ id })]);
  }
}
