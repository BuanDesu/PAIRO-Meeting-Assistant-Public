import test from 'node:test';
import assert from 'node:assert/strict';
import { askModel, requestModel, modelHttpError } from '../src/llm.js';

test('provider errors give actionable guidance and hide the key even if echoed by the provider', () => {
  const key = 'private-test-key';
  const message = modelHttpError(401, 'Unauthorized: ' + key, key);
  assert.match(message, /Key 无效/);
  assert.ok(!message.includes(key));
  assert.match(modelHttpError(404, ''), /地址或模型名称/);
  assert.match(modelHttpError(429, ''), /额度/);
  assert.match(modelHttpError(503, ''), /暂时不可用/);
});

test('sends text and screenshot to the configured compatible API', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://llm.example/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer temporary-test-key');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'vision-model');
    assert.equal(payload.messages.at(-1).content[0].text, '请看这张图');
    assert.equal(payload.messages.at(-1).content[1].image_url.url, 'data:image/jpeg;base64,abc');
    return new Response(JSON.stringify({ choices: [{ message: { content: '建议填写选项 B。' } }] }), { status: 200 });
  };
  const answer = await askModel({
    endpoint: 'https://llm.example/v1/chat/completions',
    apiKey: 'temporary-test-key',
    model: 'vision-model',
    question: '请看这张图',
    imageDataUrl: 'data:image/jpeg;base64,abc',
  });
  assert.equal(answer, '建议填写选项 B。');
});

test('rejects a cleartext remote endpoint before sending the key', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { throw new Error('fetch should not run'); };
  await assert.rejects(
    askModel({ endpoint: 'http://llm.example/v1/chat/completions', apiKey: 'secret', model: 'm', question: 'q' }),
    /HTTPS/,
  );
});


test('uses Capacitor native HTTP on Android instead of browser fetch', async () => {
  let sent;
  const response = await requestModel({
    url: 'https://llm.example/v1/chat/completions',
    headers: { Authorization: 'Bearer temporary-test-key' },
    body: { model: 'vision-model' },
    isNative: true,
    nativeHttp: { post: async options => { sent = options; return { status: 200, data: { choices: [] } }; } },
    fetchImpl: async () => { throw new Error('browser fetch should not be used'); },
  });
  assert.equal(sent.url, 'https://llm.example/v1/chat/completions');
  assert.equal(sent.data.model, 'vision-model');
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { choices: [] });
});

test('cancels native requests even if the native provider returns late', async () => {
  const controller = new AbortController();
  let finish;
  const request = requestModel({ url: 'https://llm.example', body: {}, headers: {}, signal: controller.signal,
    isNative: true, nativeHttp: { post: () => new Promise(resolve => { finish = resolve; }) } });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  finish({ status: 200, data: {} });
});

test('times out browser requests and rejects pre-cancelled requests without sending keys', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
  await assert.rejects(askModel({ endpoint: 'https://llm.example', apiKey: 'test', model: 'm', question: 'q', timeoutMs: 10 }), /超时/);
  const controller = new AbortController(); controller.abort();
  globalThis.fetch = () => { throw new Error('must not send'); };
  await assert.rejects(askModel({ endpoint: 'https://llm.example', apiKey: 'test', model: 'm', signal: controller.signal }), { name: 'AbortError' });
});

test('reports timeout when the provider stalls after response headers', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (_url, { signal }) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  });
  await assert.rejects(askModel({ endpoint: 'https://llm.example', apiKey: 'test', model: 'm', timeoutMs: 10 }), /超时/);
});

test('model requests enable streaming and progressively report text without resending JSON-only replies', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const seen = []; let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response('data: {"choices":[{"delta":{"content":"先显示"}}]}\n\ndata: {"choices":[{"delta":{"content":"，再完成"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const params = { endpoint: 'https://llm.example', apiKey: 'test', model: 'm', onPartial: text => seen.push(text) };
  assert.equal(await askModel(params), '先显示，再完成');
  assert.deepEqual(seen, ['先显示', '先显示，再完成']);
  globalThis.fetch = async () => { calls++; return Response.json({ choices: [{ message: { content: '一次完整回答' } }] }); };
  assert.equal(await askModel(params), '一次完整回答');
  assert.equal(calls, 2);
});
