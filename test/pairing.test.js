import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairingCode, parsePairingCode, checkSignaling, scanFailureMessage } from '../src/pairing.js';
import network from '../electron/network.cjs';

test('camera denial explains restoring permissions in phone settings in Chinese', () => {
  const actualNativeMessage = "Couldn't scan because camera access wasn't provided. Check your camera permissions and try again.";
  const message = scanFailureMessage(new Error(actualNativeMessage));
  assert.match(message, /手机设置.*PAIRO.*允许相机/);
  assert.ok(!message.includes("Couldn't scan"));
  assert.match(scanFailureMessage(new Error('Scan cancelled')), /扫码已取消/);
});

test('QR pairing roundtrip validates identity, expiration, protocol and reachable address', () => {
  const now = 1000000;
  const code = createPairingCode('http://192.168.1.20:8787', 'ABCDEFGH', now);
  assert.deepEqual(parsePairingCode(code, now), { signalBase: 'http://192.168.1.20:8787', room: 'ABCDEFGH', expiresAt: now + 600000 });
  assert.throws(() => parsePairingCode(code, now + 600000), /过期/);
  for (const fields of [{ version: 99 }, { room: 'bad' }, { signalBase: 'file:///secret' }, { signalBase: 'http://localhost:8787' }, { signalBase: 'https://user:password@example.org' }, { type: 'other' }]) {
    assert.throws(() => parsePairingCode(JSON.stringify({ ...JSON.parse(code), ...fields }), now));
  }
  assert.throws(() => parsePairingCode('https://unrelated.example', now));
  assert.throws(() => parsePairingCode('x'.repeat(2049), now));
});

test('Wi-Fi and Ethernet rank before virtual/VPN interfaces and all remain selectable', () => {
  const record = address => [{ address, family: 'IPv4', internal: false }];
  const addresses = network.lanAddresses({ VPN: record('10.0.0.1'), 'vEthernet WSL': record('172.22.1.1'), Ethernet: record('192.168.1.2'), 'Wi-Fi': record('192.168.1.3'), Loopback: [{ address: '127.0.0.1', internal: true }], Unconfigured: record('169.254.1.2') }, 9000);
  assert.deepEqual(addresses.map(item => item.interface), ['Wi-Fi', 'Ethernet', 'vEthernet WSL', 'VPN']);
  assert.equal(addresses[0].url, 'http://192.168.1.3:9000');
});

test('connection diagnostics distinguish PAIRO from unrelated services and time out native calls', async () => {
  const health = { ok: true, service: 'p2p-meeting-copilot-signaling' };
  let requestUrl;
  assert.match(await checkSignaling('http://192.168.1.20:8787', { fetchImpl: async url => { requestUrl = url.href; return { ok: true, json: async () => health }; } }), /可访问/);
  assert.equal(requestUrl, 'http://192.168.1.20:8787/health');
  await assert.rejects(checkSignaling('http://example.org', { fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }) }), /不是可用/);
  await assert.rejects(checkSignaling('http://example.org', { nativeHttp: { get: () => new Promise(() => {}) }, timeoutMs: 10 }), /未响应/);
  await assert.rejects(checkSignaling('file:///x'), /http/);
});
