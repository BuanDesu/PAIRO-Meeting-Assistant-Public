import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerSession, normalizeBaseUrl, toWebSocketUrl } from '../src/peer-session.js';

test('normalizes signalling URLs and chooses a secure websocket for HTTPS', () => {
  const original = globalThis.window;
  globalThis.window = { location: { href: 'https://app.example/path' } };
  try {
    assert.equal(normalizeBaseUrl('https://signal.example/custom/path'), 'https://signal.example');
    assert.equal(toWebSocketUrl('https://signal.example'), 'wss://signal.example/signaling');
    assert.equal(toWebSocketUrl('http://localhost:8787'), 'ws://localhost:8787/signaling');
    assert.throws(() => normalizeBaseUrl('javascript:alert(1)'), /信令地址必须使用 http 或 https/);
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});

function peerFixture(t) {
  const original = { fetch: globalThis.fetch, MediaStream: globalThis.MediaStream, RTCPeerConnection: globalThis.RTCPeerConnection };
  let created = 0;
  globalThis.MediaStream = class { getTracks() { return []; } };
  globalThis.RTCPeerConnection = class {
    constructor() { created++; }
    getSenders() { return []; }
    close() { this.closed = true; }
  };
  const pending = [];
  globalThis.fetch = () => new Promise(resolve => pending.push(() => resolve({ ok: true, json: async () => ({ iceServers: [{ urls: 'stun:test' }] }) })));
  const peer = new PeerSession({ role: 'mobile' });
  peer.baseUrl = 'http://localhost';
  t.after(() => { peer.disconnect(); Object.assign(globalThis, original); });
  return { peer, pending, created: () => created };
}

test('disconnect during ICE fetch cannot resurrect a peer connection', async t => {
  const { peer, pending, created } = peerFixture(t);
  const initialization = peer.ensurePeer();
  peer.disconnect();
  pending[0]();
  assert.equal(await initialization, null);
  assert.equal(created(), 0);
  assert.equal(peer.pc, null);
});

test('concurrent initialization shares one connection and peer departure invalidates older work', async t => {
  const { peer, pending, created } = peerFixture(t);
  const old = peer.ensurePeer();
  await peer.handleSignal('{"type":"peer-left"}');
  const first = peer.ensurePeer(), second = peer.ensurePeer();
  assert.equal(pending.length, 2);
  pending[0]();
  assert.equal(await old, null);
  pending[1]();
  assert.equal(await first, await second);
  assert.equal(created(), 1);
});
