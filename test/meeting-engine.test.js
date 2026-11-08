import test from 'node:test';
import assert from 'node:assert/strict';
import { MeetingEngine } from '../src/meeting-engine.js';
import { askModel } from '../src/llm.js';
const tick = () => new Promise(r => setImmediate(r));
const engine = ask => new MeetingEngine({ ask, configuration: () => ({ apiKey: 'fixture', model: 'm', endpoint: 'https://fixture.test' }) });
test('PC serializes requests with completed history and only the newest complete answer is typable', async () => {
  const calls = [], finish = [];
  const e = engine(args => { calls.push({ ...args, history: [...args.history] }); return new Promise(r => finish.push(r)); });
  const first = e.submit('first'), second = e.submit('second'); await tick();
  assert.equal(calls.length, 1); calls[0].onPartial('partial');
  assert.equal(e.lastAnswer, ''); assert.equal(e.history.length, 0);
  finish[0]('one'); await first; await tick();
  assert.equal(e.lastAnswer, ''); assert.equal(calls[1].history.length, 2);
  finish[1]('two'); await second; assert.equal(e.lastAnswer, 'two');
  assert.equal(e.pending, 0);
  e.configuration = () => ({ apiKey: '' });
  assert.throws(() => e.submit('new question without key'), /API Key/);
  assert.equal(e.lastAnswer, '');
});
test('cancel, clear, late responses, failure and queue limits never expose an old complete answer', async () => {
  let finish, args;
  const e = engine(a => { args = a; return new Promise(r => finish = r); });
  const first = e.submit('old'); await tick(); args.onPartial('unfinished');
  e.cancel(); assert.equal(args.signal.aborted, true); assert.equal(e.entries[0].status, 'cancelled');
  finish('late'); await first; assert.equal(e.lastAnswer, ''); assert.equal(e.history.length, 0);
  const session = e.session; e.clear(); assert.notEqual(e.session, session); assert.equal(e.entries.length, 0);
  e.ask = async () => { throw new Error('fixture unavailable'); };
  await e.submit('failed'); assert.equal(e.retry.question, 'failed'); assert.equal(e.lastAnswer, '');
  e.configuration = () => ({ apiKey: 'corrected-key', model: 'corrected-model' });
  e.ask = async args => { assert.equal(args.apiKey, 'corrected-key'); assert.equal(args.model, 'corrected-model'); return 'retried complete answer'; };
  await e.submit(e.retry.question, e.retry.image);
  assert.equal(e.retry, null); assert.equal(e.lastAnswer, 'retried complete answer');
  e.ask = () => new Promise(() => {});
  for (let i = 0; i < 8; i++) void e.submit('queued');
  assert.throws(() => e.submit('overflow'), /过多/); e.cancel();
});
test('an older failed request does not offer its retry after a newer queued answer succeeds', async () => {
  const e = engine(async ({ question }) => {
    if (question === 'older') throw new Error('timed out');
    return 'latest complete';
  });
  await Promise.all([e.submit('older'), e.submit('latest')]);
  assert.equal(e.entries[0].status, 'failed');
  assert.equal(e.lastAnswer, 'latest complete'); assert.equal(e.retry, null);
});
test('stalled SSE marks a partial answer as failed and manual retry produces a complete answer', async () => {
  let calls = 0, cancelled = false;
  const fetchImpl = async () => {
    const attempt = ++calls;
    return new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"${attempt === 1 ? 'partial' : 'complete'}"}}]}\n\n`));
        if (attempt === 2) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
      },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const e = engine(args => askModel({ ...args, fetchImpl, timeoutMs: 80 }));
  await e.submit('same question');
  assert.equal(e.entries[0].status, 'failed'); assert.equal(e.entries[0].text, 'partial');
  assert.match(e.entries[0].error, /超时/); assert.equal(e.lastAnswer, ''); assert.equal(cancelled, true);
  await e.submit(e.retry.question, e.retry.image);
  assert.equal(e.entries.at(-1).status, 'complete'); assert.equal(e.lastAnswer, 'complete'); assert.equal(calls, 2);
});
