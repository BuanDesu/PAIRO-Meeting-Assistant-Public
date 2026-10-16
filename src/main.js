import './styles.css';
import './pairing.css';
import './screenshot.css';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { PeerSession } from './peer-session.js';
import { askModel } from './llm.js';
import { defaultRoleForPlatform } from './platform.js';
import { createPairingCode, parsePairingCode, checkSignaling, scanFailureMessage } from './pairing.js';
import { ScreenshotTransfers, validScreenshotId } from './screenshot-transfer.js';
import { cropCanvas, screenshotPayload, decodeScreenshot } from './screenshot.js';
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
  captureGeneration: 0, modelGeneration: 0, modelControllers: new Set(),
  modelQueue: Promise.resolve(), modelPending: 0, nativeSignalBase: '',
  pairingGeneration: 0,
  modelNodes: new Set(), retryRequest: null, configController: null, configGeneration: 0,
  screenshotTransfers: null, screenshotController: null, screenshotGeneration: 0, screenshotBusy: false,
  screenshotReceivers: new Set(),
  captureSwitchPending: false,
  pages: { desktop: 'pair', mobile: 'pair' }, shortcuts: { ...DEFAULT_SHORTCUTS }, shortcutsEnabled: false,
  typingRequest: null, typingBusy: false, typingGeneration: 0,
  selectionGeneration: 0,
  voiceInput: null, voiceGeneration: 0, manualReading: false,
};
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
function savePreferences() {
  const signalBase = $(state.role === 'desktop' ? 'desktop-signal' : 'mobile-signal').value.trim();
  const preferences = {
    signalBase: window.desktopBridge && signalBase === state.nativeSignalBase ? '' : signalBase,
    endpoint: $('llm-endpoint').value.trim(),
    model: $('llm-model').value.trim(),
  };
  try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch { /* private browsing */ }
  window.desktopBridge?.writePreferences(preferences).catch(() => toast('设置保存失败，请检查配置目录权限'));
}

function resetConversation() {
  state.selectionGeneration += 1;
  invalidateTyping();
  state.screenshotGeneration += 1;
  state.screenshotController?.abort();
  state.screenshotController = null;
  state.screenshotTransfers?.cancelAll();
  for (const controller of state.screenshotReceivers) controller.abort();
  state.screenshotReceivers.clear();
  state.screenshotBusy = false;
  $('shot-progress').hidden = true;
  $('take-shot').disabled = !state.displayStream;
  $('take-region-shot').disabled = !state.displayStream;
  cancelModelRequests(false);
  state.retryRequest = null;
  updateModelQueue();
  state.latestImage = '';
  state.chatHistory = [];
  state.lastAnswer = ''; state.manualReading = false;
  $('send-button').disabled = false;
  $('message-list').querySelectorAll('.chat-message').forEach(node => node.remove());
  $('conversation-empty').hidden = false;
  $('attachment-strip').hidden = true;
  $('attachment-thumb').removeAttribute('src');
  $('desktop-answer').textContent = '';
  $('desktop-question').textContent = '';
  $('desktop-question').hidden = true;
  $('desktop-question-empty').hidden = false;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function updateModelQueue() {
  $('model-queue-status').textContent = state.modelPending ? `正在处理 ${state.modelPending} 个请求，按收到顺序回答` : '没有待处理请求';
  $('cancel-model').hidden = state.modelPending === 0;
  $('retry-model').hidden = !state.retryRequest;
  $('retry-model').disabled = state.modelPending > 0;
  $('send-button').disabled = state.modelPending > 0;
}

function cancelModelRequests(showMessage = true) {
  state.lastAnswer = '';
  notifyAnswerInvalidated();
  state.modelGeneration += 1;
  for (const controller of state.modelControllers) controller.abort();
  state.modelControllers.clear();
  for (const node of state.modelNodes) node.remove();
  state.modelNodes.clear();
  state.modelQueue = Promise.resolve();
  state.modelPending = 0;
  updateModelQueue();
  if (showMessage) addChatMessage('system', '已取消等待。服务商已经接收的请求仍可能计入用量。');
}
function notifyAnswerInvalidated() {
  if (state.role === 'mobile' && state.peer?.phase === 'connected') void state.peer.send({ type: 'answer-invalidated' }).catch(() => {});
}

function resetMobileMedia() {
  $('join-room').disabled = false;
  $('leave-room').hidden = true;
  $('reconnect-room').hidden = true;
  $('remote-preview').srcObject = null;
  $('remote-audio').srcObject = null;
  $('remote-preview').classList.remove('visible');
  $('remote-empty').hidden = false;
  $('media-hint').textContent = '音频需点击开启';
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
  stopDesktop(false);
  resetMobileMedia();
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
  $('meeting-mode').disabled = active;
  $('capture-mic').disabled = active || $('meeting-mode').value === 'one-to-one';
  $('capture-system-audio').disabled = active || $('meeting-mode').value === 'one-to-one';
  $('local-empty').hidden = active;
  $('local-preview').classList.toggle('visible', active);
  $('desktop-feed-status').textContent = active ? '正在分享' : '未分享';
  $('desktop-feed-status').classList.toggle('live', active);
  $('take-shot').disabled = !active;
  $('take-region-shot').disabled = !active;
  $('toggle-voice').disabled = !active;
  $('stop-share').disabled = !active;
  $('start-share').disabled = active;
  $('change-share').disabled = !active || state.captureSwitchPending;
}
function makePeer(role) {
  const peer = new PeerSession({
    role,
    onStatus: message => {
      if (state.peer !== peer) return;
      if (peer.phase !== 'connected') state.selectionGeneration += 1;
      if (role === 'desktop' && peer.phase !== 'connected' && state.typingBusy) invalidateTyping();
      if (!peer.awaitingApproval) $('pairing-approval').hidden = true;
      if (role === 'desktop') $('reconnect-desktop').hidden = !['failed', 'disconnected', 'reconnecting'].includes(peer.phase);
      setStatus(role, message, peer.phase === 'connected');
      if (role === 'mobile') $('reconnect-room').hidden = !['failed', 'disconnected', 'reconnecting'].includes(peer.phase);
      if (role === 'mobile' && peer.phase === 'connected') toast('两台设备已建立加密直连');
    },
    onMessage: message => state.peer === peer ? (role === 'mobile' ? handleMobileMessage(message) : handleDesktopMessage(message)) : undefined,
    onStream: stream => state.peer === peer && role === 'mobile' ? attachRemoteStream(stream) : null,
    onPeerLeft: () => { if (state.peer === peer) { stopVoice(false); resetConversation(); } },
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
  const generation = ++state.typingGeneration;
  state.typingBusy = true;
  try {
    const token = await bridge.prepareTyping();
    if (generation !== state.typingGeneration || state.peer !== peer) return;
    if (!token) { invalidateTyping(); return; }
    const request = { token, peer, generation, timer: null };
    state.typingRequest = request;
    request.timer = setTimeout(() => {
      if (state.typingRequest !== request) return;
      invalidateTyping(); toast('手机未返回可键入的回答，请确认两端均已更新');
    }, 5000);
    await peer.send({ type: 'answer-request', id: token });
  } catch (error) {
    if (generation === state.typingGeneration) { invalidateTyping(); toast(error.message); }
  }
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
  if (!state.room || !state.displayStream) return;
  try {
    const payload = createPairingCode(pairingAddress(), state.room);
    const { default: QRCode } = await import('qrcode');
    const image = await QRCode.toDataURL(payload, { width: 240, margin: 3, errorCorrectionLevel: 'M' });
    if (generation !== state.pairingGeneration || !state.displayStream) return;
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
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('当前浏览器不支持屏幕分享，请使用桌面 Chromium 浏览器');
    return;
  }
  $('start-share').disabled = true;
  const generation = ++state.captureGeneration;
  const current = () => state.role === 'desktop' && generation === state.captureGeneration;
  let peer;
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 12, max: 20 } },
      audio: $('meeting-mode').value === 'one-to-one' || $('capture-system-audio').checked,
    });
    if (!current()) { display.getTracks().forEach(track => track.stop()); return; }
    state.displayStream = display;
    display.getVideoTracks()[0].addEventListener('ended', () => { if (current() && state.displayStream === display) stopDesktop(true); }, { once: true });
    $('stop-share').disabled = false;
    $('local-preview').srcObject = display;
    const tracks = [...display.getTracks()];
    if ($('capture-mic').checked && $('meeting-mode').value !== 'one-to-one') {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        if (!current()) { mic.getTracks().forEach(track => track.stop()); return; }
        tracks.push(...mic.getAudioTracks());
        mic.getVideoTracks().forEach(track => track.stop());
      } catch (error) {
        if (!current()) return;
        toast('未启用麦克风：' + (error.name === 'NotAllowedError' ? '权限被拒绝' : '设备不可用'));
      }
    }
    if (!current()) return;
    state.outgoingStream = new MediaStream(tracks);
    state.room = randomRoomCode();
    $('room-code').textContent = state.room;
    $('copy-code').disabled = false;
    state.peer = peer = makePeer('desktop');
    state.screenshotTransfers = new ScreenshotTransfers({ send: (message, options) => peer.send(message, options) });
    peer.setLocalStream(state.outgoingStream);
    await peer.connect($('desktop-signal').value, state.room);
    if (!current() || state.peer !== peer) { peer.disconnect(); return; }
    setFeedActive(true);
    void refreshPairingQr();
    $('desktop-feed-status').textContent = '等待手机配对';
    toast('配对信息已生成，可在手机端扫码或手动输入');
  } catch (error) {
    if (!current()) { peer?.disconnect(); return; }
    const message = !state.displayStream && captureNotSelected(error)
      ? '屏幕分享未开始，请重试并选择要分享的屏幕或窗口。' : error.message || '无法开启屏幕分享';
    if (state.displayStream) stopDesktop(false);
    else $('start-share').disabled = false;
    setStatus('desktop', message);
    toast(message);
  }
}

function stopDesktop(showToast = true) {
  state.captureGeneration += 1;
  state.captureSwitchPending = false;
  resetConversation();
  state.screenshotTransfers = null;
  stopVoice(false);
  if (state.peer) state.peer.disconnect();
  state.peer = null;
  for (const track of new Set([...(state.outgoingStream?.getTracks() || []), ...(state.displayStream?.getTracks() || [])])) track.stop();
  state.displayStream = null;
  state.outgoingStream = null;
  $('local-preview').srcObject = null;
  setFeedActive(false);
  $('room-code').textContent = '等待分享';
  $('copy-code').disabled = true;
  $('pairing-approval').hidden = true;
  $('reconnect-desktop').hidden = true;
  state.room = '';
  void refreshPairingQr();
  setStatus('desktop', '尚未连接');
  if (showToast) toast('桌面分享已停止');
}

async function changeDesktopCapture() {
  if (!state.displayStream || !state.peer || state.captureSwitchPending || state.screenshotBusy) return;
  const generation = state.captureGeneration, peer = state.peer, previous = state.displayStream;
  const current = () => state.role === 'desktop' && generation === state.captureGeneration && state.peer === peer;
  let display, accepted = false;
  state.captureSwitchPending = true; $('change-share').disabled = true;
  $('take-shot').disabled = true; $('take-region-shot').disabled = true;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 12, max: 20 } }, audio: previous.getAudioTracks().length > 0 });
    if (!current()) return;
    const retained = state.outgoingStream.getTracks().filter(track => !previous.getTracks().includes(track));
    const outgoing = new MediaStream([...display.getTracks(), ...retained]);
    await peer.replaceLocalStream(outgoing);
    if (!current()) return;
    const resumeVoice = state.voiceActive;
    if (resumeVoice) stopVoice(false);
    state.displayStream = display; state.outgoingStream = outgoing; accepted = true;
    $('local-preview').srcObject = display;
    display.getVideoTracks()[0].addEventListener('ended', () => { if (current() && state.displayStream === display) stopDesktop(true); }, { once: true });
    previous.getTracks().forEach(track => track.stop());
    if (resumeVoice) void startVoice();
    toast('共享内容已更换，手机配对与声音设置保持不变');
  } catch (error) {
    if (current()) toast(captureNotSelected(error) ? '未更换共享内容，继续分享原来的画面' : '更换未完成：' + error.message);
  } finally {
    if (!accepted) display?.getTracks().forEach(track => track.stop());
    if (current()) {
      state.captureSwitchPending = false;
      $('change-share').disabled = !state.displayStream;
      $('take-shot').disabled = !state.displayStream; $('take-region-shot').disabled = !state.displayStream;
    }
  }
}

async function takeScreenshot(region = false, autoAsk = true) {
  const video = $('local-preview');
  if (!video.videoWidth || !video.videoHeight) return toast('画面尚未准备好，请稍后重试');
  if (state.screenshotBusy) return toast('上一张截图仍在处理，请稍后再试');
  if (state.captureSwitchPending) return toast('请先完成共享内容选择');
  const peer = state.peer, transfers = state.screenshotTransfers;
  if (!peer || peer.phase !== 'connected' || !transfers) return toast('请先等待手机连接成功');
  const generation = state.screenshotGeneration;
  const current = () => generation === state.screenshotGeneration && peer === state.peer;
  const controller = state.screenshotController = new AbortController();
  state.screenshotBusy = true;
  $('take-shot').disabled = true; $('take-region-shot').disabled = true;
  try {
    const canvas = region ? await selectScreenshotRegion(video, controller.signal) : cropCanvas(video);
    if (!canvas || !current()) return;
    let payload;
    try { payload = screenshotPayload(canvas); } finally { canvas.width = 0; canvas.height = 0; }
    if (autoAsk) payload.question = $('screenshot-question').value.trim().slice(0, 500) || '请回答图中的问题。';
    invalidateTyping();
    await transfers.transfer(payload, progress => {
      if (!current()) return;
      $('shot-progress').hidden = false;
      $('shot-progress-bar').value = Math.floor(progress.fraction * 100);
      $('shot-progress-text').textContent = progress.phase === 'received' ? '手机已确认收到截图'
        : progress.phase === 'waiting' ? '发送完成，等待手机确认…' : `正在加密发送截图 ${Math.floor(progress.fraction * 100)}%`;
    });
    if (current()) toast('手机已确认收到截图');
  } catch (error) {
    if (current() && !controller.signal.aborted) { $('shot-progress-text').textContent = error.message || '截图发送失败'; toast(error.message || '截图发送失败，请确认手机已连接'); }
  } finally {
    if (current()) { state.screenshotBusy = false; state.screenshotController = null; $('take-shot').disabled = !state.displayStream; $('take-region-shot').disabled = !state.displayStream; }
  }
}

async function startVoice() {
  if (!state.peer || state.peer.phase !== 'connected') return toast('请先等待手机连接成功');
  if (!window.desktopBridge?.transcribeAudio) return toast('离线转写需要 Windows 桌面程序');
  if (state.voiceActive) return;
  const generation = ++state.voiceGeneration, peer = state.peer;
  state.voiceActive = true;
  try {
    const status = await window.desktopBridge.speechStatus();
    if (generation !== state.voiceGeneration) return;
    if (!status.ready) throw new Error('请先在快捷键设置中下载离线语音组件');
    const tracks = state.outgoingStream?.getAudioTracks().filter(track => track.readyState === 'live') || [];
    if (!tracks.length) throw new Error('没有可用音频，请重新分享并启用所需音频来源');
    const input = new OfflineVoiceInput({
      transcribe: pcm => window.desktopBridge.transcribeAudio(pcm),
      onText: text => { if (generation === state.voiceGeneration && state.peer === peer) void sendDesktopQuestion(text); },
      onStatus: text => { if (generation === state.voiceGeneration) toast(text); },
      onError: error => { if (generation === state.voiceGeneration) { stopVoice(false); toast(error.message || '离线转写失败'); } },
    });
    state.voiceInput = input;
    await input.start(tracks);
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
  const input = state.voiceInput; state.voiceInput = null;
  void input?.stop().catch(() => {});
  void window.desktopBridge?.cancelTranscription?.().catch(() => {});
  $('toggle-voice').classList.remove('listening');
  $('toggle-voice').firstChild.textContent = '◖ 离线语音输入 ';
  if (wasActive && state.peer?.phase === 'connected') void state.peer.send({ type: 'notice', text: '语音输入已停止，未完成的转写已取消。' }).catch(() => {});
}
async function sendDesktopQuestion(value) {
  const text = String(value || '').trim().slice(0, 12000);
  if (!text) return;
  if (state.peer?.phase !== 'connected') return toast('手机尚未连接，本条问题未发送');
  invalidateTyping();
  try {
    await state.peer.send({ type: 'request', text, autoAsk: true, at: Date.now() });
    $('desktop-question-empty').hidden = true;
    $('desktop-question').hidden = false; $('desktop-question').textContent = text;
    $('request-count').textContent = String(++state.requestCount);
    toast('问题已投送手机');
    return true;
  } catch (error) { toast(error.message); return false; }
}

async function handleDesktopMessage(message) {
  if (message.type === 'screenshot-ack') { state.screenshotTransfers?.acknowledge(message); return; }
  if (message.type === 'answer-invalidated') { invalidateTyping(); return; }
  if (message.type === 'answer-result') {
    const request = state.typingRequest;
    if (!request || message.id !== request.token || request.peer !== state.peer || state.peer?.phase !== 'connected' || request.generation !== state.typingGeneration || state.role !== 'desktop') return;
    clearTimeout(request.timer); state.typingRequest = null;
    if (message.status !== 'ready' || typeof message.text !== 'string' || !message.text.trim() || message.text.length > 24000) {
      invalidateTyping(); return toast(message.status === 'busy' ? '手机仍在生成回答，请完成后再按键入快捷键' : '手机没有可键入的完整回答；失败或取消后请重新提问');
    }
    try { await window.desktopBridge.typeAnswer({ token: request.token, text: message.text }); }
    catch (error) { if (request.generation === state.typingGeneration) toast(error.message); }
    finally { if (request.generation === state.typingGeneration) { state.typingBusy = false; void window.desktopBridge?.cancelTyping?.().catch(() => {}); } }
    return;
  }
  // Answers are never rendered or spoken on the desktop. Only an explicit, matching request may type one.
  if (message.type === 'control-state') toast('手机自动回答已' + (message.enabled ? '开启' : '关闭'));
}
function attachRemoteStream(stream) {
  const video = $('remote-preview');
  const audio = $('remote-audio');
  if (video.srcObject !== stream) video.srcObject = stream;
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) audio.srcObject = null;
  if (audioTracks.length && audio.srcObject?.getTracks?.()[0]?.id !== audioTracks[0].id) audio.srcObject = new MediaStream(audioTracks);
  const hasVideo = stream.getVideoTracks().some(track => track.readyState === 'live');
  $('remote-empty').hidden = hasVideo;
  video.classList.toggle('visible', hasVideo);
  $('media-hint').textContent = audioTracks.length ? '音频已接收 · 点击播放' : '当前没有收到音频轨道';
}
function addChatMessage(kind, text, image = '') {
  $('conversation-empty').hidden = true;
  const item = document.createElement('div');
  item.className = 'chat-message ' + kind;
  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = kind === 'answer' ? 'PAIRO AI' : kind === 'system' ? 'SYSTEM' : 'DESKTOP REQUEST';
  item.append(label);
  if (image && /^data:image\/(jpeg|png|webp);base64,/i.test(image)) {
    const img = document.createElement('img');
    img.src = image;
    img.alt = '桌面截图';
    item.append(img);
  }
  if (text) {
    const body = document.createElement('div');
    body.textContent = text;
    item.append(body);
  }
  $('message-list').append(item);
  if (!state.manualReading) $('message-list').scrollTop = $('message-list').scrollHeight;
  return item;
}
function setLatestImage(image) {
  if (!/^data:image\/(jpeg|png|webp);base64,/i.test(String(image || ''))) return;
  state.latestImage = image;
  $('attachment-thumb').src = image;
  $('attachment-strip').hidden = false;
}
async function handleMobileMessage(message) {
  if (message.type === 'answer-request') {
    if (typeof message.id !== 'string' || !/^[a-f0-9]{32}$/.test(message.id)) return;
    const text = state.lastAnswer;
    const status = state.modelPending ? 'busy' : text && text.length <= 24000 ? 'ready' : 'empty';
    await state.peer?.send({ type: 'answer-result', id: message.id, status, ...(status === 'ready' ? { text } : {}) }).catch(() => {});
    return;
  }
  if (message.type === 'notice') { addChatMessage('system', String(message.text || '').slice(0, 500)); return; }
  if (message.type === 'control' && ['scroll-up', 'scroll-down'].includes(message.action)) {
    navigatePage('mobile', 'chat');
    state.manualReading = true;
    $('message-list').scrollBy({ top: (message.action === 'scroll-up' ? -1 : 1) * $('message-list').clientHeight * 0.65, behavior: 'auto' });
    return;
  }
  if (message.type === 'control' && message.action === 'toggle-auto-answer') {
    $('auto-answer').checked = !$('auto-answer').checked;
    await state.peer.send({ type: 'control-state', enabled: $('auto-answer').checked });
    toast('桌面快捷键已' + ($('auto-answer').checked ? '开启' : '关闭') + '自动回答');
    return;
  }
  if (message.type === 'screenshot') {
    state.lastAnswer = ''; notifyAnswerInvalidated();
    const peer = state.peer, generation = state.screenshotGeneration;
    if (state.screenshotReceivers.size >= 2) return;
    const controller = new AbortController(); state.screenshotReceivers.add(controller);
    const current = () => state.peer === peer && generation === state.screenshotGeneration && !controller.signal.aborted;
    try { await decodeScreenshot(message, { signal: controller.signal }); }
    catch {
      if (current() && validScreenshotId(message.id)) await peer?.send({ type: 'screenshot-ack', id: message.id, status: 'rejected' }).catch(() => {});
      return;
    } finally { state.screenshotReceivers.delete(controller); }
    if (!current()) return;
    setLatestImage(message.image);
    addChatMessage('incoming', typeof message.question === 'string' ? '截图提问 · ' + message.question.slice(0, 500) : '收到桌面截图', message.image);
    if (validScreenshotId(message.id)) await peer?.send({ type: 'screenshot-ack', id: message.id, status: 'received' }).catch(() => {});
    if (!current()) return;
    navigatePage('mobile', 'chat');
    if (typeof message.question === 'string' && message.question.trim()) submitQuestion(message.question.slice(0, 500), message.image);
    else if ($('auto-answer').checked) submitQuestion('请分析这张桌面截图中的问题，并给出简洁、准确的建议。', message.image);
    return;
  }
  if (message.type === 'request') {
    const text = String(message.text || '').slice(0, 12000);
    addChatMessage('incoming', text);
    navigatePage('mobile', 'chat');
    if (message.autoAsk === true || $('auto-answer').checked) submitQuestion(text, '');
    return;
  }
}

async function submitQuestion(question, image = state.latestImage) {
  const text = String(question || '').trim();
  if (!text && !image) return toast('请输入问题或先接收截图');
  const actualQuestion = text || '请分析当前桌面截图中的问题，并给出简洁、准确的建议。';
  state.lastAnswer = '';
  notifyAnswerInvalidated();
  const key = $('llm-key').value;
  const endpoint = $('llm-endpoint').value.trim();
  const model = $('llm-model').value.trim();
    if (!key.trim()) {
    addChatMessage('system', '请先填写 API Key，再提交问题。Key 仅保存在当前页面内存。');
    $('llm-key').focus();
    return;
  }
  savePreferences();
  if (state.modelPending >= 8) return toast('模型请求队列已满，请稍后重试');
  const generation = state.modelGeneration;
  const peer = state.peer;
  const current = () => generation === state.modelGeneration && state.peer === peer;
  const controller = new AbortController();
  state.modelControllers.add(controller);
  state.modelPending += 1;
  const pending = addChatMessage('system', state.modelPending > 1 ? '已排队，等待前一个问题完成…' : '正在请求模型…');
  state.modelNodes.add(pending);
  updateModelQueue();
  const request = state.modelQueue.catch(() => {}).then(async () => {
    if (!current()) return;
    pending.textContent = '正在请求模型…';
    const answerBody = document.createElement('div');
    let partialShown = false;
    try {
      const answer = await askModel({ endpoint, apiKey: key, model, question: actualQuestion, imageDataUrl: image, history: state.chatHistory, signal: controller.signal,
        onPartial: text => {
          if (!current() || controller.signal.aborted) return;
          if (!partialShown) {
            partialShown = true;
            pending.textContent = '';
            pending.className = 'chat-message answer';
            const label = document.createElement('div'); label.className = 'message-label'; label.textContent = 'PAIRO AI · 回答中';
            pending.append(label, answerBody);
          }
          answerBody.textContent = text;
          if (!state.manualReading) $('message-list').scrollTop = $('message-list').scrollHeight;
        },
      });
      if (!current()) return;
      pending.remove();
      addChatMessage('answer', answer);
      state.lastAnswer = answer;
      state.chatHistory.push({ role: 'user', content: actualQuestion }, { role: 'assistant', content: answer });
      state.chatHistory = state.chatHistory.slice(-8);
    } catch (error) {
      pending.remove();
      if (current() && !controller.signal.aborted) {
        state.lastAnswer = '';
        addChatMessage('system', error.message || '模型请求失败');
        state.retryRequest = { question: actualQuestion, image };
      }
    } finally {
      state.modelControllers.delete(controller);
      state.modelNodes.delete(pending);
      if (current()) {
        state.modelPending -= 1;
        updateModelQueue();
      }
    }
  });
  state.modelQueue = request;
  return request;
}

function navigatePage(role, page) {
  const pages = role === 'desktop' ? ['pair', 'source', 'keys'] : ['pair', 'api', 'chat'];
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
    const speech = await window.desktopBridge?.speechStatus?.();
    $('speech-status').textContent = speech?.ready ? '离线组件已就绪 · 本机转写' : '首次需下载引擎和模型（约 80 MB）';
  } catch { $('shortcut-status').textContent = '设置读取失败，当前使用默认按键；请重新保存。'; }
}
for (const [role, pages] of Object.entries({ desktop: ['pair', 'source', 'keys'], mobile: ['pair', 'api', 'chat'] })) {
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
$('install-speech').addEventListener('click', async () => {
  if (!window.desktopBridge?.installSpeech) { $('speech-status').textContent = '请在 Windows 桌面程序中下载离线组件'; return; }
  $('install-speech').disabled = true; $('speech-status').textContent = '下载中，请稍候；完成前不能启动转写…';
  try { await window.desktopBridge.installSpeech(); $('speech-status').textContent = '离线组件已就绪 · 本机转写'; }
  catch (error) { $('speech-status').textContent = error.message || '下载失败，可稍后重试'; }
  finally { $('install-speech').disabled = false; }
});
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
$('stop-share').addEventListener('click', () => stopDesktop(true));
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
$('allow-peer').addEventListener('click', () => { state.peer?.approvePeer(true); $('pairing-approval').hidden = true; });
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
  state.peer?.disconnect();
  state.peer = null;
  resetConversation();
  resetMobileMedia();
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
  addChatMessage('incoming', text);
  $('question-input').value = '';
  submitQuestion(text, state.latestImage);
});
$('question-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('composer').requestSubmit();
  }
});
$('clear-chat').addEventListener('click', resetConversation);
$('cancel-model').addEventListener('click', () => cancelModelRequests());
$('retry-model').addEventListener('click', () => {
  if (!state.retryRequest || state.modelPending) return;
  const retry = state.retryRequest;
  state.retryRequest = null;
  addChatMessage('incoming', '重试：' + retry.question);
  submitQuestion(retry.question, retry.image);
  updateModelQueue();
});
$('test-model').addEventListener('click', async () => {
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
$('remove-attachment').addEventListener('click', () => {
  state.latestImage = '';
  $('attachment-strip').hidden = true;
  $('attachment-thumb').removeAttribute('src');
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
window.addEventListener('beforeunload', () => {
  state.configController?.abort();
  resetConversation();
  state.peer?.disconnect();
  state.outgoingStream?.getTracks().forEach(track => track.stop());
  stopVoice(false);
});
