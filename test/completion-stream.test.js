import test from 'node:test';
import assert from 'node:assert/strict';
import { CompletionStream, readCompletionStream } from '../src/completion-stream.js';
const delta = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;

test('streaming displays Chinese text before completion across split UTF-8 and CRLF boundaries', async () => {
  const encoder = new TextEncoder(), chunks = [], seen = [];
  const bytes = encoder.encode(': heartbeat\r\n\r\n' + delta('你好') + delta('，请看截图') + 'data: [DONE]\r\n\r\n');
  for (let index = 0; index < bytes.length; index += 1) chunks.push(bytes.slice(index, index + 1));
  const body = new ReadableStream({ pull(controller) { chunks.length ? controller.enqueue(chunks.shift()) : controller.close(); } });
  const answer = await readCompletionStream(new Response(body), { onText: text => seen.push(text) });
  assert.deepEqual(seen, ['你好', '你好，请看截图']);
  assert.equal(answer, '你好，请看截图');
});

test('truncated or provider-rejected streams are not promoted to completed answers', () => {
  const partial = new CompletionStream(); partial.push(delta('未完成'));
  assert.throws(() => partial.finish(), /传输中断/);
  const limited = new CompletionStream();
  assert.throws(() => limited.push('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'), /长度限制/);
  const error = new CompletionStream(() => {}, () => '安全的服务错误');
  assert.throws(() => error.push('data: {"error":{"message":"secret"}}\n\n'), /安全的服务错误/);
  const stopped = new CompletionStream(); stopped.push(delta('完成') + 'data: {"choices":[{"finish_reason":"stop"}]}\n\n');
  assert.equal(stopped.finish(), '完成');
});

test('cancelled streaming cancels the reader and ignores later text', async () => {
  let push, cancelled = false;
  const body = new ReadableStream({ start(controller) { push = controller; }, cancel() { cancelled = true; } });
  const controller = new AbortController(), seen = [];
  const request = readCompletionStream(new Response(body), { signal: controller.signal, onText: text => seen.push(text) });
  push.enqueue(new TextEncoder().encode(delta('开始')));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.deepEqual(seen, ['开始']);
});

test('malformed and unbounded streams fail instead of growing without limit', () => {
  const oversized = new CompletionStream();
  assert.throws(() => oversized.push('x'.repeat(262145)), /过大/);
  const invalid = new CompletionStream();
  assert.throws(() => invalid.push('data: invalid\n\n'), /无法识别/);
});
