import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, truncate, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const { createOfflineSpeech, pcmWave, MODEL } = createRequire(import.meta.url)('../electron/offline-speech.cjs');

test('native audio input is bounded mono 16 kHz PCM, with no caller-supplied command or path', () => {
  const wav = pcmWave(new ArrayBuffer(32000));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
  for (const invalid of [null, 'audio.wav', { path: 'arbitrary.exe' }, new ArrayBuffer(3), new ArrayBuffer(500000)]) assert.throws(() => pcmWave(invalid), /格式/);
});

test('cancelled inference discards text, removes temporary audio and frees the serial runner', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pairo-speech-test-'));
  try {
    const engine = path.join(directory, 'offline-speech/engine-1.8.3'); await mkdir(engine, { recursive: true });
    await writeFile(path.join(engine, 'whisper-cli.exe'), 'fixture');
    const model = path.join(directory, 'offline-speech/ggml-tiny.bin'); await writeFile(model, ''); await truncate(model, MODEL.size);
    let started, release, paused = true, transcript = 'late private transcript';
    const running = new Promise(resolve => { started = resolve; });
    const speech = createOfflineSpeech(directory, { platform: 'win32', arch: 'x64', run: async (_exe, args) => {
      if (paused) { started(); await new Promise(resolve => { release = resolve; }); }
      await writeFile(args[args.indexOf('-of') + 1] + '.txt', transcript);
    } });
    await speech.initialize();
    const first = speech.transcribe(new ArrayBuffer(32000)); await running;
    await assert.rejects(speech.transcribe(new ArrayBuffer(32000)), /上一段/);
    speech.cancel(); release(); assert.equal(await first, '');
    assert.deepEqual(await readdir(path.join(directory, 'offline-speech/work')), []);
    paused = false;
    transcript = '請確認麥克風測試成功，會議開始。DeepSeek API v1: 2 + 3 = 5.';
    assert.equal(await speech.transcribe(new ArrayBuffer(32000)), '请确认麦克风测试成功，会议开始。DeepSeek API v1: 2 + 3 = 5.');
    assert.deepEqual(await readdir(path.join(directory, 'offline-speech/work')), []);
  } finally {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('pairo-speech-test-')) throw new Error('Unsafe test cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

test('production worklet skips silence and emits bounded 16 kHz speech chunks', async () => {
  let Processor; const messages = [];
  const context = { sampleRate: 48000, AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => messages.push(data) }; } }, registerProcessor: (_name, value) => { Processor = value; } };
  vm.runInNewContext(await readFile(new URL('../src/voice-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor(), silence = new Float32Array(128), voice = new Float32Array(128).fill(0.15);
  for (let i = 0; i < 5000; i++) processor.process([[silence]]);
  assert.equal(messages.length, 0);
  for (let i = 0; i < 500; i++) processor.process([[voice]]);
  for (let i = 0; i < 400; i++) processor.process([[silence]]);
  assert.equal(messages.length, 1); assert.ok(messages[0].byteLength > 3200 && messages[0].byteLength <= 16000 * 2 * 12);
});
