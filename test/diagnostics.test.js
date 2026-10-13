import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionDiagnostics } from '../src/diagnostics.js';

test('diagnostics describe connection states and live track counts without serializing sensitive data', () => {
  const secret = 'SECRET-KEY-ROOM-PROMPT-IMAGE-ADDRESS';
  const peer = { phase: 'connected', signal: { readyState: 1, url: secret }, pc: { connectionState: 'connected', localDescription: { sdp: secret } }, channel: { readyState: 'open' }, baseUrl: secret, room: secret, reconnectToken: secret, lastError: secret };
  const result = connectionDiagnostics({ version: '0.2.0', platform: 'android', role: 'mobile', peer, now: 0,
    remoteStream: { getTracks: () => [{ kind: 'video', readyState: 'live', label: secret }, { kind: 'audio', readyState: 'ended', id: secret }] }, apiKey: secret, history: secret });
  assert.equal(result.phase, 'connected'); assert.equal(result.signaling, 'open');
  assert.deepEqual(result.remoteMedia, { video: 1, audio: 0 });
  assert.equal(result.generatedAt, '1970-01-01T00:00:00.000Z');
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.peerConnection, 'connected');
});

test('unexpected status and version strings cannot smuggle credentials into diagnostics', () => {
  const secret = 'unexpected-private-value';
  const result = connectionDiagnostics({ version: secret, platform: secret, role: secret, peer: { phase: secret, pc: { connectionState: secret }, channel: { readyState: secret }, signal: { readyState: secret } } });
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(result.version, 'unknown'); assert.equal(result.signaling, 'none');
});
