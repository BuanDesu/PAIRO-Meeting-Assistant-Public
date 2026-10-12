import { DataChannelTransport } from './data-channel.js';
const DEFAULT_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('请填写信令服务地址');
  const url = new URL(raw, window.location.href);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('信令地址必须使用 http 或 https');
  return url.origin;
}

export function toWebSocketUrl(baseUrl) {
  const url = new URL(normalizeBaseUrl(baseUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/signaling';
  url.search = '';
  return url.toString();
}

export class PeerSession {
  constructor({ role, onStatus = () => {}, onMessage = () => {}, onStream = () => {}, onPeerLeft = () => {} }) {
    this.role = role;
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.onStream = onStream;
    this.onPeerLeft = onPeerLeft;
    this.signal = null;
    this.pc = null;
    this.channel = null;
    this.localStream = null;
    this.remoteStream = new MediaStream();
    this.pendingCandidates = [];
    this.peerPresent = false;
    this.offerPending = false;
    this.closed = false;
    this.epoch = 0;
    this.initializing = null;
    this.transport = null;
  }

  setLocalStream(stream) {
    this.localStream = stream;
    if (this.pc) this.addLocalTracks();
  }

  async connect(baseUrl, room) {
    if (this.signal) this.disconnect();
    this.closed = false;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.room = room.trim().toUpperCase();
    const ws = new WebSocket(toWebSocketUrl(this.baseUrl));
    this.signal = ws;
    this.onStatus('正在连接信令服务…');
    await new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
        try { ws.close(); } catch { /* socket may already be closed */ }
      };
      timer = setTimeout(() => fail(new Error('连接信令服务超时')), 10000);
      ws.addEventListener('open', () => this.sendSignal({ type: 'join', room: this.room, role: this.role }), { once: true });
      ws.addEventListener('message', event => {
        if (this.signal !== ws || this.closed) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        const epoch = this.epoch;
        this.handleSignal(event.data).catch(error => {
          if (!this.closed && this.signal === ws && epoch === this.epoch) this.onStatus('协商失败: ' + error.message);
        });
        if (message.type === 'error') fail(new Error(message.message || '信令服务拒绝连接'));
        if (message.type === 'joined' && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener('error', () => fail(new Error('无法连接信令服务，请检查地址与网络')), { once: true });
      ws.addEventListener('close', () => {
        if (!settled) fail(new Error('信令连接已关闭'));
        if (!this.closed && this.signal === ws) {
          this.resetPeer();
          this.onPeerLeft();
          this.onStatus('信令已断开');
        }
      });
    });
  }

  sendSignal(message) {
    if (!this.closed && this.signal?.readyState === WebSocket.OPEN) this.signal.send(JSON.stringify(message));
  }

  async handleSignal(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (this.closed || !message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.type === 'error') {
      this.onStatus(message.message || '信令服务拒绝连接');
      return;
    }
    if (message.type === 'joined') {
      this.peerPresent = Boolean(message.peerPresent);
      this.onStatus(this.peerPresent ? '已配对，正在协商…' : '已进入房间，等待另一台设备…');
      if (this.peerPresent) await this.maybeOffer();
      return;
    }
    if (message.type === 'peer-joined') {
      this.peerPresent = true;
      this.onStatus('手机已加入，正在建立 P2P…');
      await this.maybeOffer();
      return;
    }
    if (message.type === 'peer-left') {
      this.peerPresent = false;
      this.resetPeer();
      this.onPeerLeft();
      this.onStatus('对端已离开房间');
      return;
    }
    if (message.type === 'offer') {
      if (this.role !== 'mobile') return;
      const pc = await this.ensurePeer();
      if (!pc || !this.isCurrent(pc)) return;
      await pc.setRemoteDescription(message.payload);
      if (!this.isCurrent(pc)) return;
      await this.flushCandidates(pc);
      if (!this.isCurrent(pc)) return;
      const answer = await pc.createAnswer();
      if (!this.isCurrent(pc)) return;
      await pc.setLocalDescription(answer);
      if (!this.isCurrent(pc)) return;
      this.sendSignal({ type: 'answer', payload: pc.localDescription });
      this.onStatus('已收到邀请，等待 P2P 连通…');
      return;
    }
    if (message.type === 'answer') {
      const pc = this.pc;
      if (!pc || this.role !== 'desktop') return;
      await pc.setRemoteDescription(message.payload);
      if (!this.isCurrent(pc)) return;
      await this.flushCandidates(pc);
      if (!this.isCurrent(pc)) return;
      this.onStatus('已完成协商，正在打通媒体通道…');
      return;
    }
    if (message.type === 'candidate') {
      if (!this.pc || !this.pc.remoteDescription) this.pendingCandidates.push(message.payload);
      else await this.pc.addIceCandidate(message.payload).catch(() => {});
    }
  }

  async getIceServers(signal) {
    try {
      const response = await fetch(new URL('/ice-config', this.baseUrl), { cache: 'no-store', signal });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.iceServers) && data.iceServers.length) return data.iceServers;
      }
    } catch { /* default STUN keeps local development usable */ }
    return DEFAULT_ICE;
  }

  async ensurePeer() {
    if (this.closed) return null;
    if (this.pc) return this.pc;
    if (this.initializing) return this.initializing.promise;
    const epoch = this.epoch;
    const controller = new AbortController();
    const initialization = { controller, promise: null };
    this.initializing = initialization;
    initialization.promise = (async () => {
      const timer = setTimeout(() => controller.abort(), 5000);
      let iceServers;
      try { iceServers = await this.getIceServers(controller.signal); }
      finally { clearTimeout(timer); }
      if (this.closed || this.epoch !== epoch) return null;
      const pc = new RTCPeerConnection({ iceServers });
      this.pc = pc;
      this.configurePeer(pc);
      return pc;
    })().finally(() => {
      if (this.initializing === initialization) this.initializing = null;
    });
    return initialization.promise;
  }

  isCurrent(pc) { return !this.closed && this.pc === pc; }

  configurePeer(pc) {
    pc.onicecandidate = event => {
      if (!this.isCurrent(pc)) return;
      if (event.candidate) this.sendSignal({ type: 'candidate', payload: event.candidate });
    };
    pc.ontrack = event => {
      if (!this.isCurrent(pc)) return;
      const source = event.streams?.[0];
      if (source) {
        for (const track of source.getTracks()) {
          if (!this.remoteStream.getTracks().some(existing => existing.id === track.id)) this.remoteStream.addTrack(track);
        }
      } else if (!this.remoteStream.getTracks().some(existing => existing.id === event.track.id)) {
        this.remoteStream.addTrack(event.track);
      }
      this.onStream(this.remoteStream);
    };
    pc.onconnectionstatechange = () => {
      if (!this.isCurrent(pc)) return;
      const state = pc.connectionState;
      this.onStatus(state === 'connected' ? 'P2P 已加密直连' : 'P2P 状态: ' + state);
    };
    pc.ondatachannel = event => {
      if (this.isCurrent(pc)) this.attachChannel(event.channel, pc);
      else event.channel.close();
    };
    if (this.role === 'desktop') this.attachChannel(pc.createDataChannel('copilot', { ordered: true }), pc);
    this.addLocalTracks();
  }

  addLocalTracks() {
    if (!this.pc || !this.localStream) return;
    const attached = new Set(this.pc.getSenders().map(sender => sender.track?.id).filter(Boolean));
    for (const track of this.localStream.getTracks()) {
      if (!attached.has(track.id)) this.pc.addTrack(track, this.localStream);
    }
  }

  attachChannel(channel, pc = this.pc) {
    this.transport?.dispose();
    this.channel = channel;
    const current = () => !this.closed && this.channel === channel && this.pc === pc;
    const transport = this.transport = new DataChannelTransport(channel, {
      maxMessageSize: () => pc?.sctp?.maxMessageSize ?? 65536,
      onMessage: message => current() ? this.onMessage(message) : undefined,
      onError: error => { if (current()) this.onStatus(error.message); },
    });
    channel.onopen = () => { if (current()) this.onStatus('P2P 已加密直连'); };
    channel.onclose = () => { transport.dispose(); if (current()) this.onStatus('数据通道已关闭'); };
    channel.onerror = () => { transport.dispose(); if (current()) this.onStatus('数据通道发生错误'); };
    channel.onmessage = event => {
      if (current()) transport.receive(event.data);
    };
  }

  async maybeOffer() {
    if (this.role !== 'desktop' || !this.peerPresent || !this.localStream || this.offerPending) return;
    this.offerPending = true;
    const epoch = this.epoch;
    try {
      const pc = await this.ensurePeer();
      if (!pc || !this.isCurrent(pc)) return;
      const offer = await pc.createOffer();
      if (!this.isCurrent(pc)) return;
      await pc.setLocalDescription(offer);
      if (!this.isCurrent(pc)) return;
      this.sendSignal({ type: 'offer', payload: pc.localDescription });
      this.onStatus('已发送邀请，等待手机应答…');
    } catch (error) {
      if (!this.closed && epoch === this.epoch) this.onStatus('建立邀请失败: ' + error.message);
    } finally {
      if (epoch === this.epoch) this.offerPending = false;
    }
  }

  async flushCandidates(pc = this.pc) {
    const pending = this.pendingCandidates.splice(0);
    for (const candidate of pending) {
      if (!this.isCurrent(pc)) return;
      await pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  send(message) {
    if (!this.transport) return Promise.reject(new Error('P2P 数据通道尚未就绪'));
    return this.transport.send(message);
  }

  resetPeer() {
    this.epoch += 1;
    this.initializing?.controller.abort();
    this.initializing = null;
    this.transport?.dispose();
    this.transport = null;
    this.pc?.close();
    this.channel?.close();
    this.pc = null;
    this.channel = null;
    this.peerPresent = false;
    this.offerPending = false;
    this.pendingCandidates = [];
    this.remoteStream = new MediaStream();
    this.onStream(this.remoteStream);
  }

  disconnect() {
    this.closed = true;
    this.signal?.close();
    this.signal = null;
    this.resetPeer();
  }
}
