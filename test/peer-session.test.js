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

test('capture replacement uses existing senders and rolls back a failed audio replacement without reopening the room', async t => {
  const { peer } = peerFixture(t);
  const oldVideo = { kind: 'video' }, oldAudio = { kind: 'audio' }, newVideo = { kind: 'video' }, newAudio = { kind: 'audio' };
  const stream = tracks => ({ getTracks: () => tracks });
  const changes = [];
  const video = { track: oldVideo, async replaceTrack(track) { changes.push(track); this.track = track; } };
  let failAudio = true;
  const audio = { track: oldAudio, async replaceTrack(track) { if (failAudio) throw new Error('audio failed'); this.track = track; } };
  peer.pc = { getSenders: () => [video, audio], close() {} };
  peer.localStream = stream([oldVideo, oldAudio]); const previous = peer.localStream;
  peer.room = 'EXISTING'; const pc = peer.pc;
  await assert.rejects(peer.replaceLocalStream(stream([newVideo, newAudio])), /audio failed/);
  assert.equal(video.track, oldVideo); assert.equal(peer.localStream, previous);
  assert.deepEqual(changes, [newVideo, oldVideo]);
  failAudio = false;
  const next = stream([newVideo, newAudio]); await peer.replaceLocalStream(next);
  assert.equal(peer.localStream, next); assert.equal(video.track, newVideo); assert.equal(audio.track, newAudio);
  assert.equal(peer.pc, pc); assert.equal(peer.room, 'EXISTING');
  await assert.rejects(peer.replaceLocalStream(stream([newVideo])), /轨道已变化/);
  assert.equal(peer.localStream, next);
});
