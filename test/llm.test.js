import test from 'node:test';
import assert from 'node:assert/strict';
import { askModel, requestModel } from '../src/llm.js';

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
