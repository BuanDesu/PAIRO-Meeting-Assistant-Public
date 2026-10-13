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
  state.lastAnswer = '';
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
      if (!peer.awaitingApproval) $('pairing-approval').hidden = true;
      if (role === 'desktop') $('reconnect-desktop').hidden = !['failed', 'disconnected', 'reconnecting'].includes(peer.phase);
      setStatus(role, message, peer.phase === 'connected');
      if (role === 'mobile') $('reconnect-room').hidden = !['failed', 'disconnected', 'reconnecting'].includes(peer.phase);
      if (role === 'mobile' && peer.phase === 'connected') toast('两台设备已建立加密直连');
    },
    onMessage: message => state.peer === peer ? (role === 'mobile' ? handleMobileMessage(message) : handleDesktopMessage(message)) : undefined,
    onStream: stream => state.peer === peer && role === 'mobile' ? attachRemoteStream(stream) : null,
    onPeerLeft: () => { if (state.peer === peer) resetConversation(); },
    onApproval: () => { if (state.peer === peer && role === 'desktop') $('pairing-approval').hidden = false; },
  });
  return peer;
}

async function dispatchDesktopHotkey(action) {
  if (state.role !== 'desktop' || !state.displayStream) return;
  if (action === 'screenshot') takeScreenshot();
  if (action === 'voice') state.voiceActive ? stopVoice(true) : startVoice();
  if (action === 'auto-answer') {
    try { await state.peer.send({ type: 'control', action: 'toggle-auto-answer' }); }
    catch (error) { toast(error.message); }
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
      audio: $('capture-system-audio').checked,
    });
    if (!current()) { display.getTracks().forEach(track => track.stop()); return; }
    state.displayStream = display;
    display.getVideoTracks()[0].addEventListener('ended', () => { if (current() && state.displayStream === display) stopDesktop(true); }, { once: true });
    $('stop-share').disabled = false;
    $('local-preview').srcObject = display;
    const tracks = [...display.getTracks()];
    if ($('capture-mic').checked) {
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
    if (state.displayStream) stopDesktop(false);
    else $('start-share').disabled = false;
    setStatus('desktop', error.message || '无法开启屏幕分享');
    toast(error.message || '无法开启屏幕分享');
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
    state.displayStream = display; state.outgoingStream = outgoing; accepted = true;
    $('local-preview').srcObject = display;
    display.getVideoTracks()[0].addEventListener('ended', () => { if (current() && state.displayStream === display) stopDesktop(true); }, { once: true });
    previous.getTracks().forEach(track => track.stop());
    toast('共享内容已更换，手机配对与声音设置保持不变');
  } catch (error) {
    if (current()) toast(error.name === 'NotAllowedError' || error.name === 'AbortError' ? '已取消更换，继续分享原来的画面' : '更换未完成：' + error.message);
  } finally {
    if (!accepted) display?.getTracks().forEach(track => track.stop());
    if (current()) {
      state.captureSwitchPending = false;
      $('change-share').disabled = !state.displayStream;
      $('take-shot').disabled = !state.displayStream; $('take-region-shot').disabled = !state.displayStream;
    }
  }
}

async function takeScreenshot(region = false) {
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

function startVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    toast('此浏览器不支持语音识别；请在手机端直接输入问题');
    return;
  }
  if (!state.peer) return toast('请先开启屏幕分享并等待配对');
  state.voiceBuffer = '';
  state.voiceActive = true;
  state.recognition = new SpeechRecognition();
  state.recognition.lang = 'zh-CN';
  state.recognition.continuous = true;
  state.recognition.interimResults = true;
  state.recognition.onresult = event => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const part = event.results[index][0]?.transcript || '';
      if (event.results[index].isFinal) state.voiceBuffer += part;
      else interim += part;
    }
    if (interim) setStatus('desktop', '聆听中：' + interim.slice(0, 45));
    if (state.voiceBuffer.trim()) {
      clearTimeout(state.voiceTimer);
      state.voiceTimer = setTimeout(sendRecognizedQuestion, 900);
    }
  };
  state.recognition.onerror = event => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      state.voiceActive = false;
      toast('麦克风或语音识别权限被拒绝');
    } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
      toast('语音识别错误：' + event.error);
    }
  };
  state.recognition.onend = () => {
    if (state.voiceActive) setTimeout(() => {
      try { state.recognition?.start(); } catch { /* the browser may still be closing the previous session */ }
    }, 250);
  };
  try {
    state.recognition.start();
    $('toggle-voice').classList.add('listening');
    $('toggle-voice').firstChild.textContent = '● 正在聆听 ';
    toast('开始语音识别，请说出问题；再次按快捷键结束');
  } catch (error) {
    state.voiceActive = false;
    toast('无法启动语音识别：' + error.message);
  }
}
function stopVoice(sendRemainder = true) {
  state.voiceActive = false;
  clearTimeout(state.voiceTimer);
  try { state.recognition?.stop(); } catch { /* already stopped */ }
  state.recognition = null;
  $('toggle-voice').classList.remove('listening');
  $('toggle-voice').firstChild.textContent = '◖ 语音提问 ';
  if (sendRemainder) sendRecognizedQuestion();
}
async function sendRecognizedQuestion() {
  clearTimeout(state.voiceTimer);
  const text = state.voiceBuffer.trim();
  state.voiceBuffer = '';
  if (!text) return;
  try {
    await state.peer.send({ type: 'request', text, at: Date.now() });
    $('desktop-question-empty').hidden = true;
    $('desktop-question').hidden = false;
    $('desktop-question').textContent = text;
    state.requestCount += 1;
    $('request-count').textContent = String(state.requestCount);
    setStatus('desktop', '语音问题已发送');
  } catch (error) { toast(error.message); }
}

function handleDesktopMessage(message) {
  if (message.type === 'screenshot-ack') { state.screenshotTransfers?.acknowledge(message); return; }
  if (message.type === 'answer') {
    $('desktop-answer').textContent = String(message.text || '');
    toast('手机端 AI 回复已同步');
  }
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
  $('message-list').scrollTop = $('message-list').scrollHeight;
  return item;
}
function setLatestImage(image) {
  if (!/^data:image\/(jpeg|png|webp);base64,/i.test(String(image || ''))) return;
  state.latestImage = image;
  $('attachment-thumb').src = image;
  $('attachment-strip').hidden = false;
}
async function handleMobileMessage(message) {
  if (message.type === 'control' && message.action === 'toggle-auto-answer') {
    $('auto-answer').checked = !$('auto-answer').checked;
    await state.peer.send({ type: 'control-state', enabled: $('auto-answer').checked });
    toast('桌面快捷键已' + ($('auto-answer').checked ? '开启' : '关闭') + '自动回答');
    return;
  }
  if (message.type === 'screenshot') {
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
    addChatMessage('incoming', '收到桌面截图', message.image);
    if (validScreenshotId(message.id)) await peer?.send({ type: 'screenshot-ack', id: message.id, status: 'received' }).catch(() => {});
    if (!current()) return;
    if ($('auto-answer').checked) submitQuestion('请分析这张桌面截图中的问题，并给出简洁、准确的建议。', message.image);
    return;
  }
  if (message.type === 'request') {
    const text = String(message.text || '').slice(0, 12000);
    addChatMessage('incoming', text);
    if ($('auto-answer').checked) submitQuestion(text, state.latestImage);
    return;
  }
}

async function submitQuestion(question, image = state.latestImage) {
  const text = String(question || '').trim();
  if (!text && !image) return toast('请输入问题或先接收截图');
  const actualQuestion = text || '请分析当前桌面截图中的问题，并给出简洁、准确的建议。';
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
          $('message-list').scrollTop = $('message-list').scrollHeight;
        },
      });
      if (!current()) return;
      pending.remove();
      addChatMessage('answer', answer);
      state.lastAnswer = answer;
      state.chatHistory.push({ role: 'user', content: actualQuestion }, { role: 'assistant', content: answer });
      state.chatHistory = state.chatHistory.slice(-8);
      if (peer) {
        try { await peer.send({ type: 'answer', text: answer, at: Date.now() }); } catch { /* showing it on the phone is still useful */ }
      }
    } catch (error) {
      pending.remove();
      if (current() && !controller.signal.aborted) {
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
$('close-diagnostics').addEventListener('click', () => $('diagnostics-dialog').close());
$('copy-diagnostics').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('diagnostics-text').value); toast('诊断信息已复制，可附在问题描述中'); }
  catch { $('diagnostics-text').focus(); $('diagnostics-text').select(); toast('请手动复制已选中的诊断信息'); }
});
$('speak-answer').addEventListener('click', () => {
  if (!state.lastAnswer || !('speechSynthesis' in window)) return toast('当前没有可朗读的答复');
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(state.lastAnswer);
  utterance.lang = 'zh-CN';
  speechSynthesis.speak(utterance);
});
for (const id of ['mobile-signal', 'llm-endpoint', 'llm-model']) $(id).addEventListener('change', savePreferences);
$('mobile-signal').value = saved.signalBase || defaultBase;
$('desktop-signal').value = saved.signalBase || defaultBase;
$('llm-endpoint').value = saved.endpoint || 'https://api.openai.com/v1/chat/completions';
$('llm-model').value = saved.model || 'gpt-4o-mini';
void loadDesktopSignalInfo();
$('desktop-signal').addEventListener('change', () => { savePreferences(); void refreshPairingQr(); });

function handleDesktopKeydown(event) {
  if (state.role !== 'desktop' || event.repeat || !event.altKey || !event.shiftKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
  const key = event.key.toLowerCase();
  if (key === 's') dispatchDesktopHotkey('screenshot');
  if (key === 'm') dispatchDesktopHotkey('voice');
  if (key === 'a') dispatchDesktopHotkey('auto-answer');
}
if (window.desktopBridge) window.desktopBridge.onShortcut(dispatchDesktopHotkey);
else document.addEventListener('keydown', handleDesktopKeydown);
if (initialRole !== state.role) setRole(initialRole);
window.addEventListener('beforeunload', () => {
  state.configController?.abort();
  resetConversation();
  state.peer?.disconnect();
  state.outgoingStream?.getTracks().forEach(track => track.stop());
  try { state.recognition?.stop(); } catch { /* closing */ }
});
