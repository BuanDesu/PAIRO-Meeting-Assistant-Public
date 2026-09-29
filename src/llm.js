import { Capacitor, CapacitorHttp } from '@capacitor/core';

export async function requestModel({ url, headers, body, isNative = Capacitor.isNativePlatform(), nativeHttp = CapacitorHttp, fetchImpl = globalThis.fetch }) {
  if (isNative) {
    const result = await nativeHttp.post({ url: String(url), headers, data: body, responseType: 'json' });
    return { ok: result.status >= 200 && result.status < 300, status: result.status, json: async () => result.data };
  }
  return fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

export async function askModel({ endpoint, apiKey, model, question, imageDataUrl, history = [] }) {
  if (!apiKey?.trim()) throw new Error('请先填写手机端 API Key');
  if (!endpoint?.trim()) throw new Error('请填写 Chat Completions API 地址');
  if (!model?.trim()) throw new Error('请填写模型名称');
  let url;
  try { url = new URL(endpoint.trim()); } catch { throw new Error('API 地址格式不正确'); }
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
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
  let response;
  try {
    response = await requestModel({ url, headers, body });
  } catch (error) {
    const hint = Capacitor.isNativePlatform() ? '请检查网络与 API 地址。' : '请检查网络、CORS 与 API 地址。';
    throw new Error('无法访问模型服务：' + error.message + '。' + hint);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || ('HTTP ' + response.status);
    throw new Error('模型服务返回错误：' + detail);
  }
  const answer = data?.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('模型响应中没有可显示的文本');
  return answer.trim();
}
