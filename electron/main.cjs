const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const { app, BrowserWindow, desktopCapturer, session, dialog, globalShortcut, ipcMain, shell } = require('electron');
const { isTrustedUiUrl, mediaPermissionKind } = require('./security.cjs');
const { createPreferencesStore } = require('./preferences.cjs');
const { lanAddresses } = require('./network.cjs');
const { showCapturePicker } = require('./capture-picker.cjs');

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

function registerShortcuts() {
  const bindings = [
    ['Alt+Shift+S', 'screenshot'],
    ['Alt+Shift+M', 'voice'],
    ['Alt+Shift+A', 'auto-answer'],
  ];
  for (const [accelerator, action] of bindings) {
    const registered = globalShortcut.register(accelerator, () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-shortcut', action);
    });
    if (registered) registeredShortcuts.push(accelerator);
    else console.warn('Unable to register global shortcut:', accelerator);
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 980,
    minHeight: 700,
    backgroundColor: '#080d18',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.removeMenu();
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
  return shell.openExternal('https://github.com/BuanDesu/p2p-meeting-copilot/releases/latest');
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  try {
    app.setAppUserModelId('com.pairo.meetingcopilot');
    preferencesStore = createPreferencesStore(app.getPath('userData'));
    configureMediaPermissions();
    configureDisplayCapture();
    await startServices();
    await createWindow();
    registerShortcuts();
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
  globalShortcut.unregisterAll();
  signaling?.wss.close();
  signaling?.server.close();
  uiServer?.close();
});
