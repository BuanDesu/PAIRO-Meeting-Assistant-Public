import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseUrl, toWebSocketUrl } from '../src/peer-session.js';

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
