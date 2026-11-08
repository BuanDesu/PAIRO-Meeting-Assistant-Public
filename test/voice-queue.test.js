import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceQueue, mirroredAudio } from '../src/voice-queue.js';
import { createRequire } from 'node:module';
const { createLanguageHints } = createRequire(import.meta.url)('../electron/speech-language.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const chunk = (source, startSample = 0) => ({ source, startSample, endSample: startSample + 16000, pcm: new ArrayBuffer(32000) });

test('both ready sources get a turn, overflow stops intake and drains the accepted three jobs', async () => {
  const started = [], releases = [], submitted = [], statuses = [];
  let full = 0, drained = 0;
  const queue = new VoiceQueue({
    transcribe: async (_, source) => { started.push(source); return new Promise(resolve => releases.push(() => resolve({ text: source + started.length }))); },
    onText: text => submitted.push(text), onStatus: text => statuses.push(text), onError: error => { throw error; },
    onFull: () => full++, onDrained: () => drained++,
  });
  assert.equal(queue.push(chunk('system')), true);
  queue.push(chunk('system', 16000)); queue.push(chunk('microphone'));
  assert.equal(queue.push(chunk('system', 32000)), false);
  assert.equal(full, 1); assert.equal(drained, 0);
  releases.shift()(); await tick();
  assert.deepEqual(started, ['system', 'microphone']);
  releases.shift()(); await tick();
  assert.deepEqual(started, ['system', 'microphone', 'system']);
  releases.shift()(); await tick();
  assert.equal(submitted.length, 3); assert.equal(drained, 1);
  assert.equal(queue.push(chunk('microphone', 64000)), false);
});

test('cancel discards in-flight and queued old-generation text, leaving a fresh queue usable', async () => {
  let release; const submitted = [];
  const queue = new VoiceQueue({ transcribe: () => new Promise(resolve => { release = resolve; }),
    onText: text => submitted.push(text), onStatus() {}, onError: error => { throw error; }, onFull() {}, onDrained() {} });
  queue.push(chunk('system')); queue.push(chunk('microphone'));
  queue.cancel(); release({ text: 'late' }); await tick();
  assert.equal(submitted.length, 0); assert.equal(queue.waiting.length, 0);
});

test('only time-aligned waveform copies with the same decoded text merge; later and independent repeats remain', async () => {
  let seed = 713;
  const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296 - 0.5);
  const system = { ...chunk('system'), pcm: Int16Array.from({ length: 16000 }, () => Math.round(10000 * random())).buffer };
  const microphone = { ...chunk('microphone'), pcm: Int16Array.from(new Int16Array(system.pcm), x => Math.round(x * 0.3)).buffer };
  assert.equal(mirroredAudio(system, microphone), true);
  assert.equal(mirroredAudio(system, { ...microphone, startSample: 32000, endSample: 48000 }), false);
  assert.equal(mirroredAudio(system, { ...chunk('microphone'), pcm: Int16Array.from({ length: 16000 }, () => Math.round(10000 * random())).buffer }), false);
  const submitted = [];
  const queue = new VoiceQueue({ transcribe: async () => ({ text: '再次确认。' }), onText: text => submitted.push(text),
    onStatus() {}, onError: error => { throw error; }, onFull() {}, onDrained() {} });
  queue.push(system); await tick(); queue.push(microphone); await tick();
  assert.equal(submitted.length, 1);
  queue.push({ ...microphone, startSample: 32000, endSample: 48000 }); await tick();
  assert.equal(submitted.length, 2);
});

test('short language hints require two long accepted results on the same source, expire and reset', () => {
  let now = 0;
  const hints = createLanguageHints(() => now);
  const zh = { result: { language: 'zh' } }, text = { text: '接下来请确认会议的具体安排。' };
  hints.observe('microphone', zh, text, 4);
  assert.equal(hints.select('microphone', 'auto', 0.7), 'auto');
  hints.observe('microphone', zh, text, 4);
  assert.equal(hints.select('microphone', 'auto', 0.7), 'zh');
  assert.equal(hints.select('system', 'auto', 0.7), 'auto');
  assert.equal(hints.select('microphone', 'auto', 4), 'auto');
  assert.equal(hints.select('microphone', 'en', 0.7), 'en');
  now = 90001;
  assert.equal(hints.select('microphone', 'auto', 0.7), 'auto');
  hints.observe('system', { result: { language: 'en' } }, { text: 'Please confirm the deployment schedule.' }, 4);
  hints.observe('system', { result: { language: 'en' } }, { text: 'Please confirm the deployment schedule.' }, 4);
  assert.equal(hints.select('system', 'auto', 0.7), 'en');
  hints.clear(); assert.equal(hints.select('system', 'auto', 0.7), 'auto');
});
