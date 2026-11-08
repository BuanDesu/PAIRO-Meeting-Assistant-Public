import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readdir, rm, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { createOfflineSpeech, pcmWave, downloadPinned } = require('../electron/offline-speech.cjs');
const { MODELS, VAD } = require('../electron/speech-assets.cjs');
const { vadSpans, decodeResult } = require('../electron/speech-decision.cjs');

test('native audio input is bounded mono 16 kHz PCM, with no caller-supplied command or path', () => {
  const wav = pcmWave(new ArrayBuffer(32000));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
  for (const invalid of [null, 'audio.wav', { path: 'arbitrary.exe' }, new ArrayBuffer(3), new ArrayBuffer(500000)]) assert.throws(() => pcmWave(invalid), /格式/);
});

const syntheticDecode = (text, p = 0.8) => ({ transcription: [{ text, tokens: [{ id: 100, text, p }, { id: 50364, text: '[_BEG_]', p: 0 }] }] });
const vadFixture = 'Detected 1 speech segments:\r\nSpeech segment 0: start = 3.00, end = 90.00\r\n';
test('pinned VAD output rejects malformed timing; actual token scores and repetition gate bad decodes, not short replies', () => {
  assert.deepEqual(vadSpans(vadFixture, 16000), [[480, 14400]]);
  assert.deepEqual(vadSpans('Detected 0 speech segments:\n', 16000), []);
  for (const bad of ['', 'Detected 1 speech segments:', 'Detected 1 speech segments:\nSpeech segment 0: start = 90.00, end = 3.00']) assert.throws(() => vadSpans(bad, 16000), /异常/);
  assert.deepEqual(decodeResult(syntheticDecode('對。')), { text: '对。', reason: 'ok' });
  assert.equal(decodeResult(syntheticDecode('Yes.')).text, 'Yes.');
  assert.equal(decodeResult(syntheticDecode('嗯嗯，好的。')).reason, 'ok');
  assert.equal(decodeResult(syntheticDecode('确认 [API] 状态。')).reason, 'ok');
  for (const json of [syntheticDecode('低可信文本', 0.07), syntheticDecode('谢谢谢谢谢谢谢谢谢谢谢谢'), syntheticDecode('repeat the test repeat the test repeat the test repeat the test'), syntheticDecode('[BLANK_AUDIO] [clock ticking]'), syntheticDecode('（banging）'), { transcription: [{ text: 'No real score' }] }]) assert.equal(decodeResult(json).reason, 'uncertain');
});
test('serial speech checks VAD before ASR; cancel/restart discards old text and cleans temporary audio', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pairo-speech-test-'));
  try {
    const engine = path.join(directory, 'offline-speech/engine-1.8.3'); await mkdir(engine, { recursive: true });
    await writeFile(path.join(engine, 'whisper-cli.exe'), 'fixture'); await writeFile(path.join(engine, 'whisper-vad-speech-segments.exe'), 'fixture');
    let started, release, paused = true, transcript = 'late private transcript', heard = false, calls = [];
    const running = new Promise(resolve => { started = resolve; });
    const speech = createOfflineSpeech(directory, { platform: 'win32', arch: 'x64', verifyAsset: async (_path, asset) => asset === VAD || asset === MODELS.light,
      run: async (exe, args) => {
        calls.push({ exe: path.basename(exe), args });
        if (exe.endsWith('whisper-vad-speech-segments.exe')) return heard ? vadFixture : 'Detected 0 speech segments:\n';
        const text = transcript;
        if (paused) { started(); await new Promise(resolve => { release = resolve; }); }
        await writeFile(args[args.indexOf('-of') + 1] + '.json', JSON.stringify(syntheticDecode(text)));
      },
    });
    await speech.initialize();
    assert.equal((await speech.status()).downloadBytes, MODELS.balanced.size);
    await assert.rejects(async () => speech.configure({ profile: '../model', language: 'zh' }), /设置/);
    assert.equal((await speech.configure({ profile: 'light', language: 'zh' })).ready, true);
    assert.equal((await speech.transcribe(new ArrayBuffer(32000))).reason, 'silence');
    assert.equal(calls.length, 1, 'unvoiced audio never starts Whisper decoding');
    heard = true;
    const first = speech.transcribe(new ArrayBuffer(32000)); await running;
    await assert.rejects(speech.transcribe(new ArrayBuffer(32000)), /上一段/);
    await assert.rejects(speech.configure({ profile: 'light', language: 'zh' }), /先停止/);
    speech.cancel();
    paused = false;
    transcript = '請確認麥克風測試成功，會議開始。DeepSeek API v1: 2 + 3 = 5.';
    const configuring = speech.configure({ profile: 'light', language: 'zh' });
    const restarted = speech.transcribe(new ArrayBuffer(32000)); release();
    await configuring;
    assert.deepEqual(await first, { text: '', reason: 'cancelled' });
    assert.equal((await restarted).text, '请确认麦克风测试成功，会议开始。DeepSeek API v1: 2 + 3 = 5.');
    assert.equal(calls.at(-1).args[calls.at(-1).args.indexOf('-l') + 1], 'zh');
    const reloaded = createOfflineSpeech(directory, { platform: 'win32', arch: 'x64', verifyAsset: async () => true });
    await reloaded.initialize(); assert.deepEqual((await reloaded.status()).settings, { profile: 'light', language: 'zh' });
    assert.deepEqual(await readdir(path.join(directory, 'offline-speech/work')), []);
  } finally {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('pairo-speech-test-')) throw new Error('Unsafe test cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

test('downloads reject modified or redirected-to-untrusted components', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pairo-speech-assets-'));
  t.after(async () => {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('pairo-speech-assets-')) throw new Error('Unsafe test cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  const contents = 'local test bytes', asset = { url: 'https://huggingface.co/fixture/pinned', size: contents.length, sha256: createHash('sha256').update(contents).digest('hex') };
  const file = path.join(directory, 'verified');
  await downloadPinned(asset, file, async () => new Response(contents)); assert.equal(await readFile(file, 'utf8'), contents);
  await assert.rejects(downloadPinned(asset, path.join(directory, 'wrong'), async () => new Response('x'.repeat(contents.length))), /SHA-256/);
  await assert.rejects(downloadPinned(asset, path.join(directory, 'blocked'), async () => Response.redirect('https://fixture.invalid/asset')), /不受支持/);
});

test('single-source worklet preserves a quiet onset, pause and capture interval', async () => {
  let Processor; const messages = [];
  const context = { sampleRate: 48000, currentFrame: 0, AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => messages.push(data) }; } }, registerProcessor: (_name, value) => { Processor = value; } };
  vm.runInNewContext(await readFile(new URL('../src/voice-worklet.js', import.meta.url), 'utf8'), context);
  const processor = new Processor(), silence = new Float32Array(128); let sample = 0;
  const play = (frames, amplitude) => {
    for (let frame = 0; frame < frames; frame++) { processor.process([[Float32Array.from({ length: 128 }, () => amplitude * Math.sin(sample++ * 2 * Math.PI * 375 / 48000))]]); context.currentFrame += 128; }
  };
  for (let i = 0; i < 800; i++) { processor.process([[silence]]); context.currentFrame += 128; }
  assert.equal(messages.length, 0);
  play(18, 0.0007); play(46, 0.004); play(210, 0); play(48, 0.004);
  assert.equal(messages.length, 0, 'short pauses do not cut a sentence in two');
  play(300, 0);
  assert.equal(messages.length, 1); assert.ok(messages[0].pcm.byteLength > 3200 && messages[0].pcm.byteLength <= 16000 * 2 * 12);
  assert.equal(messages[0].endSample - messages[0].startSample, messages[0].pcm.byteLength / 2);
  const pcm = Array.from(new Int16Array(messages[0].pcm));
  const first = pcm.findIndex(x => Math.abs(x) > 7), audible = pcm.findIndex(x => Math.abs(x) > 95);
  assert.ok(first >= 0 && audible - first > 600, 'pre-roll preserves the soft lead-in');
  assert.ok(Math.max(...pcm) > 120, 'independent input keeps its gain');
});
