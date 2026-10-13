import test from 'node:test';
import assert from 'node:assert/strict';
import { readNativeCompletion } from '../src/native-model-stream.js';
import { modelHttpError, modelResponseText } from '../src/llm.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(start) {
  let listener;
  const events = { removed: 0, cancelled: [], starts: [] };
  const plugin = {
    addListener: async (name, handler) => { assert.equal(name, 'stream'); listener = handler; return { remove: async () => events.removed++ }; },
    start: async args => { events.starts.push(args); await start?.(args, event => listener({ id: args.id, ...event })); },
    cancel: async args => { events.cancelled.push(args.id); },
  };
  return { plugin, events, emit: event => listener(event) };
}
const params = { url: 'https://api.example/chat', apiKey: 'private-key', body: { stream: true }, httpError: modelHttpError, responseText: modelResponseText };

test('native events deliver partial answers and close the listener and connection at DONE', async () => {
  const seen = [];
  const fx = fixture(async (_args, emit) => {
    emit({ type: 'headers', status: 200, contentType: 'text/event-stream' });
    emit({ type: 'chunk', text: 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n' });
    assert.deepEqual(seen, ['你好']);
    emit({ type: 'chunk', text: 'data: [DONE]\n\n' });
  });
  assert.equal(await readNativeCompletion({ ...params, plugin: fx.plugin, onText: text => seen.push(text) }), '你好');
  assert.equal(fx.events.removed, 1);
  assert.deepEqual(fx.events.cancelled, [fx.events.starts[0].id]);
});

test('native cancellation filters other requests and never shows cancelled late events', async () => {
  const fx = fixture(), seen = [], controller = new AbortController();
  const request = readNativeCompletion({ ...params, plugin: fx.plugin, signal: controller.signal, onText: text => seen.push(text) });
  await tick();
  fx.emit({ id: 'another-request', type: 'chunk', text: 'not this request' });
  controller.abort(); await assert.rejects(request, { name: 'AbortError' });
  fx.emit({ id: fx.events.starts[0].id, type: 'chunk', text: 'late' });
  assert.deepEqual(seen, []);
  assert.equal(fx.events.removed, 1);
  assert.equal(fx.events.cancelled.length, 1);
});

test('native JSON-compatible servers complete once and errors redact the key without resending', async () => {
  const fx = fixture(async (_args, emit) => {
    emit({ type: 'headers', status: 200, contentType: 'application/json' });
    emit({ type: 'chunk', text: '{"choices":[{"message":{"content":"普通回答"}}]}' });
    emit({ type: 'end' });
  });
  assert.equal(await readNativeCompletion({ ...params, plugin: fx.plugin }), '普通回答');
  const bad = fixture(async (_args, emit) => {
    emit({ type: 'headers', status: 401, contentType: 'application/json' });
    emit({ type: 'chunk', text: '{"error":{"message":"private-key invalid"}}' });
    emit({ type: 'end' });
  });
  await assert.rejects(readNativeCompletion({ ...params, plugin: bad.plugin }), error => /Key 无效/.test(error.message) && !error.message.includes('private-key'));
  assert.equal(bad.events.starts.length, 1);
  assert.equal(bad.events.removed, 1);
});

test('cancelling during listener registration never starts a request and releases a late listener', async () => {
  let registered, removed = 0, started = 0;
  const controller = new AbortController();
  const plugin = {
    addListener: () => new Promise(resolve => { registered = resolve; }),
    start: async () => { started++; }, cancel: async () => {},
  };
  const request = readNativeCompletion({ ...params, plugin, signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  registered({ remove: async () => { removed++; } });
  await tick();
  assert.equal(started, 0);
  assert.equal(removed, 1);
});
