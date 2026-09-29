const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { pathToFileURL } = require('node:url');
const { createServer } = require('node:http');
const { app, BrowserWindow, desktopCapturer, session, dialog, globalShortcut, ipcMain } = require('electron');

const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
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
  const addresses = [];
  for (const [name, records] of Object.entries(os.networkInterfaces())) {
    for (const record of records || []) {
      if (record.family !== 'IPv4' || record.internal || record.address.startsWith('169.254.')) continue;
      addresses.push({ interface: name, ip: record.address, url: 'http://' + record.address + ':' + signalingPort });
    }
  }
  return addresses;
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
  session.defaultSession.setPermissionRequestHandler(async (_webContents, permission, callback, details) => {
    if (permission !== 'media' || !details?.mediaTypes?.includes('audio')) {
      callback(false);
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
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 180, height: 110 },
      });
      if (!sources.length) {
        callback({});
        return;
      }
      const buttons = sources.map(source => source.name).concat(['取消']);
      const options = {
        type: 'question',
        title: '选择要分享的屏幕或窗口',
        message: '请选择本次要发送到已配对手机的内容。',
        buttons,
        cancelId: buttons.length - 1,
        defaultId: 0,
      };
      const answer = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
      const source = answer.response < sources.length ? sources[answer.response] : null;
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source, audio: request.audioRequested ? 'loopback' : undefined });
    } catch {
      callback({});
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
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL('http://127.0.0.1:' + uiPort + '/');
}

ipcMain.handle('desktop:signal-info', () => ({
  signalBase: 'http://127.0.0.1:' + signalingPort,
  signalingPort,
  lanAddresses: getLanAddresses(),
  registeredShortcuts,
}));

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  try {
    app.setAppUserModelId('com.pairo.meetingcopilot');
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
