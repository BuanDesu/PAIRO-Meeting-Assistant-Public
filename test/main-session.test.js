import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { DEFAULT_SHORTCUTS, validateShortcuts, shortcutForEvent } from '../src/shortcuts.js';
import { MeetingEngine } from '../src/meeting-engine.js';
import { PrompterPublisher, PrompterReceiver } from '../src/prompter-sync.js';
import { randomUUID } from 'node:crypto';
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
    DEFAULT_SHORTCUTS, validateShortcuts, shortcutForEvent, OfflineVoiceInput, MeetingEngine, PrompterPublisher, PrompterReceiver, setupKnowledge() {},
    crypto: { randomUUID }, askModel: async () => '测试完整回答',
    __APP_VERSION__: '0.2.0',
    document, Capacitor: { getPlatform: () => 'web' }, defaultRoleForPlatform: () => 'desktop',
    location: { hostname: 'localhost', protocol: 'http:', origin: 'http://localhost:5173' },
    window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0, clearTimeout() {}, AbortController, URL, MediaStream: Stream,
    PeerSession: class {}, HTMLElement: class {}, navigator: { mediaDevices: {} },
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.review={makePeer,meeting,publisher,state,submitQuestion,startDesktop,changeDesktopCapture,stopCapture,endSession,setRole,attachRemoteStream,handleMobileMessage,handleDesktopMessage,navigatePage,dispatchDesktopHotkey,sendDesktopQuestion,resetConversation};', context);
  document.getElementById('llm-key').value = 'temporary-test-key';
  return { ...context.review, document, Stream };
}

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

test('desktop feed status follows phone connection and disconnection while sharing', () => {
  let callbacks;
  const fx = fixture({ PeerSession: class { constructor(options) { callbacks = options; this.phase = 'waiting'; } } });
  fx.state.displayStream = new fx.Stream();
  const peer = fx.makePeer('desktop'); fx.state.peer = peer;
  callbacks.onStatus('waiting');
  assert.equal(fx.document.getElementById('desktop-feed-status').textContent, '等待手机配对');
  peer.phase = 'connected'; callbacks.onStatus('connected');
  assert.equal(fx.document.getElementById('desktop-feed-status').textContent, '正在分享');
  peer.phase = 'disconnected'; callbacks.onStatus('disconnected');
  assert.equal(fx.document.getElementById('desktop-feed-status').textContent, '等待手机配对');
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

test('a selection read finishing after session departure is never sent', async () => {
  let finish; const sent = [];
  const fx = fixture({ window: { addEventListener() {}, desktopBridge: { onShortcut() {}, copySelection: () => new Promise(resolve => { finish = resolve; }) } } });
  fx.state.displayStream = new fx.Stream(); fx.state.peer = { phase: 'connected', send: async value => sent.push(value) };
  const reading = fx.dispatchDesktopHotkey('text');
  fx.state.peer = { phase: 'connected', send: async value => sent.push(value) };
  finish('old selection'); await reading; assert.equal(sent.length, 0);
});

test('one-to-one mode never requests microphone permission', async () => {
  let microphoneRequests = 0, systemAudioRequested;
  const video = { kind: 'video', addEventListener() {}, stop() {} }, audio = { kind: 'audio', stop() {} };
  const fx = fixture({ crypto: { getRandomValues: bytes => bytes.fill(1) },
    PeerSession: class { async replaceLocalStream() { return true; } async connect() {} disconnect() {} },
    ScreenshotTransfers: class { cancelAll() {} }, navigator: { mediaDevices: {
    getDisplayMedia: async options => { systemAudioRequested = options.audio; return new fx.Stream([video, audio]); },
    getUserMedia: async () => { microphoneRequests++; throw new Error('forbidden'); },
  } } });
  fx.document.getElementById('meeting-mode').value = 'one-to-one';
  fx.document.getElementById('capture-mic').checked = true;
  await fx.startDesktop(); assert.equal(microphoneRequests, 0); assert.equal(systemAudioRequested, true);
  assert.equal(fx.state.outgoingStream.getAudioTracks().length, 1);
});


test('PC submits once while phone ignores legacy model requests and typing responses', async () => {
  const calls = [], typed = [];
  const fx = fixture({ askModel: async args => { calls.push(args); return '电脑完整回答'; }, window: { addEventListener() {}, desktopBridge: { onShortcut() {}, prepareTyping: async () => 'token', typeAnswer: async v => typed.push(v), cancelTyping: async () => {} } } });
  fx.state.peer = { phase: 'connected', send: async () => {} };
  await fx.sendDesktopQuestion('电脑问题');
  assert.equal(calls.length, 1); assert.equal(fx.meeting.lastAnswer, '电脑完整回答');
  await fx.dispatchDesktopHotkey('type-answer'); // requires an active capture for a hotkey
  fx.state.displayStream = new fx.Stream();
  await fx.dispatchDesktopHotkey('type-answer');
  assert.equal(typed[0].text, '电脑完整回答');
  await fx.handleDesktopMessage({ type: 'answer-result', text: '手机伪造回答' });
  assert.equal(typed.length, 1);
  fx.state.role = 'mobile';
  await fx.submitQuestion('手机不能提问');
  await fx.handleMobileMessage({ type: 'request', text: '旧请求', autoAsk: true });
  await fx.handleMobileMessage({ type: 'screenshot', question: '旧截图' });
  assert.equal(calls.length, 1);
});

test('clear or a new question during typing preparation revokes the local answer', async () => {
  let prepare; const typed = [];
  const fx = fixture({ window: { addEventListener() {}, desktopBridge: { onShortcut() {}, prepareTyping: () => new Promise(r => prepare = r), typeAnswer: async v => typed.push(v), cancelTyping: async () => {} } } });
  fx.state.peer = { phase: 'connected', send: async () => {} }; fx.state.displayStream = new fx.Stream();
  await fx.submitQuestion('first');
  const pending = fx.dispatchDesktopHotkey('type-answer');
  fx.resetConversation(); prepare('token'); await pending;
  assert.equal(typed.length, 0); assert.equal(fx.meeting.lastAnswer, '');
});
test('first approval preserves PC preparation, but a new phone after an approved connection clears the private conversation', async () => {
  let callbacks;
  const fx = fixture({ PeerSession: class { constructor(value) { callbacks = value; this.awaitingApproval = true; } approvePeer() {} } });
  const peer = fx.state.peer = fx.makePeer('desktop');
  await fx.submitQuestion('prepared before first pairing');
  const allow = fx.document.getElementById('allow-peer').listeners.click;
  callbacks.onApproval(); allow(); assert.equal(fx.meeting.lastAnswer, '测试完整回答');
  peer.phase = 'connected'; callbacks.onStatus('connected');
  peer.phase = 'waiting'; callbacks.onStatus('waiting');
  callbacks.onApproval(); assert.equal(fx.meeting.lastAnswer, '测试完整回答');
  allow(); assert.equal(fx.meeting.lastAnswer, ''); assert.equal(fx.meeting.entries.length, 0);
});

test('stopping releases capture and pending screenshot, preserves sent questions, and resumes the same room', async () => {
  const track = kind => ({ kind, readyState: 'live', listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; }, stop() { this.readyState = 'ended'; } });
  const first = track('video'), system = track('audio'), mic = track('audio'), next = track('video');
  let mode = 'first', resolveAnswer;
  const calls = [];
  const fx = fixture({ crypto: { getRandomValues: bytes => bytes.fill(1) },
    PeerSession: class {
      phase = 'connected';
      async replaceLocalStream(stream) { this.stream = stream; return true; }
      async connect() { calls.push('connect'); }
      disconnect() { calls.push('disconnect'); }
      send() { return Promise.resolve(); }
    }, askModel: () => new Promise(resolve => { resolveAnswer = resolve; }), navigator: { mediaDevices: {
      getDisplayMedia: async () => {
        if (mode === 'cancel') throw Object.assign(new Error('cancel'), { name: 'NotAllowedError' });
        return new fx.Stream(mode === 'first' ? [first, system] : [next]);
      },
      getUserMedia: async () => { if (mode === 'first') return new fx.Stream([mic]); throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); },
    } } });
  fx.document.getElementById('capture-mic').checked = true;
  await fx.startDesktop(); const room = fx.state.room, peer = fx.state.peer;
  const answer = fx.submitQuestion('already submitted'); await tick();
  const crop = fx.state.screenshotController = new AbortController();
  first.listeners.ended(); // Browser's own stop-sharing action.
  assert.deepEqual([first, system, mic].map(track => track.readyState), ['ended', 'ended', 'ended']);
  assert.equal(crop.signal.aborted, true); assert.equal(fx.state.outgoingStream, null);
  assert.equal(fx.state.peer, peer); assert.equal(fx.state.room, room); assert.equal(peer.stream, null);
  resolveAnswer('retained'); await answer;
  mode = 'cancel'; await fx.startDesktop();
  assert.equal(fx.state.peer, peer); assert.equal(fx.state.room, room); assert.equal(peer.stream, null);
  mode = 'resume'; await fx.startDesktop();
  assert.equal(fx.state.peer, peer); assert.equal(fx.state.room, room); assert.equal(peer.stream.getVideoTracks()[0], next);
  assert.equal(peer.stream.getAudioTracks().length, 0);
  assert.equal(fx.meeting.lastAnswer, 'retained'); assert.deepEqual(calls, ['connect']);
  fx.stopCapture(); fx.stopCapture(); assert.equal(peer.stream, null); assert.equal(fx.meeting.lastAnswer, 'retained');
  fx.endSession(); assert.equal(fx.state.room, ''); assert.equal(fx.meeting.entries.length, 0); assert.deepEqual(calls, ['connect', 'disconnect']);
});

test('PC status distinguishes local completion, a slow send, disconnect, retry and lack of phone ACK', async () => {
  let callbacks, settle, reject;
  const fx = fixture({ PeerSession: class {
    constructor(value) { callbacks = value; }
    send() { return new Promise((resolve, fail) => { settle = resolve; reject = fail; }); }
  } });
  // Drive publisher flush explicitly; transport promises are controlled below.
  fx.publisher.changed = function () { this.dirty = true; };
  const peer = fx.state.peer = fx.makePeer('desktop');
  const status = () => fx.document.getElementById('model-queue-status').textContent;
  await fx.submitQuestion('completed locally'); assert.match(status(), /回答已完成 · 待连接手机/);
  peer.phase = 'connected'; callbacks.onStatus('connected'); assert.match(status(), /待发送至手机/);
  await fx.handleDesktopMessage({ type: 'prompter-ready', nonce: 'reader-old' });
  const stale = fx.publisher.flush(); assert.match(status(), /待发送至手机/);
  peer.phase = 'reconnecting'; callbacks.onStatus('lost'); assert.match(status(), /待连接手机/);
  peer.phase = 'connected'; callbacks.onStatus('connected');
  await fx.handleDesktopMessage({ type: 'prompter-ready', nonce: 'reader-new' });
  settle(); await stale; assert.match(status(), /待发送至手机/);
  const failed = fx.publisher.flush(); reject(new Error('closed')); await failed; assert.match(status(), /发送失败/);
  await fx.handleDesktopMessage({ type: 'prompter-ready', nonce: 'reader-retry' });
  const current = fx.publisher.flush(); assert.match(status(), /待发送至手机/);
  settle(); await current; assert.match(status(), /已发送 · 手机接收未确认/);
  fx.resetConversation(); assert.equal(status(), '没有待处理问题');
});
