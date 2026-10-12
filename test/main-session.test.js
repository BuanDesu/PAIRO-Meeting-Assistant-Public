import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

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
    append(child) { this.children.push(child); }, remove() { this.removed = true; },
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
    document, Capacitor: { getPlatform: () => 'web' }, defaultRoleForPlatform: () => 'desktop',
    location: { hostname: 'localhost', protocol: 'http:', origin: 'http://localhost:5173' },
    window: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: () => 0, clearTimeout() {}, AbortController, MediaStream: Stream,
    PeerSession: class {}, HTMLElement: class {}, navigator: { mediaDevices: {} },
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext(source + '\nthis.review={state,submitQuestion,startDesktop,setRole,attachRemoteStream};', context);
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
