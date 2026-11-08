import './styles.css';
import './pairing.css';
import './screenshot.css';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { PeerSession } from './peer-session.js';
import { askModel } from './llm.js';
import { MeetingEngine } from './meeting-engine.js';
import { PrompterPublisher, PrompterReceiver } from './prompter-sync.js';
import { setupKnowledge } from './knowledge-ui.js';
import { defaultRoleForPlatform } from './platform.js';
import { createPairingCode, parsePairingCode, checkSignaling, scanFailureMessage } from './pairing.js';
import { cropCanvas, screenshotPayload } from './screenshot.js';
import { selectScreenshotRegion } from './screenshot-region.js';
import { connectionDiagnostics } from './diagnostics.js';
import { RELEASES_URL, checkLatestRelease, updateMessage } from './updates.js';
import { DEFAULT_SHORTCUTS, validateShortcuts, shortcutForEvent } from './shortcuts.js';
import { OfflineVoiceInput } from './voice-input.js';

const $ = id => document.getElementById(id);
const state = {
  role: 'desktop', peer: null, displayStream: null, outgoingStream: null, recognition: null,
  voiceActive: false, voiceBuffer: '', voiceTimer: null, requestCount: 0,
  latestImage: '', chatHistory: [], lastAnswer: '', toastTimer: null, lanAddresses: [],
  captureGeneration: 0, room: '', pendingCapture: null, approvedPhone: false,
  modelQueue: Promise.resolve(), modelPending: 0, nativeSignalBase: '',
  pairingGeneration: 0,
  retryRequest: null, configController: null, configGeneration: 0,
  screenshotController: null, screenshotGeneration: 0, screenshotBusy: false,
  captureSwitchPending: false,
  pages: { desktop: 'pair', mobile: 'pair' }, shortcuts: { ...DEFAULT_SHORTCUTS }, shortcutsEnabled: false,
  typingRequest: null, typingBusy: false, typingGeneration: 0,
  selectionGeneration: 0,
  voiceInput: null, voiceGeneration: 0, manualReading: false,
  speechInfo: null, speechUpdating: false,
};
const meeting = new MeetingEngine({
  ask: askModel,
  configuration: () => ({ endpoint: $('llm-endpoint').value.trim(), apiKey: $('llm-key').value, model: $('llm-model').value.trim() }),
  retrieve: async (question, previousQuestion, signal) => {
    if (!window.desktopBridge?.knowledgeSearch) return null;
    try {
      const result = await window.desktopBridge.knowledgeSearch({ question, previousQuestion });
      signal.throwIfAborted();
      $('knowledge-route').textContent = result.reason;
      return result;
    } catch (error) {
      signal.throwIfAborted();
      $('knowledge-route').textContent = '知识库暂时无法读取，本次按通用知识回答'; return null;
    }
  },
  onChange: () => {
    state.modelPending = meeting.pending; state.lastAnswer = meeting.lastAnswer;
    state.chatHistory = meeting.history; state.retryRequest = meeting.retry;
    updateModelQueue(); publisher.changed();
  },
});
const publisher = new PrompterPublisher({ snapshot: () => meeting.snapshot(), onDelivery: updateModelQueue,
  send: message => state.peer?.phase === 'connected' ? state.peer.send(message) : Promise.reject(new Error('连接未就绪')) });
const receiver = new PrompterReceiver({ render: renderPrompter });
let connectedPeer = null;
const preferenceKey = 'pairo.preferences.v1';
const saved = readPreferences();
const initialRole = defaultRoleForPlatform(Capacitor.getPlatform());
const defaultBase = initialRole === 'mobile' ? ''
  : window.desktopBridge ? 'http://127.0.0.1:8787'
  : location.hostname === 'localhost' || location.hostname === '127.0.0.1'
    ? location.protocol + '//' + location.hostname + ':8787'
    : location.port === '5173'
      ? location.protocol + '//' + location.hostname + ':8787'
      : location.origin;

function readPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(['signalBase', 'endpoint', 'model'].filter(key => typeof value[key] === 'string').map(key => [key, value[key]]));
  } catch { return {}; }
}
function endpointPreference(value) {
  try {
    const url = new URL(value);
    return url.username || url.password || [...url.searchParams.keys()].some(key => /key|token|secret|authorization|credential|signature/i.test(key)) ? '' : value;
  } catch { return ''; }
}
function savePreferences() {
  const signalBase = $(state.role === 'desktop' ? 'desktop-signal' : 'mobile-signal').value.trim();
  const preferences = {
    signalBase: window.desktopBridge && signalBase === state.nativeSignalBase ? '' : signalBase,
    endpoint: endpointPreference($('llm-endpoint').value.trim()),
    model: $('llm-model').value.trim(),
  };
  try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch { /* private browsing */ }
  window.desktopBridge?.writePreferences(preferences).catch(() => toast('设置保存失败，请检查配置目录权限'));
}

function resetConversation() {
  state.selectionGeneration += 1;
  invalidateTyping();
  cancelScreenshot();
  meeting.clear();
  if (state.role === 'mobile') receiver.disconnect();
  state.retryRequest = null;
  updateModelQueue();
  state.latestImage = '';
  state.chatHistory = [];
  state.lastAnswer = ''; state.manualReading = false;
  $('send-button').disabled = false;
  $('message-list').querySelectorAll('.prompter-entry, .chat-message').forEach(node => node.remove());
  $('conversation-empty').hidden = false;
  $('attachment-strip').hidden = true;
  $('attachment-thumb').removeAttribute('src');
  $('desktop-answer').textContent = '';
  $('desktop-question').textContent = '';
  $('desktop-question').hidden = true;
  $('desktop-question-empty').hidden = false;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function cancelScreenshot() {
  state.screenshotGeneration += 1;
  state.screenshotController?.abort();
  state.screenshotController = null;
  state.screenshotBusy = false;
  $('shot-progress').hidden = true;
  $('take-shot').disabled = !state.displayStream;
  $('take-region-shot').disabled = !state.displayStream;
}

function updateModelQueue() {
  const latest = meeting.entries.at(-1);
  let status = meeting.pending ? `正在处理 ${meeting.pending} 个问题` : (latest?.error || '没有待处理问题');
  if (!meeting.pending && latest?.status === 'complete') {
    const delivery = publisher.delivery(meeting.session, latest.id);
    const detail = state.peer?.phase !== 'connected' ? '待连接手机' :
      delivery === 'sent' ? '已发送 · 手机接收未确认' :
      delivery === 'failed' ? '发送失败 · 等待手机重新同步' : '待发送至手机';
    status = '回答已完成 · ' + detail;
  }
  $('model-queue-status').textContent = status;
  $('cancel-model').hidden = meeting.pending === 0;
  $('retry-model').hidden = !meeting.retry;
  $('retry-model').disabled = meeting.pending > 0;
  $('send-button').disabled = meeting.pending >= 8;
}
function cancelModelRequests(showMessage = true) {
  invalidateTyping(); meeting.cancel();
  if (showMessage) toast('已取消等待；服务商已接收的请求仍可能计入用量');
}
function renderPrompter(snapshot) {
  const list = $('message-list');
  const present = new Set(snapshot.entries.map(e => e.id));
  for (const node of list.querySelectorAll('[data-request-id]')) if (!present.has(node.dataset.requestId)) node.remove();
  $('conversation-empty').hidden = snapshot.entries.length > 0;
  for (const entry of snapshot.entries) {
    let node = [...list.querySelectorAll('[data-request-id]')].find(n => n.dataset.requestId === entry.id);
    if (!node) {
      node = document.createElement('div'); node.dataset.requestId = entry.id;
      node.className = 'prompter-entry';
      for (const className of ['chat-message incoming', 'chat-message answer', 'hint']) {
        const child = document.createElement('div'); child.className = className; node.append(child);
      }
      list.append(node);
    }
    node.children[0].textContent = entry.question;
    node.children[1].textContent = entry.text || ({ queued: '等待电脑回答…', generating: '电脑正在回答…', cancelled: '已取消', failed: '回答失败' }[entry.status] || '');
    node.children[1].dataset.status = entry.status;
    node.children[2].textContent = (entry.error || ({ queued: '已排队', generating: '回答中 · 尚未完成', complete: '回答完成', cancelled: '已取消 · 尚未完成', failed: '失败 · 尚未完成' }[entry.status])) + (entry.sources.length ? '\n参考：' + entry.sources.join('、') : '');
  }
  if (snapshot.entries.length) navigatePage('mobile', 'chat');
  $('prompter-status').textContent = '已同步 · 仅在电脑提问';
  if (!state.manualReading) list.scrollTop = list.scrollHeight;
}

function resetMobileMedia() {
  $('join-room').disabled = false;
  $('leave-room').hidden = true;
  $('reconnect-room').hidden = true;
  attachRemoteStream(null);
  $('remote-audio').muted = true;
}
function toast(message) {
  if (state.role === 'desktop') { $('desktop-activity').textContent = message; return; }
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove('show'), 3000);
}
function setStatus(role, message, connected = false) {
  const text = $(role + '-status');
  const dot = $(role + '-dot');
  if (text) text.textContent = message;
  if (dot) dot.classList.toggle('connected', connected);
  $('top-status').textContent = connected ? 'P2P 已连接' : message;
  $('top-status').previousElementSibling.classList.toggle('connected', connected);
}
function setRole(role) {
  if (state.role === role) return;
  endSession(false);
  state.role = role;
  navigatePage(role, state.pages[role]);
  $('desktop-view').hidden = role !== 'desktop';
  $('mobile-view').hidden = role !== 'mobile';
  $('desktop-tab').classList.toggle('active', role === 'desktop');
  $('mobile-tab').classList.toggle('active', role === 'mobile');
  $('desktop-tab').setAttribute('aria-selected', String(role === 'desktop'));
  $('mobile-tab').setAttribute('aria-selected', String(role === 'mobile'));
}
function randomRoomCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => alphabet[value % alphabet.length]).join('');
}
function setFeedActive(active) {
  void syncShortcuts();
  const starting = !active && Boolean(state.pendingCapture);
  $('meeting-mode').disabled = active || starting;
  $('capture-mic').disabled = active || starting || $('meeting-mode').value === 'one-to-one';
  $('capture-system-audio').disabled = active || starting || $('meeting-mode').value === 'one-to-one';
  $('local-empty').hidden = active;
  $('local-preview').classList.toggle('visible', active);
  $('desktop-feed-status').textContent = active ? (state.peer?.phase === 'connected' ? '正在分享' : '等待手机配对') : state.room ? '共享已停止 · 房间保留' : '未分享';
  $('desktop-feed-status').classList.toggle('live', active);
  $('take-shot').disabled = !active;
  $('take-region-shot').disabled = !active;
  $('toggle-voice').disabled = !active;
  $('stop-share').disabled = !active && !starting;
  $('start-share').disabled = active || starting;
  $('change-share').disabled = !active || state.captureSwitchPending;
}
function makePeer(role) {
  const peer = new PeerSession({
    role,
    onStatus: message => {
      if (state.peer !== peer) return;
      if (peer.phase === 'connected' && connectedPeer !== peer) {
        connectedPeer = peer;
        if (role === 'mobile') void peer.send(receiver.connect()).catch(() => {});
      } else if (peer.phase !== 'connected' && connectedPeer === peer) {
        connectedPeer = null; publisher.disconnected(); receiver.disconnect();
        if (role === 'mobile') $('prompter-status').textContent = '连接中断 · 以下为上次内容，等待重新同步';
      }
      if (peer.phase !== 'connected') state.selectionGeneration += 1;
      if (role === 'desktop' && peer.phase !== 'connected' && state.typingBusy) invalidateTyping();
      if (role === 'desktop' && peer.phase !== 'connected' && state.voiceActive) stopVoice();
      if (!peer.awaitingApproval) $('pairing-approval').hidden = true;
      if (role === 'desktop') $('reconnect-desktop').hidden = !['failed', 'disconnected', 'reconnecting'].includes(peer.phase);
      setStatus(role, message, peer.phase === 'connected');
      if (role === 'desktop') updateModelQueue();
      if (role === 'desktop' && state.displayStream) $('desktop-feed-status').textContent = peer.phase === 'connected' ? '正在分享' : '等待手机配对';
      if (role === 'mobile') $('reconnect-room').hidden = !['failed', 'disconnected', 'reconnecting'].includes(peer.phase);
      if (role === 'mobile' && peer.phase === 'connected') toast('两台设备已建立加密直连');
    },
    onMessage: message => state.peer === peer ? (role === 'mobile' ? handleMobileMessage(message) : handleDesktopMessage(message)) : undefined,
    onStream: (stream, sharing) => state.peer === peer && role === 'mobile' ? attachRemoteStream(stream, sharing) : null,
    onRoomEnded: () => {
      if (state.peer !== peer || role !== 'mobile') return;
      endSession(false);
      setStatus('mobile', '电脑已结束会话');
      $('prompter-status').textContent = '电脑已结束会话，请重新配对';
    },
    onPeerLeft: () => {
      if (state.peer !== peer) return;
      stopVoice(false); invalidateTyping(); publisher.disconnected(); receiver.disconnect(); connectedPeer = null;
      if (role === 'mobile') $('prompter-status').textContent = '连接中断 · 以下为上次内容，等待重新同步';
    },
    onApproval: () => { if (state.peer === peer && role === 'desktop') $('pairing-approval').hidden = false; },
  });
  return peer;
}

async function dispatchDesktopHotkey(action) {
  if (state.role !== 'desktop' || !state.displayStream) return;
  if (action === 'screenshot') void takeScreenshot(false, true);
  if (action === 'voice') state.voiceActive ? stopVoice(true) : startVoice();
  if (action === 'text') {
    const peer = state.peer, generation = state.selectionGeneration;
    if (peer?.phase !== 'connected') return toast('请先等待手机连接成功');
    if (!window.desktopBridge?.copySelection) return toast('选中文字需要 Windows 桌面程序');
    try {
      const selection = await window.desktopBridge.copySelection();
      if (peer !== state.peer || generation !== state.selectionGeneration || peer.phase !== 'connected') return;
      await sendDesktopQuestion(selection);
    } catch (error) { toast(error.message); }
  }
  if (action === 'type-answer') await requestAnswerTyping();
  if (action === 'scroll-up' || action === 'scroll-down') {
    try { await state.peer.send({ type: 'control', action }); }
    catch (error) { toast(error.message); }
  }
}

function invalidateTyping() {
  state.typingGeneration += 1;
  clearTimeout(state.typingRequest?.timer);
  state.typingRequest = null; state.typingBusy = false;
  void window.desktopBridge?.cancelTyping?.().catch(() => {});
}
async function requestAnswerTyping() {
  if (state.typingBusy) { invalidateTyping(); return toast('已停止回答键入'); }
  const bridge = window.desktopBridge, peer = state.peer;
  if (!bridge?.prepareTyping) return toast('回答键入需要 Windows 桌面程序');
  if (peer?.phase !== 'connected') return toast('请先等待手机连接成功');
  const text = meeting.lastAnswer;
  if (meeting.pending || !text) return toast('没有可键入的最新完整回答，请等待完成或重新提问');
  const generation = ++state.typingGeneration;
  state.typingBusy = true;
  try {
    const token = await bridge.prepareTyping();
    if (generation !== state.typingGeneration || peer !== state.peer || text !== meeting.lastAnswer || meeting.pending) return;
    if (token) await bridge.typeAnswer({ token, text });
  } catch (error) { if (generation === state.typingGeneration) toast(error.message); }
  finally { if (generation === state.typingGeneration) { state.typingBusy = false; void bridge.cancelTyping?.().catch(() => {}); } }
}

async function loadDesktopSignalInfo(refresh = false) {
  if (!window.desktopBridge) return;
  try {
    const info = await window.desktopBridge.getSignalInfo();
    state.nativeSignalBase = info.signalBase;
    const preferences = refresh ? {} : await window.desktopBridge.readPreferences();
    if ($('desktop-signal').value === (saved.signalBase || defaultBase)) $('desktop-signal').value = preferences.signalBase || info.signalBase;
    if ($('mobile-signal').value === (saved.signalBase || defaultBase)) $('mobile-signal').value = preferences.signalBase || info.signalBase;
    if ($('llm-endpoint').value === (saved.endpoint || 'https://api.openai.com/v1/chat/completions')) $('llm-endpoint').value = preferences.endpoint || $('llm-endpoint').value;
    if ($('llm-model').value === (saved.model || 'gpt-4o-mini')) $('llm-model').value = preferences.model || $('llm-model').value;
    state.lanAddresses = info.lanAddresses || [];
    const select = $('desktop-lan-select');
    const previous = select.value;
    select.innerHTML = '';
    for (const item of state.lanAddresses) {
      const option = document.createElement('option');
      option.value = item.url;
      option.textContent = item.interface + ' · ' + item.ip;
      select.append(option);
    }
    select.value = state.lanAddresses.some(item => item.url === previous) ? previous : state.lanAddresses[0]?.url || '';
    $('desktop-lan-addresses').textContent = select.value || '未检测到局域网 IPv4 地址';
    $('desktop-lan-info').hidden = false;
    void refreshPairingQr();
  } catch (error) { toast('读取局域网配对地址失败：' + error.message); }
}

function pairingAddress() {
  const configured = $('desktop-signal').value.trim();
  return configured === state.nativeSignalBase ? $('desktop-lan-select').value : configured;
}

async function refreshPairingQr() {
  const generation = ++state.pairingGeneration;
  $('pairing-qr').hidden = true;
  $('pairing-qr-image').removeAttribute('src');
  if (!state.room) return;
  try {
    const payload = createPairingCode(pairingAddress(), state.room);
    const { default: QRCode } = await import('qrcode');
    const image = await QRCode.toDataURL(payload, { width: 240, margin: 3, errorCorrectionLevel: 'M' });
    if (generation !== state.pairingGeneration || !state.room) return;
    $('pairing-qr-image').src = image;
    $('pairing-qr').hidden = false;
  } catch { /* Manual pairing remains available when no phone-reachable address exists. */ }
}

async function scanPairing() {
  if (state.role !== 'mobile') return;
  const generation = state.captureGeneration;
  $('scan-pairing').disabled = true;
  try {
    const { CapacitorBarcodeScanner } = await import('@capacitor/barcode-scanner');
    const result = await CapacitorBarcodeScanner.scanBarcode({ hint: 0, cameraDirection: 1, scanInstructions: '对准电脑上的 PAIRO 配对二维码', scanButton: false, android: { scanningLibrary: 'zxing' }, web: { showCameraSelection: true }, cancelButtonAccessibilityLabel: '取消扫码' });
    if (state.role !== 'mobile' || generation !== state.captureGeneration || !result.ScanResult) return;
    const data = parsePairingCode(result.ScanResult);
    $('mobile-signal').value = data.signalBase;
    $('mobile-room').value = data.room;
    $('pairing-hint').textContent = '已填入配对信息，请核对电脑地址后点击“连接”。';
  } catch (error) {
    if (state.role !== 'mobile' || generation !== state.captureGeneration) return;
    $('pairing-hint').textContent = scanFailureMessage(error);
  } finally { $('scan-pairing').disabled = false; }
}

function captureNotSelected(error) {
  return error?.name === 'NotAllowedError' || error?.name === 'AbortError'
    || Boolean(window.desktopBridge && error?.message === 'Invalid capture constraints');
}

async function startDesktop() {
  if (state.role !== 'desktop' || state.displayStream || state.pendingCapture) return;
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('当前浏览器不支持屏幕分享，请使用桌面 Chromium 浏览器');
    return;
  }
  const generation = ++state.captureGeneration;
  const current = () => state.role === 'desktop' && generation === state.captureGeneration;
  const pending = state.pendingCapture = new Set();
  setFeedActive(false);
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 12, max: 20 } },
      audio: $('meeting-mode').value === 'one-to-one' || $('capture-system-audio').checked,
    });
    if (!current()) { display.getTracks().forEach(track => track.stop()); return; }
    display.getTracks().forEach(track => pending.add(track));
    const video = display.getVideoTracks()[0];
    if (!video || video.readyState === 'ended') throw new Error('没有可分享的画面');
    video.addEventListener('ended', () => { if (current() && (state.pendingCapture === pending || state.displayStream === display)) stopCapture(); }, { once: true });
    if ($('capture-mic').checked && $('meeting-mode').value !== 'one-to-one') {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (!current()) { mic.getTracks().forEach(track => track.stop()); return; }
        mic.getAudioTracks().forEach(track => pending.add(track));
        mic.getVideoTracks().forEach(track => track.stop());
      } catch (error) {
        if (!current()) return;
        toast('未启用麦克风：' + (error.name === 'NotAllowedError' ? '权限被拒绝' : '设备不可用'));
      }
    }
    if (!current()) return;
    const outgoing = new MediaStream([...pending]), existing = state.peer;
    const peer = existing || makePeer('desktop');
    if (!await peer.replaceLocalStream(outgoing) || !current()) return;
    state.displayStream = display;
    state.outgoingStream = outgoing;
    state.pendingCapture = null;
    pending.clear();
    $('local-preview').srcObject = display;
    if (!existing) {
      state.peer = peer;
      state.room = randomRoomCode();
      $('room-code').textContent = state.room;
      $('copy-code').disabled = false;
      $('desktop-signal').disabled = true;
      $('end-session').disabled = false;
      void refreshPairingQr();
    }
    setFeedActive(true);
    if (video.readyState === 'ended') stopCapture();
    if (existing) toast('已在原房间恢复共享');
    else {
      try {
        await peer.connect($('desktop-signal').value, state.room);
        if (state.peer === peer && current()) toast('配对信息已生成，可在手机端扫码或手动输入');
      } catch (error) {
        if (state.peer !== peer) return;
        endSession(false);
        const message = error.message || '无法进入房间';
        setStatus('desktop', message); toast(message);
      }
    }
  } catch (error) {
    if (!current()) return;
    const message = !pending.size && !state.displayStream && captureNotSelected(error)
      ? '屏幕分享未开始，请重试并选择要分享的屏幕或窗口。' : error.message || '无法开启屏幕分享';
    if (!state.room) setStatus('desktop', message);
    toast(message);
  } finally {
    for (const track of pending) track.stop();
    if (state.pendingCapture === pending) { state.pendingCapture = null; setFeedActive(Boolean(state.displayStream)); }
  }
}

function stopCapture(showToast = true, detach = true) {
  state.captureGeneration += 1;
  state.captureSwitchPending = false;
  state.selectionGeneration += 1;
  invalidateTyping();
  stopVoice();
  const tracks = new Set([...(state.outgoingStream?.getTracks() || []), ...(state.displayStream?.getTracks() || []), ...(state.pendingCapture || [])]);
  state.displayStream = null;
  state.outgoingStream = null;
  state.pendingCapture?.clear();
  state.pendingCapture = null;
  for (const track of tracks) track.stop();
  cancelScreenshot();
  $('local-preview').srcObject = null;
  setFeedActive(false);
  if (detach) void state.peer?.replaceLocalStream(null).catch(() => {});
  if (showToast) toast(state.room ? '已停止采集，配对与提词保留' : '桌面分享已停止');
}

function endSession(showToast = true) {
  const peer = state.peer;
  state.peer = null;
  state.room = '';
  state.approvedPhone = false;
  stopCapture(false, false);
  peer?.disconnect();
  connectedPeer = null;
  publisher.disconnected();
  resetConversation();
  resetMobileMedia();
  $('room-code').textContent = '等待分享';
  $('copy-code').disabled = true;
  $('desktop-signal').disabled = false;
  $('end-session').disabled = true;
  $('pairing-approval').hidden = true;
  $('reconnect-desktop').hidden = true;
  void refreshPairingQr();
  setStatus(state.role, '尚未连接');
  if (showToast) toast('会话已结束');
}

async function changeDesktopCapture() {
  if (!state.displayStream || !state.peer || state.captureSwitchPending || state.screenshotBusy) return;
  const generation = state.captureGeneration, peer = state.peer, previous = state.displayStream;
  const current = () => state.role === 'desktop' && generation === state.captureGeneration && state.peer === peer;
  const pending = state.pendingCapture = new Set();
  let display, accepted = false;
  state.captureSwitchPending = true; $('change-share').disabled = true;
  $('take-shot').disabled = true; $('take-region-shot').disabled = true;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 12, max: 20 } }, audio: previous.getAudioTracks().length > 0 });
    if (!current()) return;
    display.getTracks().forEach(track => pending.add(track));
    const video = display.getVideoTracks()[0];
    if (!video || video.readyState === 'ended') throw new Error('没有可分享的画面');
    const retained = state.outgoingStream.getTracks().filter(track => !previous.getTracks().includes(track));
    const outgoing = new MediaStream([...display.getTracks(), ...retained]);
    if (await peer.replaceLocalStream(outgoing) === false || !current()) return;
    const resumeVoice = state.voiceActive;
    if (resumeVoice) stopVoice(false);
    state.displayStream = display; state.outgoingStream = outgoing; accepted = true;
    $('local-preview').srcObject = display;
    video.addEventListener('ended', () => { if (current() && state.displayStream === display) stopCapture(); }, { once: true });
    previous.getTracks().forEach(track => track.stop());
    if (video.readyState === 'ended') { stopCapture(); return; }
    if (resumeVoice) void startVoice();
    toast('共享内容已更换，手机配对与声音设置保持不变');
  } catch (error) {
    if (current()) toast(captureNotSelected(error) ? '未更换共享内容，继续分享原来的画面' : '更换未完成：' + error.message);
  } finally {
    if (!accepted) display?.getTracks().forEach(track => track.stop());
    if (current()) {
      state.pendingCapture = null;
      state.captureSwitchPending = false;
      $('change-share').disabled = !state.displayStream;
      $('take-shot').disabled = !state.displayStream; $('take-region-shot').disabled = !state.displayStream;
    }
  }
}

async function takeScreenshot(region = false) {
  if (state.role !== 'desktop') return;
  const video = $('local-preview');
  if (!video.videoWidth || !video.videoHeight) return toast('画面尚未准备好，请稍后重试');
  if (state.screenshotBusy || state.captureSwitchPending) return toast('请等待上次截图或窗口选择完成');
  const generation = state.screenshotGeneration;
  const controller = state.screenshotController = new AbortController();
  state.screenshotBusy = true; $('take-shot').disabled = true; $('take-region-shot').disabled = true;
  try {
    const canvas = region ? await selectScreenshotRegion(video, controller.signal) : cropCanvas(video);
    if (!canvas || generation !== state.screenshotGeneration) return;
    let payload;
    try { payload = screenshotPayload(canvas); } finally { canvas.width = 0; canvas.height = 0; }
    void submitQuestion($('screenshot-question').value.trim().slice(0, 500) || '请回答图中的问题。', payload.image);
    toast('截图已交给电脑模型处理');
  } catch (error) { if (!controller.signal.aborted) toast(error.message || '截图处理失败'); }
  finally { if (generation === state.screenshotGeneration) { state.screenshotBusy = false; state.screenshotController = null; $('take-shot').disabled = !state.displayStream; $('take-region-shot').disabled = !state.displayStream; } }
}

async function startVoice() {
  if (!state.peer || state.peer.phase !== 'connected') return toast('请先等待手机连接成功');
  if (!window.desktopBridge?.transcribeAudio) return toast('离线转写需要 Windows 桌面程序');
  if (state.voiceActive) return;
  if (state.speechUpdating) return toast('请等待离线语音设置或下载完成');
  const generation = ++state.voiceGeneration, peer = state.peer;
  state.voiceActive = true;
  updateSpeechControls();
  try {
    const status = await window.desktopBridge.speechStatus();
    if (generation !== state.voiceGeneration) return;
    state.speechInfo = status; updateSpeechControls();
    if (!status.ready) throw new Error('请先在快捷键设置中下载所选的离线语音组件');
    const tracks = state.outgoingStream?.getAudioTracks().filter(track => track.readyState === 'live') || [];
    if (!tracks.length) throw new Error('没有可用音频，请重新分享并启用所需音频来源');
    const input = new OfflineVoiceInput({
      transcribe: (pcm, source) => window.desktopBridge.transcribeAudio(pcm, source),
      onText: text => { if (generation === state.voiceGeneration && state.peer === peer && peer.phase === 'connected') void sendDesktopQuestion(text); },
      onStatus: text => { if (generation === state.voiceGeneration) toast(text); },
      onError: error => { if (generation === state.voiceGeneration) { stopVoice(false); toast(error.message || '离线转写失败'); } },
    });
    state.voiceInput = input;
    await input.start(tracks.map(track => ({ track, source: state.displayStream?.getAudioTracks().includes(track) ? 'system' : 'microphone' })));
    if (generation !== state.voiceGeneration) { await input.stop(); return; }
    $('toggle-voice').classList.add('listening');
    $('toggle-voice').firstChild.textContent = '● 停止离线语音 ';
    toast('本机离线转写中');
    void peer.send({ type: 'notice', text: $('meeting-mode').value === 'one-to-one' ? '系统声音离线转写已开启，问题会持续自动提交。' : '麦克风与系统声音离线转写已开启，问题会自动提交。' }).catch(() => {});
  } catch (error) { if (generation === state.voiceGeneration) { stopVoice(false); toast(error.message); } }
}
function stopVoice() {
  const wasActive = state.voiceActive;
  state.voiceGeneration += 1; state.voiceActive = false;
  updateSpeechControls();
  const input = state.voiceInput; state.voiceInput = null;
  void input?.stop().catch(() => {});
  void window.desktopBridge?.cancelTranscription?.().catch(() => {});
  $('toggle-voice').classList.remove('listening');
  $('toggle-voice').firstChild.textContent = '◖ 离线语音输入 ';
  if (wasActive && state.peer?.phase === 'connected') void state.peer.send({ type: 'notice', text: '语音输入已停止，未完成的转写已取消。' }).catch(() => {});
}
async function sendDesktopQuestion(value) {
  const text = String(value || '').trim().slice(0, 12000);
  if (!text || state.role !== 'desktop') return;
  return submitQuestion(text, '');
}
async function handleDesktopMessage(message) {
  if (message.type === 'prompter-ready') publisher.ready(message);
}
function attachRemoteStream(stream, sharing = null) {
  const video = $('remote-preview');
  const audio = $('remote-audio');
  const hasVideo = Boolean(stream?.getVideoTracks().some(track => track.readyState === 'live'));
  const preview = hasVideo ? stream : null;
  if (video.srcObject !== preview) video.srcObject = preview;
  const audioTracks = hasVideo ? stream.getAudioTracks() : [];
  const previousAudio = audio.srcObject?.getTracks() || [];
  if (audioTracks.length !== previousAudio.length || audioTracks.some((track, index) => previousAudio[index] !== track)) {
    audio.srcObject = audioTracks.length ? new MediaStream(audioTracks) : null;
    if (!audio.muted && audioTracks.length && $('live-monitor').open) void audio.play().catch(() => {});
  }
  $('remote-empty').hidden = hasVideo;
  video.classList.toggle('visible', hasVideo);
  $('remote-empty-title').textContent = sharing === false ? '电脑已停止共享' : '等待桌面画面';
  $('remote-empty-detail').textContent = sharing === false ? '房间保持连接，电脑恢复分享后会显示画面' : '连接后实时接收，不在信令服务器留存';
  $('enable-audio').disabled = !audioTracks.length;
  $('media-hint').textContent = sharing === false ? '共享声音已停止' : audioTracks.length ? '音频已接收 · 点击播放' : '当前没有收到音频轨道';
}
async function handleMobileMessage(message) {
  if (receiver.receive(message)) return;
  if (message.type === 'control' && ['scroll-up', 'scroll-down'].includes(message.action)) {
    navigatePage('mobile', 'chat'); state.manualReading = true;
    $('message-list').scrollBy({ top: (message.action === 'scroll-up' ? -1 : 1) * $('message-list').clientHeight * 0.65, behavior: 'auto' });
  }
}
async function submitQuestion(question, image = '') {
  if (state.role !== 'desktop') return;
  invalidateTyping();
  try {
    const request = meeting.submit(question, image);
    state.modelQueue = meeting.tail;
    $('desktop-question-empty').hidden = true;
    $('desktop-question').hidden = false; $('desktop-question').textContent = question;
    $('request-count').textContent = String(++state.requestCount);
    return await request;
  } catch (error) { toast(error.message); }
}

function navigatePage(role, page) {
  const pages = role === 'desktop' ? ['pair', 'source', 'keys', 'assistant', 'knowledge'] : ['pair', 'chat'];
  if (!pages.includes(page)) return;
  state.pages[role] = page;
  $('app-shell')?.classList.toggle('reading-mode', state.role === 'mobile' && page === 'chat');
  for (const key of pages) {
    $(role + '-' + key + '-page').hidden = key !== page;
    const button = $(role + '-nav-' + key);
    if (key === page) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}

function renderShortcutSettings() {
  for (const action of Object.keys(DEFAULT_SHORTCUTS)) $('key-' + action).value = state.shortcuts[action];
  $('shortcuts-enabled').checked = state.shortcutsEnabled;
}
async function syncShortcuts(save = false) {
  try {
    const result = await window.desktopBridge?.configureShortcuts?.({ bindings: state.shortcuts, enabled: state.shortcutsEnabled, active: Boolean(state.displayStream) && state.role === 'desktop', save });
    if (result) { state.shortcuts = result.bindings; state.shortcutsEnabled = result.enabled; }
    $('shortcut-status').textContent = state.shortcutsEnabled
      ? (state.displayStream ? '快捷键已启用；方向键用于手机阅读。' : '已启用，开始分享后占用按键，结束后释放。') : '快捷键未启用，不占用其他程序按键。';
    if (save && !window.desktopBridge) localStorage.setItem('pairo.shortcuts.v1', JSON.stringify({ bindings: state.shortcuts, enabled: state.shortcutsEnabled }));
    return true;
  } catch (error) {
    const previous = await window.desktopBridge?.getShortcuts?.().catch(() => null);
    if (previous) { state.shortcuts = previous.bindings; state.shortcutsEnabled = previous.enabled; }
    renderShortcutSettings(); $('shortcut-status').textContent = error.message || '快捷键注册失败';
    return false;
  }
}
async function loadWorkspaceSettings() {
  try {
    const saved = window.desktopBridge?.getShortcuts ? await window.desktopBridge.getShortcuts() : JSON.parse(localStorage.getItem('pairo.shortcuts.v1') || 'null');
    if (saved) { state.shortcuts = validateShortcuts(saved.bindings); state.shortcutsEnabled = saved.enabled === true; }
    renderShortcutSettings();
    const typing = await window.desktopBridge?.readTypingSettings?.();
    if (typing) { $('typing-chinese').value = typing.chineseCpm; $('typing-english').value = typing.englishWpm; }
    state.speechInfo = await window.desktopBridge?.speechStatus?.();
    updateSpeechControls();
  } catch { $('shortcut-status').textContent = '设置读取失败，当前使用默认按键；请重新保存。'; }
}
for (const [role, pages] of Object.entries({ desktop: ['pair', 'source', 'keys', 'assistant', 'knowledge'], mobile: ['pair', 'chat'] })) {
  for (const page of pages) $(role + '-nav-' + page).addEventListener('click', () => navigatePage(role, page));
}
$('shortcut-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    state.shortcuts = validateShortcuts(Object.fromEntries(Object.keys(DEFAULT_SHORTCUTS).map(action => [action, $('key-' + action).value])));
    await syncShortcuts(true);
  } catch (error) { $('shortcut-status').textContent = error.message; }
});
$('reset-shortcuts').addEventListener('click', async () => { state.shortcuts = { ...DEFAULT_SHORTCUTS }; renderShortcutSettings(); await syncShortcuts(true); });
$('shortcuts-enabled').addEventListener('change', async () => { state.shortcutsEnabled = $('shortcuts-enabled').checked; await syncShortcuts(true); });
$('background-mode').addEventListener('click', async () => {
  if (!window.desktopBridge?.hideToTray) return toast('后台托盘仅在 Windows 程序中可用');
  try { await window.desktopBridge.hideToTray(); } catch (error) { toast(error.message); }
});
$('meeting-mode').addEventListener('change', () => {
  const single = $('meeting-mode').value === 'one-to-one';
  $('capture-mic').checked = !single; $('capture-mic').disabled = single;
  $('capture-system-audio').checked = true; $('capture-system-audio').disabled = single;
});
function updateSpeechControls(message = '') {
  const info = state.speechInfo;
  const disabled = state.voiceActive || state.speechUpdating || !info?.supported;
  for (const [id, key] of [['speech-language', 'language'], ['speech-profile', 'profile']]) {
    $(id).disabled = disabled;
    if (info?.settings && !state.speechUpdating) $(id).value = info.settings[key];
  }
  $('install-speech').disabled = disabled || info?.ready;
  $('speech-status').textContent = message || (info?.ready ? '离线组件已就绪 · 本机转写' :
    info?.supported ? `此档还需下载约 ${Math.ceil(info.downloadBytes / 1000000)} MB` : '在 Windows x64 桌面程序中使用');
}
async function updateSpeech(operation, working) {
  if (state.speechUpdating || state.voiceActive) return;
  state.speechUpdating = true; updateSpeechControls(working);
  let errorMessage = '';
  try { state.speechInfo = await operation(); }
  catch (error) { errorMessage = error.message || '离线语音设置未完成，可稍后重试'; }
  finally { state.speechUpdating = false; updateSpeechControls(errorMessage); }
}
for (const id of ['speech-language', 'speech-profile']) $(id).addEventListener('change', () => {
  const value = { language: $('speech-language').value, profile: $('speech-profile').value };
  void updateSpeech(() => window.desktopBridge.configureSpeech(value), '正在保存离线语音设置…');
});
$('install-speech').addEventListener('click', () => void updateSpeech(async () => {
  try { await window.desktopBridge.installSpeech(); }
  catch (error) { state.speechInfo = await window.desktopBridge.speechStatus().catch(() => state.speechInfo); throw error; }
  return window.desktopBridge.speechStatus();
}, '正在下载所选组件，完成后可离线使用…'));
$('typing-settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!window.desktopBridge?.saveTypingSettings) { $('typing-settings-status').textContent = '请使用 Windows 桌面程序'; return; }
  try {
    await window.desktopBridge.saveTypingSettings({ chineseCpm: Number($('typing-chinese').value), englishWpm: Number($('typing-english').value) });
    $('typing-settings-status').textContent = '速度已保存，下次键入时使用';
  } catch (error) { $('typing-settings-status').textContent = error.message; }
});
$('stop-typing').addEventListener('click', () => { invalidateTyping(); toast('已停止回答键入'); });
$('message-list').addEventListener('scroll', () => {
  const list = $('message-list');
  state.manualReading = list.scrollHeight - list.clientHeight - list.scrollTop > 40;
});
$('live-monitor').addEventListener('toggle', () => { if (!$('live-monitor').open) $('remote-audio').pause(); });
void loadWorkspaceSettings();

$('desktop-tab').addEventListener('click', () => setRole('desktop'));
$('mobile-tab').addEventListener('click', () => setRole('mobile'));
$('start-share').addEventListener('click', startDesktop);
$('stop-share').addEventListener('click', () => stopCapture());
$('end-session').addEventListener('click', () => endSession());
$('change-share').addEventListener('click', changeDesktopCapture);
$('take-shot').addEventListener('click', () => takeScreenshot());
$('take-region-shot').addEventListener('click', () => takeScreenshot(true));
$('toggle-voice').addEventListener('click', () => state.voiceActive ? stopVoice(true) : startVoice());
$('copy-code').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.room || ''); toast('房间码已复制'); }
  catch { toast('复制失败，请手动输入房间码'); }
});
$('copy-lan-url').addEventListener('click', async () => {
  const address = pairingAddress();
  if (!address) return toast('未检测到可用的局域网地址');
  try { await navigator.clipboard.writeText(address); toast('手机信令地址已复制'); }
  catch { toast('复制失败，请手动选择地址'); }
});
$('desktop-lan-select').addEventListener('change', () => {
  $('desktop-lan-addresses').textContent = $('desktop-lan-select').value;
  void refreshPairingQr();
});
$('refresh-lan').addEventListener('click', () => loadDesktopSignalInfo(true));
$('refresh-qr').addEventListener('click', refreshPairingQr);
$('allow-peer').addEventListener('click', () => {
  if (!state.peer?.awaitingApproval) return;
  // A returning approved phone does not require approval. A replacement
  // phone starts with a clean conversation before it can connect.
  if (state.approvedPhone) resetConversation();
  state.approvedPhone = true;
  state.peer.approvePeer(true);
  $('pairing-approval').hidden = true;
});
$('reject-peer').addEventListener('click', () => { state.peer?.approvePeer(false); $('pairing-approval').hidden = true; });
$('scan-pairing').addEventListener('click', scanPairing);
$('check-connection').addEventListener('click', async () => {
  $('check-connection').disabled = true;
  $('pairing-hint').textContent = '正在检测电脑服务…';
  try { $('pairing-hint').textContent = await checkSignaling($('mobile-signal').value, { nativeHttp: Capacitor.getPlatform() === 'android' ? CapacitorHttp : undefined }); }
  catch (error) { $('pairing-hint').textContent = error.message; }
  finally { $('check-connection').disabled = false; }
});
$('mobile-connect').addEventListener('submit', async event => {
  event.preventDefault();
  const room = $('mobile-room').value.trim().toUpperCase();
  if (!/^[A-Z2-9]{8,12}$/.test(room)) return toast('房间码需为 8–12 位大写字母或数字');
  if (state.peer) state.peer.disconnect();
  resetConversation();
  resetMobileMedia();
  const peer = state.peer = makePeer('mobile');
  $('join-room').disabled = true;
  try {
    await peer.connect($('mobile-signal').value, room);
    if (state.peer !== peer) { peer.disconnect(); return; }
    $('mobile-room').value = room;
    $('leave-room').hidden = false;
    savePreferences();
  } catch (error) {
    peer.disconnect();
    if (state.peer !== peer) return;
    $('join-room').disabled = false;
    $('leave-room').hidden = true;
    state.peer = null;
    setStatus('mobile', error.message || '连接失败');
    toast(error.message || '连接失败');
  }
});
$('leave-room').addEventListener('click', () => {
  endSession(false);
  setStatus('mobile', '已断开连接');
});
$('reconnect-room').addEventListener('click', () => state.peer?.reconnect());
$('reconnect-desktop').addEventListener('click', () => state.peer?.reconnect());
$('enable-audio').addEventListener('click', async () => {
  try {
    $('remote-audio').muted = false;
    await $('remote-audio').play();
    $('media-hint').textContent = '音频播放中';
    toast('已开启桌面音频');
  } catch { toast('尚未收到音频轨道，或浏览器阻止播放'); }
});
$('composer').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('question-input').value.trim();
  if (!text) return;
  $('question-input').value = '';
  submitQuestion(text, '');
});
$('question-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
$('clear-chat').addEventListener('click', resetConversation);
$('follow-reading').addEventListener('click', () => { if (state.peer?.phase === 'connected') void state.peer.send(receiver.connect()).catch(() => {}); state.manualReading = false; $('message-list').scrollTop = $('message-list').scrollHeight; });
$('cancel-model').addEventListener('click', () => cancelModelRequests());
$('retry-model').addEventListener('click', () => {
  if (!state.retryRequest || state.modelPending) return;
  const retry = state.retryRequest;
  state.retryRequest = null;
  submitQuestion(retry.question, retry.image);
  updateModelQueue();
});
$('test-model').addEventListener('click', async () => {
  if (state.role !== 'desktop') return;
  const generation = ++state.configGeneration;
  const controller = state.configController = new AbortController();
  $('test-model').disabled = true;
  $('model-test-status').textContent = '正在测试配置…';
  try {
    await askModel({ endpoint: $('llm-endpoint').value.trim(), apiKey: $('llm-key').value, model: $('llm-model').value.trim(), question: '请仅回复“连接成功”。', signal: controller.signal });
    if (generation === state.configGeneration) $('model-test-status').textContent = '文字请求成功。可继续用截图测试模型的图片能力。';
  } catch (error) {
    if (generation === state.configGeneration && !controller.signal.aborted) $('model-test-status').textContent = error.message || '配置测试失败';
  } finally {
    if (generation === state.configGeneration) { state.configController = null; $('test-model').disabled = false; }
  }
});
for (const id of ['llm-endpoint', 'llm-model', 'llm-key']) $(id).addEventListener('input', () => {
  if (id !== 'llm-key') savePreferences();
  state.configGeneration += 1;
  state.configController?.abort();
  state.configController = null;
  $('test-model').disabled = false;
  $('model-test-status').textContent = '配置已更改，请重新测试。测试可能计入服务商用量。';
});
$('show-diagnostics').addEventListener('click', () => {
  $('diagnostics-text').value = JSON.stringify(connectionDiagnostics({ version: __APP_VERSION__, platform: Capacitor.getPlatform(),
    role: state.role, peer: state.peer, localStream: state.outgoingStream, remoteStream: $('remote-preview').srcObject, modelPending: state.modelPending }), null, 2);
  $('diagnostics-dialog').showModal();
});
$('app-version').textContent = '版本 ' + __APP_VERSION__;
$('show-updates').addEventListener('click', () => $('updates-dialog').showModal());
$('close-updates').addEventListener('click', () => $('updates-dialog').close());
$('check-updates').addEventListener('click', async () => {
  $('check-updates').disabled = true;
  $('update-status').textContent = '正在读取 GitHub 正式版本…';
  try { $('update-status').textContent = updateMessage(await checkLatestRelease(__APP_VERSION__)); }
  finally { $('check-updates').disabled = false; }
});
$('open-releases').addEventListener('click', async () => {
  try {
    if (window.desktopBridge) await window.desktopBridge.openReleases();
    else if (Capacitor.isNativePlatform()) location.href = RELEASES_URL;
    else window.open(RELEASES_URL, '_blank', 'noopener,noreferrer');
  } catch { $('update-status').textContent = '无法打开浏览器，请使用 README 中的版本下载链接。'; }
});
$('close-diagnostics').addEventListener('click', () => $('diagnostics-dialog').close());
$('copy-diagnostics').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('diagnostics-text').value); toast('诊断信息已复制，可附在问题描述中'); }
  catch { $('diagnostics-text').focus(); $('diagnostics-text').select(); toast('请手动复制已选中的诊断信息'); }
});
for (const id of ['mobile-signal', 'llm-endpoint', 'llm-model']) $(id).addEventListener('change', savePreferences);
$('mobile-signal').addEventListener('input', savePreferences);
$('mobile-signal').value = saved.signalBase || defaultBase;
$('desktop-signal').value = saved.signalBase || defaultBase;
$('llm-endpoint').value = saved.endpoint || 'https://api.openai.com/v1/chat/completions';
$('llm-model').value = saved.model || 'gpt-4o-mini';
void loadDesktopSignalInfo();
setupKnowledge({ bridge: window.desktopBridge, configuration: () => ({ endpoint: $('llm-endpoint').value.trim(), apiKey: $('llm-key').value, model: $('llm-model').value.trim() }), notify: toast });
$('desktop-signal').addEventListener('change', () => { savePreferences(); void refreshPairingQr(); });
$('desktop-signal').addEventListener('input', savePreferences);

function handleDesktopKeydown(event) {
  if (state.role !== 'desktop' || event.repeat || !state.shortcutsEnabled || !state.displayStream || event.isComposing) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
  const action = shortcutForEvent(event, state.shortcuts);
  if (action) { event.preventDefault(); void dispatchDesktopHotkey(action); }
}
if (window.desktopBridge) {
  window.desktopBridge.onShortcut(dispatchDesktopHotkey);
  window.desktopBridge.onShortcutError?.(message => { $('shortcut-status').textContent = message; toast(message); });
  window.desktopBridge.onTypingStatus?.(value => {
    if (!value || typeof value.message !== 'string') return;
    if (value.active === false && state.typingBusy) invalidateTyping();
    toast(value.message);
  });
}
document.addEventListener('keydown', handleDesktopKeydown);
if (initialRole !== state.role) setRole(initialRole);
if (Capacitor.getPlatform() === 'android') { $('desktop-tab').disabled = true; $('desktop-tab').hidden = true; }
window.addEventListener('beforeunload', () => {
  state.configController?.abort();
  endSession(false);
});
