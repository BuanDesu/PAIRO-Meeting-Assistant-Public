import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { createSignalingServer } from '../server/signaling.js';

function nextJson(socket, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for websocket message')), timeout);
    socket.once('message', data => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
    socket.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function fixture(t) {
  const service = createSignalingServer({ iceServers: [{ urls: 'stun:example.test' }], allowedOrigins: '' });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const address = service.server.address();
  const url = 'ws://127.0.0.1:' + address.port + '/signaling';
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.close();
    await new Promise(resolve => service.wss.close(() => service.server.close(resolve)));
  });
  return { service, url, sockets, connect: async () => {
    const socket = new WebSocket(url);
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return socket;
  } };
}

test('relays negotiation messages only between one desktop and one phone', async t => {
  const fx = await fixture(t);
  const desktop = await fx.connect();
  desktop.send(JSON.stringify({ type: 'join', room: 'ABCD2345', role: 'desktop' }));
  assert.equal((await nextJson(desktop)).type, 'joined');
  const phone = await fx.connect();
  phone.send(JSON.stringify({ type: 'join', room: 'ABCD2345', role: 'mobile' }));
  assert.equal((await nextJson(phone)).peerPresent, true);
  assert.equal((await nextJson(desktop)).type, 'peer-joined');
  const offer = { type: 'offer', payload: { type: 'offer', sdp: 'v=0' } };
  desktop.send(JSON.stringify(offer));
  assert.deepEqual(await nextJson(phone), { type: 'offer', payload: offer.payload, from: 'desktop' });
  desktop.send(JSON.stringify({ type: 'screenshot', payload: { data: 'private' } }));
  assert.equal((await nextJson(desktop)).type, 'error');
  assert.equal(fx.service.rooms.get('ABCD2345').size, 2);
});

test('rejects duplicate roles and frees rooms when peers leave', async t => {
  const fx = await fixture(t);
  const desktop = await fx.connect();
  desktop.send(JSON.stringify({ type: 'join', room: 'ROOM2345', role: 'desktop' }));
  await nextJson(desktop);
  const duplicate = await fx.connect();
  duplicate.send(JSON.stringify({ type: 'join', room: 'ROOM2345', role: 'desktop' }));
  assert.equal((await nextJson(duplicate)).type, 'error');
  const phone = await fx.connect();
  phone.send(JSON.stringify({ type: 'join', room: 'ROOM2345', role: 'mobile' }));
  await nextJson(phone);
  await nextJson(desktop);
  phone.close();
  assert.equal((await nextJson(desktop)).type, 'peer-left');
  assert.equal(fx.service.rooms.get('ROOM2345').size, 1);
});

test('serves health and ICE configuration without storing room data', async t => {
  const fx = await fixture(t);
  const base = fx.url.replace('ws://', 'http://').replace('/signaling', '');
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: 'p2p-meeting-copilot-signaling' });
  const config = await fetch(base + '/ice-config');
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), { iceServers: [{ urls: 'stun:example.test' }] });
});

test('rejects JSON primitives and invalid negotiation without killing the service', async t => {
  const fx = await fixture(t);
  const socket = await fx.connect();
  for (const value of [null, [], 42, 'join']) {
    const response = nextJson(socket);
    socket.send(JSON.stringify(value));
    assert.equal((await response).type, 'error');
  }
  socket.send(JSON.stringify({ type: 'join', role: 'desktop', room: 'SAFE2345' }));
  await nextJson(socket);
  for (const message of [
    { type: 'offer', payload: [] },
    { type: 'offer', payload: { type: 'answer', sdp: 'v=0' } },
    { type: 'candidate', payload: { candidate: 42 } },
  ]) {
    const response = nextJson(socket);
    socket.send(JSON.stringify(message));
    assert.equal((await response).type, 'error');
  }
  assert.equal(fx.service.rooms.get('SAFE2345').size, 1);
});

test('an oversized websocket frame closes only its sender', async t => {
  const fx = await fixture(t);
  const desktop = await fx.connect();
  desktop.send(JSON.stringify({ type: 'join', role: 'desktop', room: 'SAFE2345' }));
  await nextJson(desktop);
  const attacker = await fx.connect();
  const closed = once(attacker, 'close');
  attacker.send('x'.repeat(256 * 1024 + 1));
  await closed;
  const phone = await fx.connect();
  phone.send(JSON.stringify({ type: 'join', role: 'mobile', room: 'SAFE2345' }));
  assert.equal((await nextJson(phone)).peerPresent, true);
  await nextJson(desktop);
  desktop.send(JSON.stringify({ type: 'offer', payload: { type: 'offer', sdp: 'v=0' } }));
  assert.equal((await nextJson(phone)).type, 'offer');
});

