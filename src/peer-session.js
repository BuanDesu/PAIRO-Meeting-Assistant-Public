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
  constructor({ role, onStatus = () => {}, onMessage = () => {}, onStream = () => {} }) {
    this.role = role;
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.onStream = onStream;
    this.signal = null;
    this.pc = null;
    this.channel = null;
    this.localStream = null;
    this.remoteStream = new MediaStream();
    this.pendingCandidates = [];
    this.peerPresent = false;
    this.offerPending = false;
    this.closed = false;
  }

  setLocalStream(stream) {
    this.localStream = stream;
    if (this.pc) this.addLocalTracks();
  }

  async connect(baseUrl, room) {
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
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        this.handleSignal(event.data).catch(error => this.onStatus('协商失败: ' + error.message));
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
        if (!this.closed) this.onStatus('信令已断开');
      });
    });
  }

  sendSignal(message) {
    if (this.signal?.readyState === WebSocket.OPEN) this.signal.send(JSON.stringify(message));
  }

  async handleSignal(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
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
      this.pc?.close();
      this.pc = null;
      this.channel = null;
      this.pendingCandidates = [];
      this.offerPending = false;
      this.remoteStream = new MediaStream();
      this.onStream(this.remoteStream);
      this.onStatus('对端已离开房间');
      return;
    }
    if (message.type === 'offer') {
      await this.ensurePeer();
      await this.pc.setRemoteDescription(message.payload);
      await this.flushCandidates();
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.sendSignal({ type: 'answer', payload: this.pc.localDescription });
      this.onStatus('已收到邀请，等待 P2P 连通…');
      return;
    }
    if (message.type === 'answer') {
      if (!this.pc) return;
      await this.pc.setRemoteDescription(message.payload);
      await this.flushCandidates();
      this.onStatus('已完成协商，正在打通媒体通道…');
      return;
    }
    if (message.type === 'candidate') {
      if (!this.pc || !this.pc.remoteDescription) this.pendingCandidates.push(message.payload);
      else await this.pc.addIceCandidate(message.payload).catch(() => {});
    }
  }

  async getIceServers() {
    try {
      const response = await fetch(new URL('/ice-config', this.baseUrl), { cache: 'no-store' });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.iceServers) && data.iceServers.length) return data.iceServers;
      }
    } catch { /* default STUN keeps local development usable */ }
    return DEFAULT_ICE;
  }

  async ensurePeer() {
    if (this.pc) return;
    this.pc = new RTCPeerConnection({ iceServers: await this.getIceServers() });
    this.pc.onicecandidate = event => {
      if (event.candidate) this.sendSignal({ type: 'candidate', payload: event.candidate });
    };
    this.pc.ontrack = event => {
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
    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState || 'closed';
      this.onStatus(state === 'connected' ? 'P2P 已加密直连' : 'P2P 状态: ' + state);
    };
    this.pc.ondatachannel = event => this.attachChannel(event.channel);
    if (this.role === 'desktop') this.attachChannel(this.pc.createDataChannel('copilot', { ordered: true }));
    this.addLocalTracks();
  }

  addLocalTracks() {
    if (!this.pc || !this.localStream) return;
    const attached = new Set(this.pc.getSenders().map(sender => sender.track?.id).filter(Boolean));
    for (const track of this.localStream.getTracks()) {
      if (!attached.has(track.id)) this.pc.addTrack(track, this.localStream);
    }
  }

  attachChannel(channel) {
    this.channel = channel;
    channel.onopen = () => this.onStatus('P2P 已加密直连');
    channel.onclose = () => this.onStatus('数据通道已关闭');
    channel.onerror = () => this.onStatus('数据通道发生错误');
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 4 * 1024 * 1024) {
        this.onStatus('已丢弃过大的对端消息');
        return;
      }
      try { this.onMessage(JSON.parse(event.data)); } catch { this.onStatus('收到无法识别的对端消息'); }
    };
  }

  async maybeOffer() {
    if (this.role !== 'desktop' || !this.peerPresent || !this.localStream || this.offerPending) return;
    this.offerPending = true;
    try {
      await this.ensurePeer();
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.sendSignal({ type: 'offer', payload: this.pc.localDescription });
      this.onStatus('已发送邀请，等待手机应答…');
    } catch (error) {
      this.onStatus('建立邀请失败: ' + error.message);
    } finally {
      this.offerPending = false;
    }
  }

  async flushCandidates() {
    const pending = this.pendingCandidates.splice(0);
    for (const candidate of pending) await this.pc.addIceCandidate(candidate).catch(() => {});
  }

  send(message) {
    if (this.channel?.readyState !== 'open') throw new Error('P2P 数据通道尚未就绪');
    const payload = JSON.stringify(message);
    if (this.channel.bufferedAmount > 4 * 1024 * 1024) throw new Error('发送队列繁忙，请稍后重试');
    this.channel.send(payload);
  }

  disconnect() {
    this.closed = true;
    this.signal?.close();
    this.pc?.close();
    this.channel?.close();
    this.signal = null;
    this.pc = null;
    this.channel = null;
    this.peerPresent = false;
    this.pendingCandidates = [];
    this.remoteStream = new MediaStream();
  }
}
