import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const SIGNAL_PATH = '/signaling';
const MAX_PAYLOAD = 256 * 1024;
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const ALLOWED_TYPES = new Set(['offer', 'answer', 'candidate']);

function sendJson(socket, value) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function parseIceServers(raw = process.env.ICE_SERVERS_JSON) {
  if (!raw) return DEFAULT_ICE;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('ICE_SERVERS_JSON must be a non-empty array');
  return parsed;
}

function setCors(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (allowedOrigins && origin && !allowedOrigins.has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', allowedOrigins ? (origin || '') : '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return true;
}

export function createSignalingServer({ iceServers, allowedOrigins = process.env.ALLOWED_ORIGINS } = {}) {
  const ice = iceServers || parseIceServers();
  const origins = allowedOrigins ? new Set(String(allowedOrigins).split(',').map(item => item.trim()).filter(Boolean)) : null;
  const rooms = new Map();
  const sockets = new Map();
  const server = createServer((req, res) => {
    if (!setCors(req, res, origins)) {
      res.writeHead(403).end('Origin not allowed');
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'p2p-meeting-copilot-signaling' }));
      return;
    }
    if (req.method === 'GET' && pathname === '/ice-config') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ iceServers: ice }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const origin = req.headers.origin;
    if (pathname !== SIGNAL_PATH || (origins && origin && !origins.has(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', ws => {
    const meta = { room: null, role: null, windowStart: Date.now(), count: 0 };
    sockets.set(ws, meta);
    ws.on('message', raw => {
      if (raw.length > MAX_PAYLOAD) {
        sendJson(ws, { type: 'error', message: '消息超过大小限制' });
        ws.close(1009, 'message too large');
        return;
      }
      meta.count += 1;
      if (Date.now() - meta.windowStart > 60000) {
        meta.windowStart = Date.now();
        meta.count = 1;
      }
      if (meta.count > 120) {
        sendJson(ws, { type: 'error', message: '消息过于频繁' });
        ws.close(1008, 'rate limited');
        return;
      }
      let message;
      try { message = JSON.parse(raw.toString()); } catch {
        sendJson(ws, { type: 'error', message: '无效 JSON' });
        return;
      }
      if (!meta.room) {
        if (message.type !== 'join' || !/^[A-Z2-9]{8,12}$/.test(String(message.room || '')) || !['desktop', 'mobile'].includes(message.role)) {
          sendJson(ws, { type: 'error', message: '房间码或设备角色无效' });
          return;
        }
        const roomName = String(message.room);
        let room = rooms.get(roomName);
        if (!room) {
          room = new Map();
          rooms.set(roomName, room);
        }
        if (room.has(message.role) || room.size >= 2) {
          sendJson(ws, { type: 'error', message: '房间已满或该设备角色已连接' });
          return;
        }
        meta.room = roomName;
        meta.role = message.role;
        room.set(meta.role, ws);
        sendJson(ws, { type: 'joined', role: meta.role, peerPresent: room.size === 2 });
        for (const [role, peer] of room) {
          if (peer !== ws) sendJson(peer, { type: 'peer-joined', role: meta.role });
        }
        return;
      }
      if (!ALLOWED_TYPES.has(message.type) || !message.payload || typeof message.payload !== 'object') {
        sendJson(ws, { type: 'error', message: '仅允许转发 SDP 与 ICE 协商消息' });
        return;
      }
      const room = rooms.get(meta.room);
      const peer = room && [...room.entries()].find(([role]) => role !== meta.role)?.[1];
      if (!peer) {
        sendJson(ws, { type: 'error', message: '对端尚未加入房间' });
        return;
      }
      sendJson(peer, { type: message.type, payload: message.payload, from: meta.role });
    });
    ws.on('close', () => {
      const current = sockets.get(ws);
      sockets.delete(ws);
      if (!current?.room) return;
      const room = rooms.get(current.room);
      if (!room) return;
      room.delete(current.role);
      for (const peer of room.values()) sendJson(peer, { type: 'peer-left' });
      if (room.size === 0) rooms.delete(current.room);
    });
  });

  return { server, wss, rooms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { server } = createSignalingServer();
  const port = Number(process.env.PORT || 8787);
  server.listen(port, '0.0.0.0', () => console.log('P2P signaling listening on :' + port));
}
