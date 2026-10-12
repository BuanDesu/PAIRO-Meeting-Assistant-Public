import test from 'node:test';
import assert from 'node:assert/strict';
import { DataChannelTransport } from '../src/data-channel.js';

class Channel extends EventTarget {
  readyState = 'open';
  bufferedAmount = 0;
  sent = [];
  send(data) { this.sent.push(data); this.receiver?.receive(data); }
}

test('large screenshots and UTF-8 text reassemble within the negotiated frame limit', async () => {
  const channel = new Channel();
  const messages = [], errors = [];
  const receiver = new DataChannelTransport(new Channel(), { onMessage: message => messages.push(message), onError: error => errors.push(error) });
  const sender = new DataChannelTransport(channel, { maxMessageSize: () => 96 });
  channel.receiver = receiver;
  const screenshot = { type: 'screenshot', image: 'data:image/jpeg;base64,' + 'A'.repeat(300000) };
  const text = { type: 'request', text: '会议问题😀'.repeat(40) };
  await Promise.all([sender.send(screenshot), sender.send(text)]);
  assert.deepEqual(messages, [screenshot, text]);
  assert.equal(errors.length, 0);
  assert.ok(channel.sent.every(frame => frame.byteLength <= 96));
  assert.equal(receiver.incoming.size, 0);
  sender.dispose(); receiver.dispose();
});

test('small messages retain JSON compatibility', async () => {
  const channel = new Channel();
  const transport = new DataChannelTransport(channel);
  await transport.send({ type: 'request', text: 'hello' });
  assert.equal(channel.sent[0], '{"type":"request","text":"hello"}');
  transport.dispose();
});

test('backpressure pauses sending and disconnect cancels queued work', async () => {
  const channel = new Channel();
  channel.bufferedAmount = 512 * 1024;
  const transport = new DataChannelTransport(channel);
  const first = transport.send({ type: 'request', text: 'one' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(channel.sent.length, 0);
  channel.bufferedAmount = 0;
  channel.dispatchEvent(new Event('bufferedamountlow'));
  await first;
  channel.bufferedAmount = 512 * 1024;
  const second = transport.send({ type: 'request', text: 'two' });
  await new Promise(resolve => setImmediate(resolve));
  transport.dispose();
  await assert.rejects(second, /关闭/);
  assert.equal(channel.sent.length, 1);
});

test('bounds outgoing messages and rejects primitive or oversized incoming transfers', async () => {
  const errors = [], channel = new Channel();
  const transport = new DataChannelTransport(channel, { onError: error => errors.push(error) });
  await assert.rejects(transport.send({ image: 'x'.repeat(4 * 1024 * 1024) }), /大小/);
  transport.receive('null');
  const frame = new ArrayBuffer(17), header = new DataView(frame);
  header.setUint32(0, 0x50414952); header.setUint32(8, 4 * 1024 * 1024 + 1);
  transport.receive(frame);
  assert.equal(errors.length, 2);
  assert.equal(transport.incoming.size, 0);
  transport.dispose();
});

test('incomplete incoming transfers expire without delivering partial content', async () => {
  const errors = [];
  const transport = new DataChannelTransport(new Channel(), { timeoutMs: 10, onError: error => errors.push(error) });
  const frame = new ArrayBuffer(17), header = new DataView(frame);
  header.setUint32(0, 0x50414952); header.setUint32(4, 1); header.setUint32(8, 100);
  transport.receive(frame);
  assert.equal(transport.incoming.size, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(transport.incoming.size, 0);
  assert.equal(errors.length, 1);
  transport.dispose();
});
