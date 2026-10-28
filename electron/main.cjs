const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const { app, BrowserWindow, desktopCapturer, session, dialog, globalShortcut, ipcMain, shell, Tray, Menu, nativeImage, net } = require('electron');
const { isTrustedUiUrl, mediaPermissionKind } = require('./security.cjs');
const { createPreferencesStore } = require('./preferences.cjs');
const { lanAddresses } = require('./network.cjs');
const { showCapturePicker } = require('./capture-picker.cjs');
const { createShortcutManager } = require('./shortcuts.cjs');
const { createOfflineSpeech } = require('./offline-speech.cjs');
const { DEFAULT_TYPING, validateTyping, createTextAutomation } = require('./text-automation.cjs');

const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || (app.isPackaged ? path.dirname(app.getPath('exe')) : '');
if (portableDir) {
  const userData = path.join(portableDir, 'PAIRO-data');
  try {
    fsSync.mkdirSync(path.join(userData, 'session'), { recursive: true });
    app.setPath('userData', userData);
    app.setPath('sessionData', path.join(userData, 'session'));
  } catch (error) { console.warn('Cannot use portable user data beside the EXE:', error.message); }
}

let mainWindow;
let signaling;
let uiServer;
let uiPort;
let signalingPort;
let registeredShortcuts = [];
let preferencesStore;
let shortcutManager, offlineSpeech, tray, quitting = false, meetingActive = false;
let shortcutWrites = Promise.resolve();
let textAutomation, typingSettings = { ...DEFAULT_TYPING }, typingSettingsWrites = Promise.resolve();
const uiOrigin = () => uiPort ? 'http://127.0.0.1:' + uiPort : '';
function trustedContents(contents, details = {}) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents
    && details.isMainFrame !== false
    && isTrustedUiUrl(details.requestingUrl || details.securityOrigin || contents.getURL(), uiOrigin()));
}
function requireTrustedIpc(event) {
  if (!trustedContents(event.sender) || event.senderFrame !== mainWindow.webContents.mainFrame
    || !isTrustedUiUrl(event.senderFrame.url, uiOrigin())) throw new Error('Untrusted IPC sender');
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
else app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function getLanAddresses() {
  return lanAddresses(os.networkInterfaces(), signalingPort);
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function startServices() {
  const serverModule = await import(pathToFileURL(path.join(app.getAppPath(), 'server', 'signaling.js')).href);
  signaling = serverModule.createSignalingServer();
  try {
    signalingPort = await listen(signaling.server, 8787, '0.0.0.0');
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    signalingPort = await listen(signaling.server, 0, '0.0.0.0');
  }

  const distRoot = path.resolve(app.getAppPath(), 'dist');
  uiServer = createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
      response.writeHead(405).end();
      return;
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url || '/', 'http://localhost').pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const target = path.resolve(distRoot, relative);
      const rel = path.relative(distRoot, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        response.writeHead(403).end();
        return;
      }
      const content = await fs.readFile(target);
      response.writeHead(200, {
        'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  });
  uiPort = await listen(uiServer, 0, '127.0.0.1');
}

function configureMediaPermissions() {
  session.defaultSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const kind = mediaPermissionKind(permission, details);
    if (!trustedContents(contents, details) || kind === 'deny') {
      callback(false);
      return;
    }
    if (kind === 'display') {
      // Grant the permission gate; the display handler still requires source selection.
      callback(true);
      return;
    }
    try {
      const options = {
        type: 'question',
        title: '麦克风权限',
        message: '允许 PAIRO 在本次共享会话中使用麦克风吗？',
        detail: '麦克风音频会通过加密 WebRTC 直接发送到已配对的手机。',
        buttons: ['允许本次使用', '拒绝'],
        defaultId: 1,
        cancelId: 1,
      };
      const answer = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
      callback(answer.response === 0);
    } catch {
      callback(false);
    }
  });
}

function configureDisplayCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    let completed = false;
    const respond = streams => {
      if (completed) return;
      completed = true;
      try { callback(streams); }
      catch (error) {
        // Electron rejects an empty selection and may throw after consuming the callback.
        if (streams.video) console.warn('Display capture response failed:', error.message);
      }
    };
    if (!mainWindow || request.frame !== mainWindow.webContents.mainFrame
      || !isTrustedUiUrl(request.frame.url, uiOrigin())) {
      respond({});
      return;
    }
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 360, height: 220 },
      });
      if (!sources.length) {
        respond({});
        return;
      }
      const selection = await showCapturePicker({ parent: mainWindow, sources, BrowserWindow, ipcMain });
      const source = trustedContents(mainWindow?.webContents) ? selection : null;
      if (!source) {
        respond({});
        return;
      }
      respond({ video: source, audio: request.audioRequested ? 'loopback' : undefined });
    } catch (error) {
      console.warn('Display capture selection failed:', error.message);
      respond({});
    }
  }, { useSystemPicker: true });
}

function updateGlobalShortcuts(value = {}) {
  // When our window is focused, DOM shortcuts respect editable fields. Global keys are for background use.
  const result = shortcutManager.update({ ...value, active: meetingActive && !mainWindow?.isFocused() });
  textAutomation?.setBindings({ ...result, active: meetingActive && !mainWindow?.isFocused() });
  registeredShortcuts = result.registered; return result;
}
function restoreWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show(); mainWindow.focus();
}
function createTray() {
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const i = (y * 32 + x) * 4, letter = (x >= 8 && x <= 11 && y >= 6 && y <= 26) || (x >= 11 && x <= 23 && (y >= 6 && y <= 9 || y >= 15 && y <= 18)) || (x >= 21 && x <= 24 && y >= 9 && y <= 15);
    pixels[i] = letter ? 245 : 180; pixels[i + 1] = letter ? 245 : 80; pixels[i + 2] = letter ? 245 : 25; pixels[i + 3] = 255;
  }
  tray = new Tray(nativeImage.createFromBitmap(pixels, { width: 32, height: 32, scaleFactor: 1 }));
  tray.setToolTip('PAIRO · 静默会议助手');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 PAIRO', click: restoreWindow }, { type: 'separator' }, { label: '退出并结束会话', click: () => { quitting = true; app.quit(); } }]));
  tray.on('double-click', restoreWindow);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 880,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#ece9d8',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setAudioMuted(true);
  mainWindow.on('close', event => { if (!quitting && tray) { event.preventDefault(); mainWindow.hide(); } });
  mainWindow.on('focus', () => { try { updateGlobalShortcuts(); } catch { /* status is reported on settings refresh */ } });
  mainWindow.on('blur', () => {
    try { updateGlobalShortcuts(); }
    catch (error) { mainWindow?.webContents.send('desktop-shortcut-error', error.message); }
  });
  mainWindow.webContents.on('render-process-gone', () => { meetingActive = false; shortcutManager.clear(); offlineSpeech.cancel(); textAutomation?.cancel(); textAutomation?.setBindings({ enabled: false }); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUiUrl(url, uiOrigin())) event.preventDefault();
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL('http://127.0.0.1:' + uiPort + '/');
}

ipcMain.handle('desktop:signal-info', event => {
  requireTrustedIpc(event);
  return {
    signalBase: 'http://127.0.0.1:' + signalingPort,
    signalingPort,
    lanAddresses: getLanAddresses(),
    registeredShortcuts,
  };
});
ipcMain.handle('desktop:preferences-read', event => {
  requireTrustedIpc(event);
  return preferencesStore.read();
});
ipcMain.handle('desktop:preferences-write', (event, value) => {
  requireTrustedIpc(event);
  return preferencesStore.write(value);
});
ipcMain.handle('desktop:open-releases', event => {
  requireTrustedIpc(event);
  return shell.openExternal('https://github.com/BuanDesu/PAIRO-Meeting-Assistant-Public/releases/latest');
});
ipcMain.handle('desktop:hide-to-tray', event => { requireTrustedIpc(event); mainWindow.hide(); });
ipcMain.handle('desktop:shortcuts-read', event => { requireTrustedIpc(event); return shortcutManager.snapshot(); });
function requireTextSession(event) {
  requireTrustedIpc(event);
  if (!meetingActive || !shortcutManager.snapshot().enabled) throw new Error('请先连接手机并启用快捷键');
  // Never send synthetic input back into PAIRO itself.
  if (mainWindow.isFocused()) throw new Error('请在需要操作的其他程序中使用快捷键');
}
ipcMain.handle('desktop:copy-selection', event => { requireTextSession(event); return textAutomation.copySelection(); });
ipcMain.handle('desktop:typing-prepare', event => {
  requireTextSession(event);
  if (textAutomation.active) { textAutomation.cancel(); return null; }
  return textAutomation.prepare();
});
ipcMain.handle('desktop:typing-start', (event, value) => { requireTextSession(event); return textAutomation.type(value, typingSettings); });
ipcMain.handle('desktop:typing-cancel', event => { requireTrustedIpc(event); if (textAutomation.active) textAutomation.cancel(); });
ipcMain.handle('desktop:typing-settings-read', event => { requireTrustedIpc(event); return { ...typingSettings }; });
ipcMain.handle('desktop:typing-settings-write', (event, value) => {
  requireTrustedIpc(event); const next = validateTyping(value);
  const write = typingSettingsWrites.catch(() => {}).then(async () => {
    const file = path.join(app.getPath('userData'), 'typing-settings.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file + '.tmp', JSON.stringify(next), { mode: 0o600 }); await fs.rename(file + '.tmp', file);
    typingSettings = next; return { ...next };
  });
  typingSettingsWrites = write; return write;
});
ipcMain.handle('desktop:shortcuts-write', (event, value) => {
  requireTrustedIpc(event);
  if (!value || typeof value !== 'object' || typeof value.active !== 'boolean' || typeof value.enabled !== 'boolean') throw new Error('快捷键状态不正确');
  const update = shortcutWrites.catch(() => {}).then(async () => {
    const oldActive = meetingActive; meetingActive = value.active;
    if (!meetingActive || !value.enabled) textAutomation?.cancel();
    let result;
    try {
      // Probe while the settings window is focused too, so Save can report conflicts immediately.
      if (meetingActive && value.enabled) shortcutManager.update({ bindings: value.bindings, enabled: true, active: true });
      result = updateGlobalShortcuts({ bindings: value.bindings, enabled: value.enabled });
    }
    catch (error) { meetingActive = oldActive; throw error; }
    if (value.save === true) {
      const file = path.join(app.getPath('userData'), 'shortcuts.json');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify({ bindings: result.bindings, enabled: result.enabled }), { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
    }
    return result;
  });
  shortcutWrites = update; return update;
});
ipcMain.handle('desktop:speech-status', event => { requireTrustedIpc(event); return offlineSpeech.status(); });
ipcMain.handle('desktop:speech-install', event => { requireTrustedIpc(event); return offlineSpeech.install(); });
ipcMain.handle('desktop:speech-transcribe', (event, pcm) => { requireTrustedIpc(event); return offlineSpeech.transcribe(pcm); });
ipcMain.handle('desktop:speech-cancel', event => { requireTrustedIpc(event); offlineSpeech.cancel(); });

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  try {
    app.setAppUserModelId('com.pairo.meetingcopilot');
    preferencesStore = createPreferencesStore(app.getPath('userData'));
    try { typingSettings = validateTyping(JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'typing-settings.json'), 'utf8'))); } catch { /* Use defaults for missing/invalid settings. */ }
    textAutomation = createTextAutomation({ globalShortcut, onShortcut: action => {
      if (meetingActive && shortcutManager?.snapshot().enabled && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) mainWindow.webContents.send('desktop-shortcut', action);
    }, onStatus: value => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-typing-status', value);
    } });
    // Start without foreground interaction; an unsupported OS does not prevent other app features.
    void textAutomation.initialize().catch(() => {});
    const { DEFAULT_SHORTCUTS, validateShortcuts } = await import(pathToFileURL(path.join(app.getAppPath(), 'src', 'shortcuts.js')).href);
    shortcutManager = createShortcutManager({ globalShortcut, defaults: DEFAULT_SHORTCUTS, validate: validateShortcuts,
      dispatch: action => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-shortcut', action); } });
    try { const saved = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'shortcuts.json'), 'utf8')); shortcutManager.update({ ...saved, active: false }); }
    catch { /* Missing or invalid settings use disabled defaults. */ }
    offlineSpeech = createOfflineSpeech(app.getPath('userData'), { fetchImpl: (...args) => net.fetch(...args) }); await offlineSpeech.initialize();
    configureMediaPermissions();
    configureDisplayCapture();
    await startServices();
    await createWindow();
    createTray();
  } catch (error) {
    dialog.showErrorBox('PAIRO 启动失败', error.message || String(error));
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  offlineSpeech?.cancel();
  textAutomation?.dispose();
  tray?.destroy(); tray = null;
  globalShortcut.unregisterAll();
  signaling?.wss.close();
  signaling?.server.close();
  uiServer?.close();
});
