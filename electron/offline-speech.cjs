const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { ENGINE, VAD, MODELS, DEFAULT_SPEECH, validateSpeech } = require('./speech-assets.cjs');
const { vadSpans, trimVoice, decodeResult, empty } = require('./speech-decision.cjs');
const { createLanguageHints } = require('./speech-language.cjs');

function pcmWave(value) {
  if (!(value instanceof ArrayBuffer) || value.byteLength < 3200 || value.byteLength > 16000 * 2 * 13 || value.byteLength % 2) throw new Error('音频片段格式不正确');
  const pcm = Buffer.from(value), output = Buffer.alloc(44 + pcm.length);
  output.write('RIFF'); output.writeUInt32LE(36 + pcm.length, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(16000, 24); output.writeUInt32LE(32000, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write('data', 36); output.writeUInt32LE(pcm.length, 40); pcm.copy(output, 44); return output;
}
async function downloadPinned(asset, file, fetchImpl = fetch) {
  let url = asset.url;
  const signal = AbortSignal.timeout(600000);
  for (let redirect = 0; redirect < 8; redirect++) {
    const parsed = new URL(url);
    const allowed = ['github.com', 'huggingface.co'].includes(parsed.hostname) || ['.githubusercontent.com', '.hf.co', '.huggingface.co'].some(suffix => parsed.hostname.endsWith(suffix));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !allowed) throw new Error('离线组件下载地址不受支持');
    const response = await fetchImpl(url, { redirect: 'manual', cache: 'no-store', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      url = new URL(response.headers.get('location'), url).href; await response.body?.cancel(); continue;
    }
    if (!response.ok || !response.body) throw new Error('离线组件下载失败，请检查网络后重试');
    const hash = createHash('sha256'), handle = await fs.open(file, 'wx', 0o600);
    let size = 0;
    try {
      for await (const part of response.body) {
        size += part.length;
        if (size > asset.size) throw new Error('离线组件大小校验失败');
        hash.update(part); await handle.writeFile(part);
      }
      if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error('离线组件 SHA-256 校验失败');
    } finally { await handle.close(); }
    return;
  }
  throw new Error('离线组件下载跳转次数过多');
}

function runHidden(executable, args, { signal, timeoutMs = 90000, captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'ignore'], shell: false });
    let expired = false, size = 0;
    const stdout = [];
    const stop = () => child.kill(), timer = setTimeout(() => { expired = true; stop(); }, timeoutMs);
    child.stdout?.on('data', chunk => { size += chunk.length; if (size > 16384) stop(); else stdout.push(chunk); });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', stop); error ? reject(error) : resolve(Buffer.concat(stdout).toString('utf8')); };
    child.once('error', () => finish(new Error('无法启动离线语音引擎，请重新下载组件')));
    child.once('close', code => finish(signal?.aborted ? new Error('离线转写已取消') : expired ? new Error('本机转写超时，已停止本段音频') : code === 0 ? null : new Error('离线语音引擎未能完成转写，请检查组件和电脑资源')));
  });
}

function createOfflineSpeech(directory, { platform = process.platform, arch = process.arch, fetchImpl = fetch, run = runHidden,
  threads = Math.max(1, Math.min(4, os.availableParallelism() - 1)), verifyAsset } = {}) {
  const root = path.resolve(directory, 'offline-speech');
  const engine = path.join(root, 'engine-1.8.3'), work = path.join(root, 'work'), preference = path.join(root, 'settings.json');
  const assetPath = spec => path.join(root, spec.file);
  const supported = platform === 'win32' && arch === 'x64';
  const checksums = new Map();
  const languageHints = createLanguageHints();
  let installing = null, active = null, generation = 0, settings = DEFAULT_SPEECH, writing = Promise.resolve();
  async function removeOwned(target) {
    const resolved = path.resolve(target), relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('清理路径越界');
    await fs.rm(resolved, { recursive: true, force: true });
  }
  async function executable(name, directory = engine) {
    for (const candidate of [path.join(directory, 'Release', name), path.join(directory, name)]) {
      if (await fs.stat(candidate).then(s => s.isFile()).catch(() => false)) return candidate;
    }
    return null;
  }
  async function enginePaths(directory = engine) {
    const [cli, vad] = await Promise.all([executable('whisper-cli.exe', directory), executable('whisper-vad-speech-segments.exe', directory)]);
    return cli && vad ? { cli, vad } : null;
  }
  async function verified(spec) {
    const file = assetPath(spec);
    if (verifyAsset) return verifyAsset(file, spec);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size !== spec.size) return false;
      const key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
      if (checksums.get(file)?.key !== key) {
        const hash = createHash('sha256');
        for await (const bytes of createReadStream(file)) hash.update(bytes);
        checksums.set(file, { key, matches: hash.digest('hex') === spec.sha256 });
      }
      return checksums.get(file).matches;
    } catch { return false; }
  }
  async function status() {
    const selection = settings, spec = MODELS[selection.profile];
    if (!supported) return { ready: false, supported, settings: selection, downloadBytes: 0 };
    const [paths, model, vad] = await Promise.all([enginePaths(), verified(spec), verified(VAD)]);
    const downloadBytes = (paths ? 0 : ENGINE.size) + (model ? 0 : spec.size) + (vad ? 0 : VAD.size);
    return { ready: !downloadBytes, supported, settings: selection, downloadBytes };
  }
  function configure(value) {
    const next = validateSpeech(value);
    const result = writing.catch(() => {}).then(async () => {
      if (active?.controller.signal.aborted) await active.task.catch(() => {});
      if (installing || active) throw new Error('请先停止语音转写或等待下载完成');
      await fs.writeFile(preference + '.tmp', JSON.stringify(next), { mode: 0o600 });
      await fs.rename(preference + '.tmp', preference);
      if (settings.profile !== next.profile || settings.language !== next.language) languageHints.clear();
      settings = next;
      return status();
    });
    writing = result;
    return result;
  }
  async function install() {
    if (installing) return installing;
    installing = (async () => {
      if (!supported) throw new Error('当前离线组件支持 Windows x64');
      if (active) throw new Error('请先停止语音转写');
      await writing.catch(() => {});
      const model = MODELS[settings.profile];
      if ((await status()).ready) return { ready: true };
      await fs.mkdir(root, { recursive: true });
      const staging = await fs.mkdtemp(path.join(root, 'download-'));
      try {
        if (!(await enginePaths())) {
          const zip = path.join(staging, 'engine.zip'), extract = path.join(staging, 'engine');
          await downloadPinned(ENGINE, zip, fetchImpl);
          // Only the fixed, hash-verified archive reaches extraction.
          const quote = value => "'" + value.replace(/'/g, "''") + "'";
          await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath " + quote(zip) + ' -DestinationPath ' + quote(extract)]);
          if (!(await enginePaths(extract))) throw new Error('组件解压后未找到识别程序，请重新下载');
          // Retain an existing engine if a repair is needed; replace only after verification.
          const backup = path.join(root, `engine-backup-${path.basename(staging).slice('download-'.length)}`);
          let backedUp = true;
          try { await fs.rename(engine, backup); } catch (error) { if (error.code !== 'ENOENT') throw error; backedUp = false; }
          try { await fs.rename(extract, engine); }
          catch (error) { if (backedUp) await fs.rename(backup, engine); throw error; }
        }
        for (const spec of [VAD, model]) if (!(await verified(spec))) {
          const staged = path.join(staging, spec.file);
          await downloadPinned(spec, staged, fetchImpl);
          await fs.rename(staged, assetPath(spec));
        }
        if (!(await status()).ready) throw new Error('组件解压后未找到识别程序，请重新下载');
        return { ready: true };
      } catch (error) {
        if (/[\u4e00-\u9fff]/.test(error.message || '')) throw error;
        throw new Error('离线组件下载或安装未完成，请检查网络和目录权限后重试', { cause: error });
      } finally { await removeOwned(staging); }
    })().finally(() => { installing = null; });
    return installing;
  }
  function cancel() { generation++; languageHints.clear(); active?.controller.abort(); }
  async function recognize(value, current, selection, source, signal) {
    const wav = pcmWave(value), model = MODELS[selection.profile];
    if (!supported || !(await verified(model)) || !(await verified(VAD))) throw new Error('请先下载所选的离线语音组件');
    const paths = await enginePaths();
    if (!paths) throw new Error('请先下载所选的离线语音组件');
    if (signal.aborted) return empty('cancelled');
    const temporary = await fs.mkdtemp(path.join(work, 'chunk-'));
    try {
      const input = path.join(temporary, 'input.wav'), voice = path.join(temporary, 'voice.wav'), output = path.join(temporary, 'result');
      await fs.writeFile(input, wav, { mode: 0o600 });
      signal.throwIfAborted();
      // v1.8.3's helper misparses the silence option; the worklet handles
      // utterance boundaries and the trim below keeps all intra-sentence gaps.
      const positions = await run(paths.vad, ['-f', input, '-vm', assetPath(VAD), '-t', '1', '-np', '--vad-threshold', '0.50',
        '--vad-min-speech-duration-ms', '100', '--vad-speech-pad-ms', '160'], { signal, timeoutMs: 10000, captureStdout: true });
      if (current !== generation) return empty('cancelled');
      const spans = vadSpans(positions, (wav.length - 44) / 2);
      if (!spans.length) return empty('silence');
      const pcm = trimVoice(wav, spans);
      if (pcm.length < 3200) return empty('uncertain');
      await fs.writeFile(voice, pcmWave(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)), { mode: 0o600 });
      signal.throwIfAborted();
      const seconds = (spans.at(-1)[1] - spans[0][0]) / 16000;
      const language = languageHints.select(source, selection.language, seconds);
      await run(paths.cli, ['-m', assetPath(model), '-f', voice, '-l', language, '-t', String(threads), '-ng', '-np', '-nt', '-ojf', '-of', output], { signal });
      if (current !== generation) return empty('cancelled');
      const result = output + '.json';
      if ((await fs.stat(result)).size > 2 * 1024 * 1024) return empty('uncertain');
      const json = JSON.parse(await fs.readFile(result, 'utf8'));
      const decoded = decodeResult(json);
      if (current !== generation) return empty('cancelled');
      languageHints.observe(source, json, decoded, seconds);
      return decoded;
    } finally { await removeOwned(temporary); }
  }
  return {
    status, install, cancel, configure,
    async initialize() {
      languageHints.clear();
      await fs.mkdir(root, { recursive: true });
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && /^download-[a-zA-Z0-9-]+$/.test(entry.name)) await removeOwned(path.join(root, entry.name));
      }
      await removeOwned(work); await fs.mkdir(work);
      try { settings = validateSpeech(JSON.parse(await fs.readFile(preference, 'utf8'))); } catch { /* Missing or invalid settings use defaults. */ }
    },
    async transcribe(value, source = 'microphone') {
      if (!['system', 'microphone'].includes(source)) throw new Error('转写音源无效');
      const current = generation;
      await writing.catch(() => {});
      if (active?.controller.signal.aborted) await active.task.catch(() => {});
      if (current !== generation) return empty('cancelled');
      if (active) throw new Error('离线转写正在处理上一段音频');
      if (installing) throw new Error('请等待离线组件下载完成');
      const controller = new AbortController();
      const task = recognize(value, current, settings, source, controller.signal).catch(error => {
        if (controller.signal.aborted) return empty('cancelled');
        if (/[\u4e00-\u9fff]/.test(error.message || '') && !error.code) throw error;
        throw new Error('离线语音引擎未能完成转写，请检查组件和电脑资源');
      }).finally(() => { active = null; });
      active = { controller, task };
      return task;
    },
  };
}
module.exports = { createOfflineSpeech, pcmWave, downloadPinned };
