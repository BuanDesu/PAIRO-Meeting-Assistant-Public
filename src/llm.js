import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { readCompletionStream } from './completion-stream.js';
import { readNativeCompletion } from './native-model-stream.js';

export function modelResponseText(data) {
  const content = data?.choices?.[0]?.message?.content;
  const answer = Array.isArray(content) ? content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('模型响应中没有可显示的文本');
  return answer.trim();
}

export function modelHttpError(status, detail, secret = '') {
  const hints = {
    301: 'API 地址发生跳转，请填写服务商提供的最终请求地址',
    302: 'API 地址发生跳转，请填写服务商提供的最终请求地址',
    307: 'API 地址发生跳转，请填写服务商提供的最终请求地址',
    308: 'API 地址发生跳转，请填写服务商提供的最终请求地址',
    400: '问题格式或模型能力不匹配；分析截图时请使用支持图片的模型',
    401: 'API Key 无效或已失效，请重新填写',
    403: '账号没有此服务或模型的使用权限',
    404: 'API 地址或模型名称不存在，请核对服务商给出的完整地址与名称',
    413: '截图或问题过大，请缩小截图后重试',
    429: '调用过于频繁或账号额度不足，请检查额度后稍后重试',
  };
  const hint = hints[status] || (status >= 500 ? '模型服务暂时不可用，请稍后重试' : '模型服务拒绝了请求');
  let safeDetail = typeof detail === 'string' ? detail : '';
  if (secret) safeDetail = safeDetail.split(secret).join('[已隐藏]');
  return `${hint}（HTTP ${status}）${safeDetail ? '：' + safeDetail.slice(0, 500) : ''}`;
}

function abortable(operation, signal) {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('请求已取消', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export async function requestModel({ url, headers, body, signal, isNative = Capacitor.isNativePlatform(), nativeHttp = CapacitorHttp, fetchImpl = globalThis.fetch }) {
  signal?.throwIfAborted();
  if (isNative) {
    const result = await abortable(nativeHttp.post({ url: String(url), headers, data: body, responseType: 'json', connectTimeout: 10000, readTimeout: 60000 }), signal);
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.data };
  }
  return fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
}

export async function askModel({ endpoint, apiKey, model, question, imageDataUrl, history = [], signal, timeoutMs = 60000, onPartial }) {
  if (!apiKey?.trim()) throw new Error('请先填写手机端 API Key');
  if (!endpoint?.trim()) throw new Error('请填写 Chat Completions API 地址');
  if (!model?.trim()) throw new Error('请填写模型名称');
  let url;
  try { url = new URL(endpoint.trim()); } catch { throw new Error('API 地址格式不正确'); }
  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password) throw new Error('API 地址不能包含登录信息，请单独填写 API Key');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) throw new Error('API 地址必须使用 HTTPS（仅本机 localhost 可使用 HTTP）');
  const userContent = [{ type: 'text', text: question || '请分析当前共享内容，并给出简洁、准确的建议。' }];
  if (imageDataUrl) userContent.push({ type: 'image_url', image_url: { url: imageDataUrl } });
  const messages = [
    { role: 'system', content: '你是用户的会议与问卷助手。先给直接可用的简短答复；若信息不足，明确说明假设，不要编造。' },
    ...history.slice(-8),
    { role: 'user', content: userContent },
  ];
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey.trim() };
  const body = { model: model.trim(), messages, temperature: 0.3 };
  if (onPartial) body.stream = true;
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (onPartial && Capacitor.getPlatform() === 'android') {
      try {
        return await readNativeCompletion({ url, apiKey: apiKey.trim(), body, signal: controller.signal, onText: onPartial, httpError: modelHttpError, responseText: modelResponseText });
      } catch (error) {
        if (timedOut) throw new Error('模型请求超时，请稍后重试');
        throw error;
      }
    }
    let response;
    try {
      response = await requestModel({ url, headers, body, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        if (timedOut) throw new Error('模型请求超时，请稍后重试');
        throw error;
      }
      const hint = Capacitor.isNativePlatform() ? '请检查网络与 API 地址。' : '请检查网络、CORS 与 API 地址。';
      throw new Error('无法访问模型服务：' + error.message + '。' + hint);
    }
    if (response.ok && onPartial && /text\/event-stream/i.test(response.headers?.get('content-type') || '')) {
      try {
        return await readCompletionStream(response, { signal: controller.signal, onText: onPartial, errorMessage: detail => modelHttpError(502, detail, apiKey.trim()) });
      } catch (error) {
        if (timedOut) throw new Error('模型请求超时，请稍后重试');
        throw error;
      }
    }
    const data = await response.json().catch(() => ({}));
    if (controller.signal.aborted) {
      if (timedOut) throw new Error('模型请求超时，请稍后重试');
      controller.signal.throwIfAborted();
    }
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || ('HTTP ' + response.status);
      throw new Error(modelHttpError(response.status, detail, apiKey.trim()));
    }
    const answer = modelResponseText(data);
    onPartial?.(answer);
    return answer;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
