import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenshotTransfers } from '../src/screenshot-transfer.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

test('sending all bytes is not reported as received until the matching phone acknowledgment', async () => {
  let sent, options;
  const progress = [];
  const transfers = new ScreenshotTransfers({ send: async (message, opts) => { sent = message; options = opts; opts.onProgress(1); } });
  let completed = false;
  const result = transfers.transfer({ image: 'data:image/jpeg;base64,TEST' }, value => progress.push(value)).then(() => { completed = true; });
  await tick();
  assert.equal(completed, false);
  assert.equal(progress.at(-1).phase, 'waiting');
  assert.equal(transfers.acknowledge({ type: 'screenshot-ack', id: 'other', status: 'received' }), false);
  assert.equal(completed, false);
  transfers.acknowledge({ type: 'screenshot-ack', id: sent.id, status: 'received' });
  await result;
  assert.equal(progress.at(-1).phase, 'received');
  assert.equal(options.signal.aborted, true);
  assert.equal(transfers.pending.size, 0);
});

test('early acknowledgment is retained and failure, timeout, and leaving clear pending work', async () => {
  let transfers;
  transfers = new ScreenshotTransfers({ send: async message => { transfers.acknowledge({ type: 'screenshot-ack', id: message.id, status: 'received' }); } });
  await transfers.transfer({ image: 'test' });
  assert.equal(transfers.pending.size, 0);
  const timeout = new ScreenshotTransfers({ send: async () => {}, ackTimeoutMs: 10 });
  await assert.rejects(timeout.transfer({ image: 'test' }), /尚未确认/);
  assert.equal(timeout.pending.size, 0);
  const failure = new ScreenshotTransfers({ send: async () => { throw new Error('channel lost'); } });
  await assert.rejects(failure.transfer({ image: 'test' }), /channel lost/);
  const cancelled = new ScreenshotTransfers({ send: () => new Promise(() => {}), sendTimeoutMs: 10 });
  await assert.rejects(cancelled.transfer({ image: 'test' }), /发送超时/);
  const leaving = new ScreenshotTransfers({ send: () => new Promise(() => {}) });
  const request = leaving.transfer({ image: 'private' });
  const signal = [...leaving.pending.values()][0].controller.signal;
  leaving.cancelAll();
  await assert.rejects(request, /会话已结束/);
  assert.equal(signal.aborted, true);
  assert.equal(leaving.pending.size, 0);
});
