import { spawn } from 'node:child_process';
import { mkdir, copyFile, writeFile, stat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createConnection } from 'node:net';
import WebSocket from 'ws';

if (process.platform !== 'win32') throw new Error('Portable startup measurements require Windows.');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const unpacked = process.argv.includes('--unpacked');
const label = process.argv[2] || 'measurement';
if (!/^[a-z][a-z0-9-]{0,40}$/.test(label)) throw new Error('Use a short lowercase measurement name.');
const folder = new URL('../release/performance-qa/' + label + '/', import.meta.url);
await mkdir(folder, { recursive: true });
const name = `Pairo-Meeting-Copilot-${pkg.version}-win-x64.exe`;
const exe = unpacked ? new URL('../release/win-unpacked/' + encodeURIComponent(pkg.build.productName + '.exe'), import.meta.url) : new URL(name, folder);
if (!unpacked) await copyFile(new URL('../release/' + name, import.meta.url), exe);
const profileExists = await stat(new URL('PAIRO-data/', folder)).then(() => true, () => false);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms)), results = [];

for (let run = 0; run < 2; run++) {
  const portBusy = await new Promise(resolve => {
    const probe = createConnection({ host: '127.0.0.1', port: 9226 });
    probe.setTimeout(1000);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
    probe.once('timeout', () => { probe.destroy(); resolve(false); });
  });
  if (portBusy) throw new Error('Debug port 9226 is already in use; close the earlier measurement first.');
  const start = performance.now();
  const child = spawn(fileURLToPath(exe), ['--remote-debugging-port=9226'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, PORTABLE_EXECUTABLE_DIR: fileURLToPath(folder) } });
  let spawnError; child.once('error', error => { spawnError = error; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let socket;
  try {
    const deadline = performance.now() + 60000;
    let target;
    while (!target && performance.now() < deadline) {
      if (spawnError) throw spawnError;
      try {
        const targets = await (await fetch('http://127.0.0.1:9226/json/list')).json();
        target = targets.find(item => item.type === 'page' && item.title === 'P2P Meeting Copilot' && item.url.startsWith('http://127.0.0.1:'));
      } catch { /* The portable executable is still extracting or starting. */ }
      if (!target) await pause(150);
    }
    if (!target) throw new Error('PAIRO startup exceeded 60 seconds.');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    let id = 0;
    const evaluate = expression => new Promise((resolve, reject) => {
      const request = ++id;
      const cleanup = () => { clearTimeout(timer); socket.off('message', handler); };
      const handler = bytes => {
        const data = JSON.parse(bytes); if (data.id !== request) return;
        cleanup();
        if (data.error || data.result.exceptionDetails) reject(new Error('Startup probe failed.'));
        else resolve(data.result.result.value);
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error('Startup probe timed out.')); }, 5000);
      socket.on('message', handler);
      socket.send(JSON.stringify({ id: request, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    let ready = false;
    while (!ready && performance.now() < deadline) {
      ready = await evaluate("(async()=>{if(document.readyState!=='complete'||!document.getElementById('start-share')||!window.desktopBridge)return false;await window.desktopBridge.getSignalInfo();return true;})()");
      if (!ready) await pause(100);
    }
    if (!ready) throw new Error('PAIRO UI did not become ready.');
    const result = { run: run + 1, profile: run === 0 && !profileExists ? 'new' : 'existing', uiReadySeconds: Number(((performance.now() - start) / 1000).toFixed(3)), includesPortableExtraction: !unpacked };
    results.push(result); console.log(JSON.stringify(result));
    await evaluate('(()=>{setTimeout(()=>window.close(),100);return true;})()');
    let exitTimer;
    const closed = await Promise.race([exited.then(() => true), new Promise(resolve => { exitTimer = setTimeout(() => resolve(false), 30000); })]);
    clearTimeout(exitTimer);
    if (!closed) throw new Error('PAIRO did not close after startup probe.');
  } finally {
    socket?.close();
    if (Number.isInteger(child.pid) && child.exitCode === null) {
      await new Promise(resolve => {
        const cleanup = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        cleanup.once('exit', resolve); cleanup.once('error', resolve);
      });
    }
  }
}
const report = { version: pkg.version, mode: unpacked ? 'unpacked' : 'portable', executableBytes: (await stat(exe)).size, runs: results, notes: 'The second run also benefits from OS cache. Isolated profile; no capture, pairing or AI requests.' };
await writeFile(new URL('startup.json', folder), JSON.stringify(report, null, 2));
