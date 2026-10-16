const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_TYPING = Object.freeze({ chineseCpm: 60, englishWpm: 90 });
function validateTyping(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('键入速度格式不正确');
  const { chineseCpm, englishWpm } = value;
  if (!Number.isInteger(chineseCpm) || chineseCpm < 10 || chineseCpm > 600 || !Number.isInteger(englishWpm) || englishWpm < 10 || englishWpm > 300) throw new Error('中文速度应为 10–600 字/分钟，英文为 10–300 词/分钟');
  return { chineseCpm, englishWpm };
}
const MESSAGES = {
  focus: '前台窗口或输入焦点已变化，已停止键入',
  target: '请先点击可编辑的普通输入框；密码、只读或不支持的输入框不能键入',
  selection: '没有读到选中文字，请在原窗口选中文字后重试',
  clipboard: '剪贴板正忙或包含无法安全恢复的格式，本次未复制',
  modifiers: '请松开快捷键后重试',
  input: '目标程序未接收键盘输入；请使用普通权限的可编辑输入框',
  expired: '回答键入已过期，请重新点击输入框并按快捷键',
};

// All content travels over stdin. No text, paths supplied by a peer, or credentials enter shell arguments.
function createTextAutomation({ globalShortcut, onStatus = () => {}, onShortcut = () => {}, platform = process.platform, spawnImpl = spawn } = {}) {
  let child, ready, pending, counter = 0, epoch = 0, active = false, ownsEscape = false, disposed = false;
  let nativeBindings = [], workerReady = false;
  const sendControl = value => { if (child && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ id: 0, ...value }) + '\n', () => {}); };
  const configure = () => { if (workerReady) sendControl({ action: 'bindings', bindings: nativeBindings }); };
  const status = message => onStatus({ message, active });
  function release() {
    if (ownsEscape) globalShortcut.unregister('Escape');
    ownsEscape = false; active = false;
  }
  function stop(message = '已停止回答键入', force = false) {
    const hadOperation = active || Boolean(pending);
    epoch += 1;
    release();
    if (hadOperation) {
      pending?.reject(new Error(message)); pending = null;
      sendControl({ action: 'cancel' });
      if (force) { const old = child; child = null; ready = null; workerReady = false; old?.kill(); if (!disposed) void start().catch(() => {}); }
      status(message);
    }
  }
  function start() {
    if (disposed) return Promise.reject(new Error('输入组件已关闭'));
    if (platform !== 'win32') return Promise.reject(new Error('选中文字与回答键入需要 Windows 桌面程序'));
    if (ready) return ready;
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const worker = child = spawnImpl(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'text-worker.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('本机输入组件启动超时')); if (child === worker) { child = null; ready = null; } worker.kill(); }, 15000);
      const lines = readline.createInterface({ input: worker.stdout });
      lines.on('line', line => {
        if (child !== worker) return;
        let value; try { value = JSON.parse(line); } catch { return; }
        if (value.ready === true) { clearTimeout(timer); workerReady = true; configure(); resolve(); return; }
        if (typeof value.shortcut === 'string') { if (nativeBindings.some(item => item.action === value.shortcut)) onShortcut(value.shortcut); return; }
        if (pending && value.id === pending.id) {
          const current = pending; pending = null;
          if (value.error) current.reject(new Error(MESSAGES[value.error] || '本机输入操作未完成'));
          else current.resolve(value);
        }
      });
      const fail = () => {
        clearTimeout(timer); lines.close();
        reject(new Error('本机输入组件未能启动'));
        if (child !== worker) return;
        child = null; ready = null;
        workerReady = false;
        pending?.reject(new Error('本机输入组件已停止')); pending = null;
        release();
        status('本机输入组件已停止，请重新启用快捷键后重试');
      };
      worker.on('error', fail); worker.on('exit', fail); worker.stdin.on('error', fail);
      // Native diagnostics may contain application titles. Never forward or persist stderr.
      worker.stderr.on('data', () => {});
    });
    ready.catch(() => {});
    return ready;
  }
  async function command(action, values = {}) {
    const generation = epoch;
    await start();
    if (generation !== epoch) throw new Error('已取消输入操作');
    if (pending) throw new Error('上一项选取或键入操作仍在进行');
    return new Promise((resolve, reject) => {
      const id = ++counter;
      const timeout = action === 'type' ? 24000 * 6000 + 10000 : 5000;
      const timer = setTimeout(() => stop('本机输入操作超时，已停止', true), timeout);
      pending = { id, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
      child.stdin.write(JSON.stringify({ id, action, ...values }) + '\n', error => {
        if (error && pending?.id === id) { const current = pending; pending = null; current.reject(new Error('本机输入组件已停止')); }
      });
    });
  }
  return {
    initialize: start,
    setBindings(snapshot) {
      nativeBindings = [];
      if (snapshot.enabled && snapshot.active) for (const [action, accelerator] of Object.entries(snapshot.bindings)) {
        const parts = accelerator.toLowerCase().replace(/commandorcontrol|ctrl/g, 'control').split('+');
        const key = parts.pop();
        if (parts.includes('shift') && /^num[0-9]$/.test(key)) nativeBindings.push({ action, digit: Number(key.slice(-1)), modifiers: 4 | (parts.includes('control') ? 2 : 0) | (parts.includes('alt') ? 1 : 0) | (parts.includes('super') ? 8 : 0) });
      }
      configure();
      if (nativeBindings.length && !ready) void start().catch(() => status('本机输入组件未能启动，请检查 Windows PowerShell 运行策略'));
    },
    get active() { return active; },
    async copySelection() {
      if (active) throw new Error('请先停止回答键入，再选中文字');
      const result = await command('copy');
      if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 12000) throw new Error('选中文字应为 1–12000 个字符，请缩小选区后重试');
      return result.text;
    },
    async prepare() {
      if (active || pending) throw new Error('上一项选取或键入操作仍在进行');
      active = true;
      if (!globalShortcut.register('Escape', () => stop())) { active = false; throw new Error('Esc 已被其他程序占用，无法安全开始键入'); }
      ownsEscape = true;
      try {
        const value = await command('arm');
        if (!active) throw new Error('已取消回答键入');
        status('等待手机最新完整回答；Esc 可取消');
        return value.token;
      } catch (error) { release(); throw error; }
    },
    async type(value, settings = DEFAULT_TYPING) {
      if (!active) throw new Error('请先按回答键入快捷键');
      const rates = validateTyping(settings);
      if (!value || typeof value.token !== 'string' || !/^[a-f0-9]{32}$/.test(value.token) || typeof value.text !== 'string' || !value.text.trim() || value.text.length > 24000) { stop(); throw new Error('回答过长或无效，未开始键入（最多 24000 字符）'); }
      try {
        status('正在键入回答；Esc 或再次按快捷键可停止');
        const result = await command('type', { ...value, ...rates });
        release();
        status('回答已键入，请自行检查并提交');
        return { count: result.count };
      } catch (error) { release(); status(error.message); throw error; }
    },
    cancel: stop,
    dispose() { disposed = true; stop(); child?.kill(); child = null; ready = null; },
  };
}
module.exports = { DEFAULT_TYPING, validateTyping, createTextAutomation };
