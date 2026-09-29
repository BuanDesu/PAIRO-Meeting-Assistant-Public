import './styles.css';
import { Capacitor } from '@capacitor/core';
import { PeerSession } from './peer-session.js';
import { askModel } from './llm.js';
import { defaultRoleForPlatform } from './platform.js';

const $ = id => document.getElementById(id);
const state = {
  role: 'desktop', peer: null, displayStream: null, outgoingStream: null, recognition: null,
  voiceActive: false, voiceBuffer: '', voiceTimer: null, requestCount: 0,
  latestImage: '', chatHistory: [], lastAnswer: '', toastTimer: null, lanAddresses: [],
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
  try { return JSON.parse(localStorage.getItem(preferenceKey) || '{}'); } catch { return {}; }
}
function savePreferences() {
  const preferences = {
    signalBase: $('mobile-signal').value.trim(),
    endpoint: $('llm-endpoint').value.trim(),
    model: $('llm-model').value.trim(),
  };
  try { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); } catch { /* private browsing */ }
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
  if (state.peer || state.displayStream) stopDesktop(false);
  if (role === 'desktop' && state.peer) state.peer.disconnect();
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
  $('toggle-voice').disabled = !active;
  $('stop-share').disabled = !active;
  $('start-share').disabled = active;
}
function makePeer(role) {
  const peer = new PeerSession({
    role,
    onStatus: message => {
      setStatus(role, message, message.includes('P2P 已加密直连'));
      if (role === 'mobile' && message.includes('P2P 已加密直连')) toast('两台设备已建立加密直连');
    },
    onMessage: message => role === 'mobile' ? handleMobileMessage(message) : handleDesktopMessage(message),
    onStream: stream => role === 'mobile' ? attachRemoteStream(stream) : null,
  });
  return peer;
}

function dispatchDesktopHotkey(action) {
  if (state.role !== 'desktop' || !state.displayStream) return;
  if (action === 'screenshot') takeScreenshot();
  if (action === 'voice') state.voiceActive ? stopVoice(true) : startVoice();
  if (action === 'auto-answer') {
    try { state.peer.send({ type: 'control', action: 'toggle-auto-answer' }); }
    catch (error) { toast(error.message); }
  }
}

async function loadDesktopSignalInfo() {
  if (!window.desktopBridge) return;
  try {
    const info = await window.desktopBridge.getSignalInfo();
    $('desktop-signal').value = info.signalBase;
    state.lanAddresses = info.lanAddresses || [];
    $('desktop-lan-addresses').textContent = state.lanAddresses.length
      ? state.lanAddresses.map(item => item.url).join('\n')
      : '未检测到局域网 IPv4 地址';
    $('desktop-lan-info').hidden = false;
  } catch (error) { toast('读取局域网配对地址失败：' + error.message); }
}

async function startDesktop() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('当前浏览器不支持屏幕分享，请使用桌面 Chromium 浏览器');
    return;
  }
  $('start-share').disabled = true;
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 12, max: 20 } },
      audio: $('capture-system-audio').checked,
    });
    state.displayStream = display;
    $('local-preview').srcObject = display;
    const tracks = [...display.getTracks()];
    if ($('capture-mic').checked) {
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        tracks.push(...mic.getAudioTracks());
        mic.getVideoTracks().forEach(track => track.stop());
      } catch (error) {
        toast('未启用麦克风：' + (error.name === 'NotAllowedError' ? '权限被拒绝' : '设备不可用'));
      }
    }
    state.outgoingStream = new MediaStream(tracks);
    state.room = randomRoomCode();
    $('room-code').textContent = state.room;
    $('copy-code').disabled = false;
    state.peer = makePeer('desktop');
    state.peer.setLocalStream(state.outgoingStream);
    await state.peer.connect($('desktop-signal').value, state.room);
    setFeedActive(true);
    $('desktop-feed-status').textContent = '等待手机配对';
    display.getVideoTracks()[0].addEventListener('ended', () => stopDesktop(true), { once: true });
    toast('房间码已生成，请在手机端输入');
  } catch (error) {
    if (state.displayStream) stopDesktop(false);
    else $('start-share').disabled = false;
    setStatus('desktop', error.message || '无法开启屏幕分享');
    toast(error.message || '无法开启屏幕分享');
  }
}

function stopDesktop(showToast = true) {
  stopVoice(false);
  if (state.peer) state.peer.disconnect();
  state.peer = null;
  for (const track of state.outgoingStream?.getTracks() || []) track.stop();
  state.displayStream = null;
  state.outgoingStream = null;
  $('local-preview').srcObject = null;
  setFeedActive(false);
  $('room-code').textContent = '等待分享';
  $('copy-code').disabled = true;
  setStatus('desktop', '尚未连接');
  if (showToast) toast('桌面分享已停止');
}

function takeScreenshot() {
  const video = $('local-preview');
  if (!video.videoWidth || !video.videoHeight) return toast('画面尚未准备好，请稍后重试');
  try {
    const maxWidth = 1440;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/jpeg', 0.74);
    if (image.length > 3_500_000) return toast('截图仍然过大，请缩小窗口后重试');
    state.peer.send({ type: 'screenshot', image, width: canvas.width, height: canvas.height, at: Date.now() });
    toast('截图已加密发送到手机');
  } catch (error) {
    toast(error.message || '截图发送失败，请确认手机已连接');
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
function sendRecognizedQuestion() {
  clearTimeout(state.voiceTimer);
  const text = state.voiceBuffer.trim();
  state.voiceBuffer = '';
  if (!text) return;
  try {
    state.peer.send({ type: 'request', text, at: Date.now() });
    $('desktop-question-empty').hidden = true;
    $('desktop-question').hidden = false;
    $('desktop-question').textContent = text;
    state.requestCount += 1;
    $('request-count').textContent = String(state.requestCount);
    setStatus('desktop', '语音问题已发送');
  } catch (error) { toast(error.message); }
}

function handleDesktopMessage(message) {
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
function handleMobileMessage(message) {
  if (message.type === 'control' && message.action === 'toggle-auto-answer') {
    $('auto-answer').checked = !$('auto-answer').checked;
    state.peer.send({ type: 'control-state', enabled: $('auto-answer').checked });
    toast('桌面快捷键已' + ($('auto-answer').checked ? '开启' : '关闭') + '自动回答');
    return;
  }
  if (message.type === 'screenshot') {
    setLatestImage(message.image);
    addChatMessage('incoming', '收到桌面截图', message.image);
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
  const pending = addChatMessage('system', '正在请求模型…');
  $('send-button').disabled = true;
  try {
    const answer = await askModel({ endpoint, apiKey: key, model, question: actualQuestion, imageDataUrl: image, history: state.chatHistory });
    pending.remove();
    addChatMessage('answer', answer);
    state.lastAnswer = answer;
    state.chatHistory.push({ role: 'user', content: actualQuestion }, { role: 'assistant', content: answer });
    state.chatHistory = state.chatHistory.slice(-8);
    if (state.peer) {
      try { state.peer.send({ type: 'answer', text: answer, at: Date.now() }); } catch { /* showing it on the phone is still useful */ }
    }
  } catch (error) {
    pending.remove();
    addChatMessage('system', error.message || '模型请求失败');
  } finally {
    $('send-button').disabled = false;
  }
}

$('desktop-tab').addEventListener('click', () => setRole('desktop'));
$('mobile-tab').addEventListener('click', () => setRole('mobile'));
$('start-share').addEventListener('click', startDesktop);
$('stop-share').addEventListener('click', () => stopDesktop(true));
$('take-shot').addEventListener('click', takeScreenshot);
$('toggle-voice').addEventListener('click', () => state.voiceActive ? stopVoice(true) : startVoice());
$('copy-code').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.room || ''); toast('房间码已复制'); }
  catch { toast('复制失败，请手动输入房间码'); }
});
$('copy-lan-url').addEventListener('click', async () => {
  const address = state.lanAddresses[0]?.url;
  if (!address) return toast('未检测到可用的局域网地址');
  try { await navigator.clipboard.writeText(address); toast('手机信令地址已复制'); }
  catch { toast('复制失败，请手动选择地址'); }
});
$('mobile-connect').addEventListener('submit', async event => {
  event.preventDefault();
  const room = $('mobile-room').value.trim().toUpperCase();
  if (!/^[A-Z2-9]{8,12}$/.test(room)) return toast('房间码需为 8–12 位大写字母或数字');
  if (state.peer) state.peer.disconnect();
  state.peer = makePeer('mobile');
  $('join-room').disabled = true;
  try {
    await state.peer.connect($('mobile-signal').value, room);
    $('mobile-room').value = room;
    $('leave-room').hidden = false;
    savePreferences();
  } catch (error) {
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
  $('join-room').disabled = false;
  $('leave-room').hidden = true;
  $('remote-preview').srcObject = null;
  $('remote-audio').srcObject = null;
  $('remote-preview').classList.remove('visible');
  $('remote-empty').hidden = false;
  $('media-hint').textContent = '音频需点击开启';
  setStatus('mobile', '已断开连接');
});
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
$('clear-chat').addEventListener('click', () => {
  $('message-list').querySelectorAll('.chat-message').forEach(node => node.remove());
  $('conversation-empty').hidden = false;
  state.chatHistory = [];
  state.latestImage = '';
  $('attachment-strip').hidden = true;
  $('attachment-thumb').removeAttribute('src');
});
$('remove-attachment').addEventListener('click', () => {
  state.latestImage = '';
  $('attachment-strip').hidden = true;
  $('attachment-thumb').removeAttribute('src');
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
$('desktop-signal').addEventListener('change', () => {
  try { localStorage.setItem(preferenceKey, JSON.stringify({ ...saved, signalBase: $('desktop-signal').value.trim(), endpoint: $('llm-endpoint').value, model: $('llm-model').value })); } catch { /* private browsing */ }
});

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
  state.peer?.disconnect();
  state.outgoingStream?.getTracks().forEach(track => track.stop());
  try { state.recognition?.stop(); } catch { /* closing */ }
});
