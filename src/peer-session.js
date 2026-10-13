import { DataChannelTransport } from './data-channel.js';
import { PROTOCOL_VERSION } from './protocol.js';
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
  constructor({ role, onStatus = () => {}, onMessage = () => {}, onStream = () => {}, onPeerLeft = () => {}, onApproval = () => {}, requireApproval = true, retryBaseMs = 1000, negotiationTimeoutMs = 20000, recoveryDelayMs = 3000, maxReconnectAttempts = 6, maxMediaAttempts = 3 }) {
    this.role = role;
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.onStream = onStream;
    this.onPeerLeft = onPeerLeft;
    this.onApproval = onApproval;
    this.requireApproval = requireApproval;
    this.reconnectToken = '';
    this.awaitingApproval = false;
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
    this.phase = 'idle';
    this.retryBaseMs = retryBaseMs;
    this.negotiationTimeoutMs = negotiationTimeoutMs;
    this.recoveryDelayMs = recoveryDelayMs;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.maxMediaAttempts = maxMediaAttempts;
    this.reconnectAttempts = 0;
    this.mediaAttempts = 0;
    this.retryTimer = null;
    this.negotiationTimer = null;
    this.recoveryTimer = null;
    this.reconnecting = false;
    this.onlineHandler = () => {
      if (this.closed) return;
      if (this.signal?.readyState === WebSocket.OPEN) this.scheduleMediaRecovery(0);
      else this.scheduleReconnect(0);
    };
  }

  report(phase, message) { this.phase = phase; this.onStatus(message); }

  setLocalStream(stream) {
    this.localStream = stream;
    if (this.pc) this.addLocalTracks();
  }

  async replaceLocalStream(stream) {
    if (this.closed) throw new Error('会话已结束');
    const pc = this.pc;
    if (!pc) { this.localStream = stream; return; }
    const remaining = [...stream.getTracks()], changes = [];
    for (const sender of pc.getSenders().filter(item => item.track)) {
      const index = remaining.findIndex(track => track.kind === sender.track.kind);
      if (index < 0) throw new Error('音视频轨道已变化，请停止后重新开始分享');
      changes.push({ sender, previous: sender.track, next: remaining.splice(index, 1)[0] });
    }
    if (remaining.length) throw new Error('音视频轨道已变化，请停止后重新开始分享');
    const applied = [];
    try {
      for (const change of changes) {
        if (!this.isCurrent(pc)) throw new Error('连接正在恢复，请稍后更换共享内容');
        if (change.previous === change.next) continue;
        await change.sender.replaceTrack(change.next);
        applied.push(change);
      }
      if (!this.isCurrent(pc)) throw new Error('连接正在恢复，请稍后更换共享内容');
      this.localStream = stream;
    } catch (error) {
      if (this.isCurrent(pc)) for (const change of applied.reverse()) await change.sender.replaceTrack(change.previous).catch(() => {});
      throw error;
    }
  }

  async connect(baseUrl, room) {
    if (this.signal) this.disconnect();
    this.closed = false;
    this.reconnectAttempts = 0;
    this.mediaAttempts = 0;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.room = room.trim().toUpperCase();
    globalThis.window?.addEventListener?.('online', this.onlineHandler);
    await this.openSignal();
  }

  async openSignal() {
    if (this.closed) return;
    const ws = new WebSocket(toWebSocketUrl(this.baseUrl));
    this.signal = ws;
    this.report('connecting', this.reconnecting ? '网络恢复中，正在重新连接电脑…' : '正在连接信令服务…');
    await new Promise((resolve, reject) => {
      let settled = false;
      let joined = false;
      let terminalError = '';
      let timer;
      const fail = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
        try { ws.close(); } catch { /* socket may already be closed */ }
      };
      timer = setTimeout(() => fail(new Error('连接信令服务超时')), 10000);
      ws.addEventListener('open', () => {
        if (this.signal === ws && !this.closed) this.sendSignal({ type: 'join', room: this.room, role: this.role, protocolVersion: PROTOCOL_VERSION, requireApproval: this.requireApproval, reconnectToken: this.reconnectToken });
      }, { once: true });
      ws.addEventListener('message', event => {
        if (this.signal !== ws || this.closed) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        const epoch = this.epoch;
        this.handleSignal(event.data).catch(error => {
          if (!this.closed && this.signal === ws && epoch === this.epoch) this.onStatus('协商失败: ' + error.message);
        });
        if (message.type === 'error') {
          terminalError = message.message || '信令服务拒绝连接';
          fail(new Error(terminalError));
        }
        if (message.type === 'joined' && !settled) {
          if (message.protocolVersion !== PROTOCOL_VERSION) { fail(new Error('电脑和手机版本不兼容，请同时更新两端程序')); return; }
          joined = true;
          settled = true;
          this.reconnectAttempts = 0;
          clearTimeout(timer);
          resolve();
        }
      });
      ws.addEventListener('error', () => fail(new Error('无法连接信令服务，请检查地址与网络')), { once: true });
      ws.addEventListener('close', event => {
        if (!settled) fail(new Error('信令连接已关闭'));
        if (!this.closed && this.signal === ws) {
          this.resetPeer();
          this.onPeerLeft();
          this.report(event.code === 1008 ? 'failed' : 'disconnected', event.code === 1008 ? terminalError || '电脑拒绝了连接，请确认后重新配对' : '电脑连接已中断，正在尝试恢复…');
          if (joined && event.code !== 1008) this.scheduleReconnect();
        }
      });
    });
  }

  scheduleReconnect(delay) {
    if (this.closed || this.retryTimer !== null || this.reconnecting) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.report('failed', '自动重连未成功，请检查电脑程序、Wi-Fi 与防火墙，再点击重新连接');
      return;
    }
    this.reconnectAttempts += 1;
    this.report('reconnecting', `连接已断开，正在第 ${this.reconnectAttempts} 次重连…`);
    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null;
      if (this.closed) return;
      this.reconnecting = true;
      let failed = false;
      try { await this.openSignal(); }
      catch { failed = true; }
      finally { this.reconnecting = false; }
      if (!this.closed && (failed || this.signal?.readyState !== WebSocket.OPEN)) this.scheduleReconnect();
    }, delay ?? Math.min(10000, this.retryBaseMs * 2 ** (this.reconnectAttempts - 1)));
  }

  reconnect() {
    if (this.closed) return;
    this.reconnectAttempts = 0;
    this.mediaAttempts = 0;
    if (this.signal?.readyState === WebSocket.OPEN) this.scheduleMediaRecovery(0);
    else { clearTimeout(this.retryTimer); this.retryTimer = null; this.scheduleReconnect(0); }
  }

  armNegotiationTimeout() {
    clearTimeout(this.negotiationTimer);
    this.negotiationTimer = setTimeout(() => {
      this.negotiationTimer = null;
      if (!this.closed && this.peerPresent && this.channel?.readyState !== 'open') this.scheduleMediaRecovery(0);
    }, this.negotiationTimeoutMs);
  }

  scheduleMediaRecovery(delay = this.recoveryDelayMs) {
    if (this.closed || !this.peerPresent || this.awaitingApproval || this.recoveryTimer !== null) return;
    if (this.mediaAttempts >= this.maxMediaAttempts) {
      this.report('failed', '画面连接未成功，请确认设备在同一网络，关闭网络隔离后点击重新连接');
      return;
    }
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.closed || !this.peerPresent || this.signal?.readyState !== WebSocket.OPEN) return;
      this.mediaAttempts += 1;
      this.report('reconnecting', `正在恢复画面连接（${this.mediaAttempts}/${this.maxMediaAttempts}）…`);
      if (this.role === 'desktop') this.restartMedia();
      else { this.sendSignal({ type: 'restart' }); this.armNegotiationTimeout(); }
    }, delay);
  }

  restartMedia() {
    if (this.closed || !this.peerPresent) return;
    this.resetPeer(true);
    this.sendSignal({ type: 'restart' });
    this.onPeerLeft();
    void this.maybeOffer();
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
      if (message.protocolVersion !== PROTOCOL_VERSION) {
        this.report('failed', '电脑和手机版本不兼容，请同时更新两端程序');
        return;
      }
      this.peerPresent = Boolean(message.peerPresent);
      this.awaitingApproval = Boolean(message.approvalRequired);
      if (this.peerPresent && this.awaitingApproval) {
        this.report('waiting', this.role === 'desktop' ? '手机申请连接，请确认是否允许共享' : '已找到电脑，等待电脑允许连接…');
        if (this.role === 'desktop') this.onApproval();
        return;
      }
      this.report(this.peerPresent ? 'connecting' : 'waiting', this.peerPresent ? '已配对，正在协商…' : '已进入房间，等待另一台设备…');
      if (this.peerPresent) this.armNegotiationTimeout();
      if (this.peerPresent) await this.maybeOffer();
      return;
    }
    if (message.type === 'peer-joined') {
      this.peerPresent = true;
      this.awaitingApproval = Boolean(message.approvalRequired);
      if (this.awaitingApproval) {
        this.report('waiting', this.role === 'desktop' ? '手机申请连接，请确认是否允许共享' : '已找到电脑，等待电脑允许连接…');
        if (this.role === 'desktop') this.onApproval();
        return;
      }
      this.mediaAttempts = 0;
      this.report('connecting', '另一台设备已加入，正在建立画面连接…');
      this.armNegotiationTimeout();
      await this.maybeOffer();
      return;
    }
    if (message.type === 'approved') {
      this.awaitingApproval = false;
      if (typeof message.reconnectToken === 'string') this.reconnectToken = message.reconnectToken;
      this.report('connecting', '电脑已允许连接，正在建立加密画面连接…');
      this.armNegotiationTimeout();
      await this.maybeOffer();
      return;
    }
    if (message.type === 'peer-left') {
      this.peerPresent = false;
      this.resetPeer();
      this.onPeerLeft();
      this.report('waiting', '对端已离开房间，等待重新连接…');
      return;
    }
    if (message.type === 'restart') {
      if (!this.peerPresent) return;
      if (this.role === 'desktop') this.scheduleMediaRecovery(0);
      else {
        this.resetPeer(true);
        this.onPeerLeft();
        this.report('reconnecting', '正在重新建立画面连接…');
        this.armNegotiationTimeout();
      }
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
      if (!this.pc || !this.pc.remoteDescription) {
        if (this.pendingCandidates.length < 128) this.pendingCandidates.push(message.payload);
      }
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
      if (state === 'connected') {
        clearTimeout(this.recoveryTimer); this.recoveryTimer = null;
        if (this.channel?.readyState === 'open') this.connected();
      } else if (state === 'disconnected' || state === 'failed') {
        this.report('disconnected', '网络发生变化，正在恢复画面连接…');
        this.scheduleMediaRecovery(state === 'failed' ? 0 : this.recoveryDelayMs);
      } else this.report('connecting', '正在建立加密画面连接…');
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
    channel.onopen = () => { if (current()) this.connected(); };
    channel.onclose = () => { transport.dispose(); if (current()) { this.report('disconnected', '数据通道已关闭，正在恢复…'); this.scheduleMediaRecovery(); } };
    channel.onerror = () => { transport.dispose(); if (current()) { this.report('disconnected', '数据通道发生错误，正在恢复…'); this.scheduleMediaRecovery(); } };
    channel.onmessage = event => {
      if (current()) transport.receive(event.data);
    };
  }

  connected() {
    clearTimeout(this.negotiationTimer); this.negotiationTimer = null;
    clearTimeout(this.recoveryTimer); this.recoveryTimer = null;
    this.mediaAttempts = 0;
    this.report('connected', 'P2P 已加密直连');
  }

  async maybeOffer() {
    if (this.role !== 'desktop' || !this.peerPresent || this.awaitingApproval || !this.localStream || this.offerPending) return;
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
      this.armNegotiationTimeout();
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

  send(message, options) {
    if (!this.transport) return Promise.reject(new Error('P2P 数据通道尚未就绪'));
    return this.transport.send(message, options);
  }

  approvePeer(allow) {
    if (this.role !== 'desktop' || !this.awaitingApproval) return;
    this.sendSignal({ type: 'approve', allow: Boolean(allow) });
    if (!allow) { this.awaitingApproval = false; this.report('waiting', '已拒绝手机连接，等待新的配对请求…'); }
  }

  resetPeer(keepPeer = false) {
    clearTimeout(this.negotiationTimer); this.negotiationTimer = null;
    clearTimeout(this.recoveryTimer); this.recoveryTimer = null;
    this.epoch += 1;
    this.initializing?.controller.abort();
    this.initializing = null;
    this.transport?.dispose();
    this.transport = null;
    const oldPc = this.pc, oldChannel = this.channel;
    this.pc = null;
    this.channel = null;
    oldPc?.close();
    oldChannel?.close();
    if (!keepPeer) { this.peerPresent = false; this.awaitingApproval = false; }
    this.offerPending = false;
    this.pendingCandidates = [];
    this.remoteStream = new MediaStream();
    this.onStream(this.remoteStream);
  }

  disconnect() {
    this.closed = true;
    this.reconnectToken = '';
    clearTimeout(this.retryTimer); this.retryTimer = null;
    globalThis.window?.removeEventListener?.('online', this.onlineHandler);
    this.signal?.close();
    this.signal = null;
    this.resetPeer();
    this.phase = 'idle';
  }
}
