const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const toSimplified = require('opencc-js/t2cn').Converter({ from: 't', to: 'cn' });

const ENGINE = { url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.3/whisper-bin-x64.zip', size: 3968674, sha256: 'd824b1e37599f882b396e73f1ee0bfd5d0529f700314c48311dcbd00b803321d' };
const MODEL = { url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin', size: 77691713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21' };

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
    const response = await fetchImpl(url, { redirect: 'manual', signal });
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

function runHidden(executable, args, { signal, timeoutMs = 90000, onChild = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'], shell: false });
    onChild(child);
    let expired = false;
    const stop = () => child.kill(), timer = setTimeout(() => { expired = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', stop); error ? reject(error) : resolve(); };
    child.once('error', () => finish(new Error('无法启动离线语音引擎，请重新下载组件')));
    child.once('close', code => finish(signal?.aborted ? new Error('离线转写已取消') : expired ? new Error('本机转写超时，已停止本段音频') : code === 0 ? null : new Error('离线语音引擎未能完成转写，请检查组件和电脑资源')));
  });
}

function createOfflineSpeech(directory, { platform = process.platform, arch = process.arch, fetchImpl = fetch, run = runHidden } = {}) {
  const root = path.resolve(directory, 'offline-speech');
  const engine = path.join(root, 'engine-1.8.3'), model = path.join(root, 'ggml-tiny.bin'), work = path.join(root, 'work');
  let installing = null, controller = null, generation = 0, busy = false;
  async function removeOwned(target) {
    const resolved = path.resolve(target), relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('清理路径越界');
    await fs.rm(resolved, { recursive: true, force: true });
  }
  async function executable() {
    for (const candidate of [path.join(engine, 'Release', 'whisper-cli.exe'), path.join(engine, 'whisper-cli.exe')]) {
      if (await fs.stat(candidate).then(s => s.isFile()).catch(() => false)) return candidate;
    }
    return null;
  }
  async function status() {
    const supported = platform === 'win32' && arch === 'x64';
    return { ready: supported && Boolean(await executable()) && await fs.stat(model).then(s => s.size === MODEL.size).catch(() => false), supported };
  }
  async function install() {
    if (installing) return installing;
    installing = (async () => {
      if (platform !== 'win32' || arch !== 'x64') throw new Error('当前离线组件支持 Windows x64');
      if ((await status()).ready) return { ready: true };
      await fs.mkdir(root, { recursive: true });
      const staging = await fs.mkdtemp(path.join(root, 'download-'));
      try {
        const zip = path.join(staging, 'engine.zip'), extract = path.join(staging, 'engine'), downloadedModel = path.join(staging, 'model.bin');
        await downloadPinned(ENGINE, zip, fetchImpl);
        await downloadPinned(MODEL, downloadedModel, fetchImpl);
        // Only fixed, hash-verified archives reach extraction. Paths are quoted as PowerShell literals.
        const quote = value => "'" + value.replace(/'/g, "''") + "'";
        await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath " + quote(zip) + ' -DestinationPath ' + quote(extract)]);
        await removeOwned(engine); await fs.rename(extract, engine);
        await fs.rm(model, { force: true }); await fs.rename(downloadedModel, model);
        if (!(await status()).ready) throw new Error('组件解压后未找到识别程序，请重新下载');
        return { ready: true };
      } catch (error) {
        if (/[\u4e00-\u9fff]/.test(error.message || '')) throw error;
        throw new Error('离线组件下载或安装未完成，请检查网络和目录权限后重试', { cause: error });
      } finally { await removeOwned(staging); }
    })().finally(() => { installing = null; });
    return installing;
  }
  function cancel() { generation += 1; controller?.abort(); }
  return {
    status, install, cancel,
    async initialize() {
      await fs.mkdir(root, { recursive: true });
      for (const entry of await fs.readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && /^download-[a-zA-Z0-9-]+$/.test(entry.name)) await removeOwned(path.join(root, entry.name));
      }
      await removeOwned(work); await fs.mkdir(work);
    },
    async transcribe(value) {
      const current = generation;
      const wav = pcmWave(value);
      if (busy) throw new Error('离线转写正在处理上一段音频');
      if (!(await status()).ready) throw new Error('请先下载离线语音组件');
      if (current !== generation) return '';
      // Recheck after asynchronous status: simultaneous IPC calls cannot launch multiple models.
      if (busy) throw new Error('离线转写正在处理上一段音频');
      busy = true; controller = new AbortController();
      let temporary;
      try {
        temporary = await fs.mkdtemp(path.join(work, 'chunk-'));
        const input = path.join(temporary, 'input.wav'), output = path.join(temporary, 'result');
        await fs.writeFile(input, wav, { mode: 0o600 });
        if (current !== generation) throw new Error('离线转写已取消');
        await run(await executable(), ['-m', model, '-f', input, '-l', 'auto', '-t', String(Math.max(1, Math.min(4, os.availableParallelism() - 1))), '-ng', '-np', '-nt', '-otxt', '-of', output], { signal: controller.signal });
        if (current !== generation) return '';
        return toSimplified((await fs.readFile(output + '.txt', 'utf8')).trim()).slice(0, 12000);
      } finally { try { if (temporary) await removeOwned(temporary); } finally { busy = false; controller = null; } }
    },
  };
}
module.exports = { createOfflineSpeech, pcmWave, downloadPinned, ENGINE, MODEL };
