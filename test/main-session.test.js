import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { DEFAULT_SHORTCUTS, validateShortcuts, shortcutForEvent } from '../src/shortcuts.js';
import { OfflineVoiceInput } from '../src/voice-input.js';

const source = (await readFile(new URL('../src/main.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(overrides = {}) {
  const elements = new Map();
  const element = (id = '') => ({
    id, value: '', checked: false, hidden: false, disabled: false, srcObject: null, children: [], listeners: {},
    classList: { add() {}, remove() {}, toggle() {} }, firstChild: { textContent: '' },
    previousElementSibling: { classList: { toggle() {} } },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    setAttribute() {}, removeAttribute() {}, focus() {},
    append(...children) { this.children.push(...children); }, remove() { this.removed = true; },
    querySelectorAll() { return this.children; },
  });
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
    createElement() { return element(); }, addEventListener() {},
  };
  class Stream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
  }
  const context = {
    DEFAULT_SHORTCUTS, validateShortcuts, shortcutForEvent, OfflineVoiceInput,
    __APP_VERSION__: '0.2.0',
    document, Capacitor: { getPlatform: () => 'web' }, defaultRoleForPlatform: () => 'desktop',
    location: { hostname: 'localhost', protocol: 'http:', origin: 'http://localhost:5173' },
    window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0, clearTimeout() {}, AbortController, MediaStream: Stream,
    PeerSession: class {}, HTMLElement: class {}, navigator: { mediaDevices: {} },
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.review={state,submitQuestion,startDesktop,changeDesktopCapture,setRole,attachRemoteStream,handleMobileMessage,handleDesktopMessage,navigatePage,dispatchDesktopHotkey,sendDesktopQuestion,resetConversation};', context);
  document.getElementById('llm-key').value = 'temporary-test-key';
  return { ...context.review, document, Stream };
}

test('room departure cancels requests and never forwards late answers into a new room', async () => {
  let finish, requestSignal;
  const fx = fixture({ askModel: args => { requestSignal = args.signal; return new Promise(resolve => { finish = resolve; }); } });
  const sent = [];
  fx.state.role = 'mobile';
  fx.state.peer = { disconnect() {}, send() {} };
  fx.state.latestImage = 'data:image/jpeg;base64,PRIVATE';
  fx.state.chatHistory = [{ role: 'user', content: 'private history' }];
  fx.document.getElementById('desktop-answer').textContent = 'previous private answer';
  const request = fx.submitQuestion('room A question');
  await tick();
  fx.document.getElementById('leave-room').listeners.click();
  assert.equal(requestSignal.aborted, true);
  assert.equal(fx.state.latestImage, '');
  assert.equal(fx.state.chatHistory.length, 0);
  fx.state.peer = { send: message => sent.push(message) };
  finish('private answer for A');
  await request;
  assert.equal(sent.length, 0);
  assert.equal(fx.state.chatHistory.length, 0);
  assert.equal(fx.state.lastAnswer, '');
  assert.equal(fx.document.getElementById('desktop-answer').textContent, '');
});

test('automatic requests run in order with completed history and correct busy state', async () => {
  const calls = [], finishes = [];
  const fx = fixture({ askModel: args => { calls.push({ question: args.question, history: [...args.history] }); return new Promise(resolve => finishes.push(resolve)); } });
  const first = fx.submitQuestion('first');
  const second = fx.submitQuestion('second');
  await tick();
  assert.equal(calls.length, 1);
  finishes[0]('answer one');
  await first; await tick();
  assert.equal(fx.document.getElementById('send-button').disabled, true);
  assert.equal(calls[1].history.length, 2);
  finishes[1]('answer two');
  await second;
  assert.equal(fx.document.getElementById('send-button').disabled, false);
  assert.equal(fx.state.chatHistory.length, 4);
});

test('clearing chat invalidates active model work', async () => {
  let finish;
  const fx = fixture({ askModel: () => new Promise(resolve => { finish = resolve; }) });
  const request = fx.submitQuestion('question'); await tick();
  fx.document.getElementById('clear-chat').listeners.click();
  finish('late answer'); await request;
  assert.equal(fx.state.lastAnswer, '');
  assert.equal(fx.state.chatHistory.length, 0);
  assert.equal(fx.document.getElementById('send-button').disabled, false);
});

test('switching roles during display permission cannot restart sharing', async () => {
  let finish;
  const fx = fixture({ navigator: { mediaDevices: { getDisplayMedia: () => new Promise(resolve => { finish = resolve; }) } } });
  const sharing = fx.startDesktop();
  fx.setRole('mobile');
  const track = { kind: 'video', stop() { this.stopped = true; } };
  finish(new fx.Stream([track])); await sharing;
  assert.equal(track.stopped, true);
  assert.equal(fx.state.peer, null);
  assert.equal(fx.state.displayStream, null);
});

test('switching roles during microphone permission stops both captured streams', async () => {
  let finishMicrophone;
  const video = { kind: 'video', addEventListener() {}, stop() { this.stopped = true; } };
  const microphone = { kind: 'audio', stop() { this.stopped = true; } };
  const fx = fixture({ navigator: { mediaDevices: {
    getDisplayMedia: async () => new fx.Stream([video]),
    getUserMedia: () => new Promise(resolve => { finishMicrophone = resolve; }),
  } } });
  fx.document.getElementById('capture-mic').checked = true;
  const sharing = fx.startDesktop(); await tick();
  fx.setRole('mobile');
  finishMicrophone(new fx.Stream([microphone])); await sharing;
  assert.equal(video.stopped, true);
  assert.equal(microphone.stopped, true);
  assert.equal(fx.state.outgoingStream, null);
});

test('empty remote streams detach old audio', () => {
  const fx = fixture();
  fx.document.getElementById('remote-audio').srcObject = new fx.Stream([{ kind: 'audio', id: 'old' }]);
  fx.attachRemoteStream(new fx.Stream());
  assert.equal(fx.document.getElementById('remote-audio').srcObject, null);
});

test('native picker cancellation gives Chinese guidance without creating capture or a room', async () => {
  const error = Object.assign(new Error('Invalid capture constraints'), { name: 'TypeError' });
  const fx = fixture({ window: { addEventListener() {}, desktopBridge: { onShortcut() {}, getSignalInfo: async () => ({ signalBase: 'http://localhost:8787', lanAddresses: [] }), readPreferences: async () => ({}) } },
    navigator: { mediaDevices: { getDisplayMedia: async () => { throw error; } } } });
  await tick(); await fx.startDesktop();
  assert.equal(fx.state.displayStream, null); assert.equal(fx.state.peer, null);
  assert.equal(fx.document.getElementById('start-share').disabled, false);
  assert.match(fx.document.getElementById('desktop-status').textContent, /分享未开始/);
  assert.ok(!fx.document.getElementById('desktop-activity').textContent.includes('Invalid'));
  const previous = { kind: 'video', stop() { this.stopped = true; } };
  fx.state.displayStream = new fx.Stream([previous]); fx.state.peer = {};
  await fx.changeDesktopCapture();
  assert.equal(previous.stopped, undefined);
  assert.match(fx.document.getElementById('desktop-activity').textContent, /继续分享原来的画面/);
});

test('changing capture retains the paired room, microphone and conversation; cancellation keeps the original source', async () => {
  const track = kind => ({ kind, addEventListener() {}, stop() { this.stopped = true; } });
  const previous = track('video'), next = track('video'), microphone = track('audio');
  let rejectPicker = false, requestedAudio;
  const fx = fixture({ navigator: { mediaDevices: { getDisplayMedia: async options => {
    requestedAudio = options.audio;
    if (rejectPicker) throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' });
    return new fx.Stream([next]);
  } } } });
  const peer = fx.state.peer = { replaceLocalStream: async stream => { peer.stream = stream; } };
  fx.state.displayStream = new fx.Stream([previous]); fx.state.outgoingStream = new fx.Stream([previous, microphone]);
  fx.state.room = 'EXISTING'; fx.state.latestImage = 'keep attachment';
  await fx.changeDesktopCapture();
  assert.equal(requestedAudio, false); assert.equal(previous.stopped, true); assert.equal(microphone.stopped, undefined);
  assert.deepEqual([...peer.stream.getTracks()], [next, microphone]);
  assert.equal(fx.state.peer, peer); assert.equal(fx.state.room, 'EXISTING'); assert.equal(fx.state.latestImage, 'keep attachment');
  rejectPicker = true;
  await fx.changeDesktopCapture();
  assert.equal(next.stopped, undefined); assert.equal(fx.state.displayStream.getVideoTracks()[0], next);
  assert.equal(fx.state.captureSwitchPending, false); assert.equal(fx.document.getElementById('change-share').disabled, false);
});

test('ending the session during capture replacement releases the new source without resurrecting the room', async () => {
  let finish;
  const track = { kind: 'video', stop() { this.stopped = true; } };
  const fx = fixture({ navigator: { mediaDevices: { getDisplayMedia: () => new Promise(resolve => { finish = resolve; }) } } });
  const old = { kind: 'video', stop() {} };
  fx.state.displayStream = new fx.Stream([old]); fx.state.outgoingStream = new fx.Stream([old]);
  fx.state.peer = { disconnect() {}, replaceLocalStream: async () => { throw new Error('Must not replace a departed session'); } };
  const changing = fx.changeDesktopCapture(); fx.setRole('mobile');
  finish(new fx.Stream([track])); await changing;
  assert.equal(track.stopped, true); assert.equal(fx.state.peer, null); assert.equal(fx.state.displayStream, null);
});

test('cancel waiting preserves context and a fresh request cannot be overwritten by an old result', async () => {
  const finishes = [];
  const fx = fixture({ askModel: () => new Promise(resolve => finishes.push(resolve)) });
  fx.state.chatHistory = [{ role: 'user', content: 'keep this context' }];
  fx.state.latestImage = 'keep this screenshot';
  const old = fx.submitQuestion('old question'); await tick();
  fx.document.getElementById('cancel-model').listeners.click();
  assert.equal(fx.state.modelPending, 0);
  assert.equal(fx.state.chatHistory.length, 1);
  assert.equal(fx.state.latestImage, 'keep this screenshot');
  const fresh = fx.submitQuestion('fresh question'); await tick();
  finishes[1]('fresh answer'); await fresh;
  finishes[0]('old answer'); await old;
  assert.equal(fx.state.lastAnswer, 'fresh answer');
  assert.equal(fx.state.modelPending, 0);
  assert.equal(fx.state.chatHistory.length, 3);
});

test('retry uses corrected settings and a departed room discards the retry attachment', async () => {
  let fail = true, received;
  const fx = fixture({ askModel: async args => { if (fail) throw new Error('invalid API Key'); received = args; return 'answer'; } });
  await fx.submitQuestion('retry question', 'screenshot');
  assert.equal(fx.document.getElementById('retry-model').hidden, false);
  fx.document.getElementById('llm-key').value = 'corrected-key';
  fail = false;
  fx.document.getElementById('retry-model').listeners.click(); await tick();
  assert.equal(received.apiKey, 'corrected-key');
  assert.equal(received.imageDataUrl, 'screenshot');
  fx.document.getElementById('leave-room').listeners.click();
  assert.equal(fx.state.retryRequest, null);
});

test('changing AI configuration invalidates a pending connection test', async () => {
  let finish, captured;
  const fx = fixture({ askModel: args => { captured = args; return new Promise(resolve => { finish = resolve; }); } });
  const testing = fx.document.getElementById('test-model').listeners.click(); await tick();
  assert.equal(captured.imageDataUrl, undefined);
  assert.equal(captured.history, undefined);
  fx.document.getElementById('llm-model').listeners.input();
  assert.equal(captured.signal.aborted, true);
  finish('late success'); await testing;
  assert.match(fx.document.getElementById('model-test-status').textContent, /配置已更改/);
});

test('non-secret preferences persist on input before blur while API Key editing never writes a secret', () => {
  const writes = [];
  const fx = fixture({ localStorage: { getItem: () => null, setItem: (_key, value) => writes.push(JSON.parse(value)) } });
  fx.state.role = 'mobile';
  for (const [id, value] of [['mobile-signal', 'http://192.168.1.7:8787'], ['llm-endpoint', 'https://model.example/v1/chat/completions'], ['llm-model', 'vision-model']]) {
    fx.document.getElementById(id).value = value; fx.document.getElementById(id).listeners.input();
  }
  assert.deepEqual(writes.at(-1), { signalBase: 'http://192.168.1.7:8787', endpoint: 'https://model.example/v1/chat/completions', model: 'vision-model' });
  const count = writes.length;
  fx.document.getElementById('llm-key').value = 'must-never-persist'; fx.document.getElementById('llm-key').listeners.input();
  assert.equal(writes.length, count); assert.ok(!JSON.stringify(writes).includes('must-never-persist'));
});

test('partial answers show before completion but cancellation rejects late updates and forwarding', async () => {
  let finish, onPartial;
  const sent = [];
  const fx = fixture({ askModel: args => { onPartial = args.onPartial; return new Promise(resolve => { finish = resolve; }); } });
  fx.state.peer = { send: async message => sent.push(message) };
  const request = fx.submitQuestion('流式问题'); await tick();
  onPartial('正在逐步回答');
  const pending = [...fx.state.modelNodes][0];
  const body = pending.children.at(-1);
  assert.equal(body.textContent, '正在逐步回答');
  assert.equal(fx.state.chatHistory.length, 0);
  assert.equal(sent.length, 0);
  fx.document.getElementById('cancel-model').listeners.click();
  onPartial('不应显示的迟到内容'); finish('不应提交的答案'); await request;
  assert.equal(body.textContent, '正在逐步回答');
  assert.equal(pending.removed, true);
  assert.equal(fx.state.lastAnswer, '');
  assert.equal(sent.length, 0);
});

test('leaving during screenshot decoding discards image and acknowledgment even if decoding finishes late', async () => {
  let finish, decodeSignal;
  const sent = [];
  const fx = fixture({ decodeScreenshot: (_message, options) => { decodeSignal = options.signal; return new Promise(resolve => { finish = resolve; }); }, validScreenshotId: () => true });
  fx.state.role = 'mobile';
  fx.state.peer = { disconnect() {}, send: async message => sent.push(message) };
  const receiving = fx.handleMobileMessage({ type: 'screenshot', id: 'old-room', image: 'private-image' });
  await tick();
  fx.document.getElementById('leave-room').listeners.click();
  assert.equal(decodeSignal.aborted, true);
  fx.state.peer = { send: async message => sent.push(message) };
  finish(); await receiving;
  assert.equal(sent.length, 0);
  assert.equal(fx.state.latestImage, '');
  assert.equal(fx.state.screenshotReceivers.size, 0);
});

test('Num3 copies selection without navigation or focus and sends a text-only automatic question', async () => {
  const sent = [];
  const fx = fixture({ window: { addEventListener() {}, desktopBridge: { onShortcut() {}, copySelection: async () => '选中的问题是什么？' } } });
  const peer = fx.state.peer = { phase: 'connected', send: async message => sent.push(message) };
  fx.state.displayStream = new fx.Stream(); fx.state.room = 'SAME-ROOM';
  fx.state.latestImage = 'data:image/png;base64,OLD';
  fx.navigatePage('desktop', 'keys');
  assert.equal(fx.state.peer, peer); assert.equal(fx.state.room, 'SAME-ROOM');
  await fx.dispatchDesktopHotkey('text');
  assert.equal(fx.state.pages.desktop, 'keys');
  assert.equal(sent.length, 1); assert.equal(sent[0].text, '选中的问题是什么？');
  assert.equal(sent[0].autoAsk, true); assert.equal(sent[0].image, undefined);
});

test('a selection read finishing after session departure is never sent', async () => {
  let finish; const sent = [];
  const fx = fixture({ window: { addEventListener() {}, desktopBridge: { onShortcut() {}, copySelection: () => new Promise(resolve => { finish = resolve; }) } } });
  fx.state.displayStream = new fx.Stream(); fx.state.peer = { phase: 'connected', send: async value => sent.push(value) };
  const reading = fx.dispatchDesktopHotkey('text');
  fx.state.peer = { phase: 'connected', send: async value => sent.push(value) };
  finish('old selection'); await reading; assert.equal(sent.length, 0);
});

test('ongoing voice questions revoke answer typing without discarding a new selection; a session reset still discards it', async () => {
  let finish; const sent = [];
  const fx = fixture({ window: { addEventListener() {}, desktopBridge: { onShortcut() {}, copySelection: () => new Promise(resolve => { finish = resolve; }) } } });
  fx.state.displayStream = new fx.Stream(); fx.state.peer = { phase: 'connected', send: async value => sent.push(value) };
  let reading = fx.dispatchDesktopHotkey('text');
  await fx.handleDesktopMessage({ type: 'answer-invalidated' });
  finish('selected while voice is active'); await reading;
  assert.equal(sent.length, 1); assert.equal(sent[0].text, 'selected while voice is active');
  reading = fx.dispatchDesktopHotkey('text'); fx.resetConversation();
  finish('belongs to previous session'); await reading; assert.equal(sent.length, 1);
});

test('answer is retrieved only by matching explicit request, never displayed, and repeated hotkey cancels', async () => {
  const token = 'a'.repeat(32), sent = [], typed = []; let stops = 0;
  const fx = fixture({ window: { addEventListener() {}, desktopBridge: { onShortcut() {}, prepareTyping: async () => token, typeAnswer: async value => typed.push(value), cancelTyping: async () => { stops++; } } } });
  fx.state.displayStream = new fx.Stream(); fx.state.peer = { phase: 'connected', send: async value => sent.push(value) };
  await fx.handleDesktopMessage({ type: 'answer-result', id: token, status: 'ready', text: 'unsolicited' }); assert.equal(typed.length, 0);
  await fx.dispatchDesktopHotkey('type-answer');
  assert.equal(sent[0].type, 'answer-request');
  await fx.handleDesktopMessage({ type: 'answer-result', id: 'b'.repeat(32), status: 'ready', text: 'wrong token' }); assert.equal(typed.length, 0);
  await fx.handleDesktopMessage({ type: 'answer-result', id: token, status: 'ready', text: '完整回答' });
  assert.equal(typed[0].text, '完整回答'); assert.ok(!fx.document.getElementById('desktop-answer').textContent);
  await fx.dispatchDesktopHotkey('type-answer'); await fx.dispatchDesktopHotkey('type-answer');
  await fx.handleDesktopMessage({ type: 'answer-result', id: token, status: 'ready', text: 'late' });
  assert.equal(typed.length, 1); assert.ok(stops >= 2);
});

test('new question, mobile clear and peer departure invalidate a pending typing request', async () => {
  const typed = []; const token = 'c'.repeat(32);
  const fx = fixture({ window: { addEventListener() {}, desktopBridge: { onShortcut() {}, prepareTyping: async () => token, typeAnswer: async value => typed.push(value), cancelTyping: async () => {} } } });
  fx.state.displayStream = new fx.Stream(); fx.state.peer = { phase: 'connected', send: async () => {} };
  for (const invalidate of [() => fx.handleDesktopMessage({ type: 'answer-invalidated' }), () => fx.sendDesktopQuestion('new voice question'), () => fx.resetConversation()]) {
    await fx.dispatchDesktopHotkey('type-answer'); await invalidate();
    await fx.handleDesktopMessage({ type: 'answer-result', id: token, status: 'ready', text: 'old answer' });
  }
  assert.equal(typed.length, 0); assert.equal(fx.state.typingRequest, null);
});

test('phone never falls back to a previous success when the newest queued question fails', async () => {
  const sent = [];
  const fx = fixture({ askModel: async ({ question }) => { if (question === 'failure') throw new Error('provider unavailable'); return 'previous success'; } });
  fx.state.role = 'mobile'; fx.state.peer = { phase: 'connected', send: async value => sent.push(value) };
  const first = fx.submitQuestion('success'), second = fx.submitQuestion('failure');
  await first; await second;
  await fx.handleMobileMessage({ type: 'answer-request', id: 'e'.repeat(32) });
  assert.equal(sent.at(-1).status, 'empty'); assert.equal(sent.at(-1).text, undefined);
});

test('phone shares only a completed current answer, and failed/cancelled questions revoke older answers', async () => {
  const sent = []; let finish;
  const fx = fixture({ askModel: () => new Promise(resolve => { finish = resolve; }) });
  fx.state.role = 'mobile'; fx.state.peer = { phase: 'connected', send: async value => sent.push(value) };
  fx.state.lastAnswer = 'old answer';
  const request = fx.submitQuestion('new question'); await tick();
  const id = 'd'.repeat(32);
  await fx.handleMobileMessage({ type: 'answer-request', id });
  assert.equal(sent.at(-1).status, 'busy'); assert.equal(sent.at(-1).text, undefined);
  finish('latest complete answer'); await request;
  assert.equal(sent.filter(item => item.type === 'answer-result').length, 1); // no automatic answer push
  await fx.handleMobileMessage({ type: 'answer-request', id }); assert.equal(sent.at(-1).text, 'latest complete answer');
  fx.document.getElementById('cancel-model').listeners.click();
  await fx.handleMobileMessage({ type: 'answer-request', id }); assert.equal(sent.at(-1).status, 'empty');
  fx.state.lastAnswer = 'previous';
  fx.document.getElementById('llm-key').value = '';
  await fx.submitQuestion('cannot submit');
  await fx.handleMobileMessage({ type: 'answer-request', id }); assert.equal(sent.at(-1).status, 'empty');
});

test('screenshot auto-question waits for decoding and uses its own image even when automatic reception is disabled', async () => {
  let decoded; const calls = [], sent = [];
  const fx = fixture({ decodeScreenshot: () => new Promise(resolve => { decoded = resolve; }), validScreenshotId: () => true, askModel: async args => { calls.push(args); return 'phone only'; } });
  fx.state.role = 'mobile'; fx.state.peer = { send: async message => sent.push(message) };
  const image = 'data:image/jpeg;base64,TEST';
  const receiving = fx.handleMobileMessage({ type: 'screenshot', id: 'new-shot', image, question: '回答图中问题' });
  await tick(); assert.equal(calls.length, 0);
  decoded(); await receiving; await tick(); await fx.state.modelQueue;
  assert.equal(calls.length, 1); assert.equal(calls[0].imageDataUrl, image);
  assert.equal(calls[0].question, '回答图中问题'); assert.equal(fx.state.pages.mobile, 'chat');
  assert.deepEqual(sent.map(message => message.type), ['screenshot-ack']);
  fx.handleDesktopMessage({ type: 'answer', text: 'must never display' });
  assert.notEqual(fx.document.getElementById('desktop-answer').textContent, 'must never display');
});

test('one-to-one mode never requests microphone permission', async () => {
  let microphoneRequests = 0, systemAudioRequested;
  const video = { kind: 'video', addEventListener() {}, stop() {} }, audio = { kind: 'audio', stop() {} };
  const fx = fixture({ crypto: { getRandomValues: bytes => bytes.fill(1) },
    PeerSession: class { setLocalStream() {} async connect() {} disconnect() {} },
    ScreenshotTransfers: class { cancelAll() {} }, navigator: { mediaDevices: {
    getDisplayMedia: async options => { systemAudioRequested = options.audio; return new fx.Stream([video, audio]); },
    getUserMedia: async () => { microphoneRequests++; throw new Error('forbidden'); },
  } } });
  fx.document.getElementById('meeting-mode').value = 'one-to-one';
  fx.document.getElementById('capture-mic').checked = true;
  await fx.startDesktop(); assert.equal(microphoneRequests, 0); assert.equal(systemAudioRequested, true);
  assert.equal(fx.state.outgoingStream.getAudioTracks().length, 1);
});
