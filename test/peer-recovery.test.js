import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createSignalingServer } from '../server/signaling.js';
import { PeerSession } from '../src/peer-session.js';

async function until(predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Recovery did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(t) {
  const originals = { WebSocket: globalThis.WebSocket, MediaStream: globalThis.MediaStream, window: globalThis.window };
  globalThis.window = { location: { href: 'http://localhost/' } };
  globalThis.WebSocket = WebSocket;
  globalThis.MediaStream = class { getTracks() { return []; } };
  const service = createSignalingServer({ allowedOrigins: '' });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const peer = new PeerSession({ role: 'mobile', retryBaseMs: 10 });
  peer.handleSignal = async function(raw) {
    const message = JSON.parse(raw);
    if (message.type === 'joined') this.report('waiting', 'joined');
  };
  t.after(async () => {
    peer.disconnect();
    for (const socket of service.wss.clients) socket.terminate();
    await new Promise(resolve => service.wss.close(() => service.server.close(resolve)));
    Object.assign(globalThis, originals);
  });
  await peer.connect('http://127.0.0.1:' + service.server.address().port, 'RETRY234');
  return { peer, service };
}

test('a dropped signaling socket rejoins the same room and explicit leave prevents resurrection', async t => {
  const { peer, service } = await fixture(t);
  const originalSocket = peer.signal;
  [...service.wss.clients][0].terminate();
  await until(() => peer.signal !== originalSocket && peer.phase === 'waiting');
  assert.equal(service.rooms.get('RETRY234').size, 1);
  const rejoinedSocket = peer.signal;
  peer.disconnect();
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(peer.signal, null);
  assert.equal(rejoinedSocket.readyState, WebSocket.CLOSED);
  assert.equal(service.rooms.size, 0);
});

test('negotiation timeouts request bounded recovery and disconnect clears all timers', async t => {
  const { peer } = await fixture(t);
  const sent = [];
  peer.sendSignal = message => sent.push(message);
  peer.peerPresent = true;
  peer.negotiationTimeoutMs = 10;
  peer.maxMediaAttempts = 2;
  peer.armNegotiationTimeout();
  await until(() => peer.phase === 'failed');
  assert.equal(sent.filter(message => message.type === 'restart').length, 2);
  assert.match(peer.phase, /failed/);
  peer.disconnect();
  assert.equal(peer.retryTimer, null);
  assert.equal(peer.negotiationTimer, null);
  assert.equal(peer.recoveryTimer, null);
});

test('media restart invalidates old asynchronous peer work and preserves desktop capture', async t => {
  const { peer } = await fixture(t);
  peer.role = 'desktop';
  peer.peerPresent = true;
  const stream = peer.localStream = {};
  const oldPc = peer.pc = { close() { this.closed = true; } };
  const sent = [];
  let offered = false;
  peer.sendSignal = value => sent.push(value);
  peer.maybeOffer = async () => { offered = true; };
  const epoch = peer.epoch;
  peer.restartMedia();
  assert.ok(peer.epoch > epoch);
  assert.equal(peer.isCurrent(oldPc), false);
  assert.equal(oldPc.closed, true);
  assert.equal(peer.localStream, stream);
  assert.equal(peer.peerPresent, true);
  assert.deepEqual(sent, [{ type: 'restart' }]);
  assert.equal(offered, true);
});
