import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import { randomUUID } from 'node:crypto';

const SIGNAL_PATH = '/signaling';
const MAX_PAYLOAD = 256 * 1024;
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const ALLOWED_TYPES = new Set(['offer', 'answer', 'candidate']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validNegotiation(message, role) {
  if (!ALLOWED_TYPES.has(message.type) || !isRecord(message.payload)) return false;
  const payload = message.payload;
  if (message.type === 'candidate') {
    return typeof payload.candidate === 'string' && payload.candidate.length <= 8192
      && (payload.sdpMid == null || typeof payload.sdpMid === 'string')
      && (payload.sdpMLineIndex == null || (Number.isInteger(payload.sdpMLineIndex) && payload.sdpMLineIndex >= 0));
  }
  return message.type === (role === 'desktop' ? 'offer' : 'answer')
    && payload.type === message.type && typeof payload.sdp === 'string' && payload.sdp.length > 0;
}

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

export function createSignalingServer({ iceServers, allowedOrigins = process.env.ALLOWED_ORIGINS, heartbeatMs = 15000, maxConnections = 128, maxConnectionsPerIp = 16, maxRooms = 64, unjoinedTimeoutMs = 10000, waitingTimeoutMs = 30 * 60 * 1000 } = {}) {
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
    let pathname;
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
    catch { res.writeHead(400).end('Invalid request target'); return; }
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
    let pathname;
    try { pathname = new URL(req.url || '/', 'http://localhost').pathname; }
    catch { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    const origin = req.headers.origin;
    if (pathname !== SIGNAL_PATH || (origins && origin && !origins.has(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const ip = req.socket.remoteAddress;
    if (wss.clients.size >= maxConnections || [...sockets.values()].filter(meta => meta.ip === ip).length >= maxConnectionsPerIp) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    const meta = { room: null, role: null, windowStart: Date.now(), count: 0, ip: req.socket.remoteAddress, alive: true, lastActivity: Date.now() };
    sockets.set(ws, meta);
    ws.on('pong', () => { meta.alive = true; });
    // Receiver errors (including maxPayload violations) occur before the message event.
    ws.on('error', () => ws.terminate());
    ws.on('message', raw => {
      meta.lastActivity = Date.now();
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
      if (!isRecord(message)) {
        sendJson(ws, { type: 'error', message: '消息必须是 JSON 对象' });
        return;
      }
      if (!meta.room) {
        if (message.type !== 'join' || !/^[A-Z2-9]{8,12}$/.test(String(message.room || '')) || !['desktop', 'mobile'].includes(message.role)) {
          sendJson(ws, { type: 'error', message: '房间码或设备角色无效' });
          return;
        }
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          sendJson(ws, { type: 'error', message: '电脑和手机版本不兼容，请同时更新两端程序' });
          ws.close(1008, 'incompatible protocol');
          return;
        }
        const roomName = String(message.room);
        let room = rooms.get(roomName);
        if (!room) {
          if (rooms.size >= maxRooms) {
            sendJson(ws, { type: 'error', message: '房间数量已达上限，请稍后重试' });
            ws.close(1008, 'room limit');
            return;
          }
          room = new Map();
          rooms.set(roomName, room);
        }
        if (room.has(message.role) || room.size >= 2) {
          sendJson(ws, { type: 'error', message: '房间已满或该设备角色已连接' });
          return;
        }
        meta.room = roomName;
        meta.role = message.role;
        if (meta.role === 'desktop') room.requireApproval = message.requireApproval === true;
        if (meta.role === 'mobile') room.peerApproved = Boolean(room.approvedToken && message.reconnectToken === room.approvedToken);
        room.set(meta.role, ws);
        const approvalRequired = Boolean(room.requireApproval && !room.peerApproved);
        sendJson(ws, { type: 'joined', role: meta.role, peerPresent: room.size === 2, protocolVersion: PROTOCOL_VERSION, approvalRequired });
        for (const [role, peer] of room) {
          if (peer !== ws) sendJson(peer, { type: 'peer-joined', role: meta.role, approvalRequired });
        }
        return;
      }
      const room = rooms.get(meta.room);
      if (message.type === 'approve' && meta.role === 'desktop' && typeof message.allow === 'boolean') {
        const phone = room?.get('mobile');
        if (!phone) return;
        if (message.allow) {
          room.peerApproved = true;
          room.approvedToken = randomUUID();
          sendJson(phone, { type: 'approved', reconnectToken: room.approvedToken });
          sendJson(ws, { type: 'approved' });
        } else {
          sendJson(phone, { type: 'error', message: '电脑已拒绝本次连接，请与电脑使用者确认' });
          phone.close(1008, 'pairing rejected');
        }
        return;
      }
      if (room?.requireApproval && !room.peerApproved) {
        sendJson(ws, { type: 'error', message: '请等待电脑确认手机连接' });
        return;
      }
      if (message.type !== 'restart' && !validNegotiation(message, meta.role)) {
        sendJson(ws, { type: 'error', message: '仅允许转发 SDP 与 ICE 协商消息' });
        return;
      }
      const peer = room && [...room.entries()].find(([role]) => role !== meta.role)?.[1];
      if (!peer) {
        sendJson(ws, { type: 'error', message: '对端尚未加入房间' });
        return;
      }
      sendJson(peer, message.type === 'restart' ? { type: 'restart', from: meta.role } : { type: message.type, payload: message.payload, from: meta.role });
    });
    ws.on('close', () => {
      const current = sockets.get(ws);
      sockets.delete(ws);
      if (!current?.room) return;
      const room = rooms.get(current.room);
      if (!room) return;
      room.delete(current.role);
      if (current.role === 'mobile') room.peerApproved = false;
      for (const peer of room.values()) sendJson(peer, { type: 'peer-left' });
      if (room.size === 0) rooms.delete(current.room);
    });
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [ws, meta] of sockets) {
      const room = meta.room && rooms.get(meta.room);
      if (!meta.alive || (!meta.room && now - meta.lastActivity > unjoinedTimeoutMs) || (room?.size === 1 && now - meta.lastActivity > waitingTimeoutMs)) {
        ws.terminate();
        continue;
      }
      meta.alive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  return { server, wss, rooms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { server } = createSignalingServer();
  const port = Number(process.env.PORT || 8787);
  server.listen(port, '0.0.0.0', () => console.log('P2P signaling listening on :' + port));
}
