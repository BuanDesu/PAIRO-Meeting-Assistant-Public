const { app, BrowserWindow, ipcMain } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
let win, ui, signaling;
const timeout = setTimeout(() => { console.error('UI smoke timed out'); app.exit(1); }, 30000);
app.disableHardwareAcceleration();
async function captureRendered() {
  // The first snapshot wakes the compositor for a hidden BrowserWindow.
  await win.webContents.capturePage();
  await new Promise(resolve => setTimeout(resolve, 150));
  return (await win.webContents.capturePage()).toPNG();
}

app.whenReady().then(async () => {
  const { createSignalingServer } = await import(pathToFileURL(path.join(root, 'server/signaling.js')).href);
  signaling = createSignalingServer({ allowedOrigins: '' });
  await new Promise(resolve => signaling.server.listen(0, '127.0.0.1', resolve));
  const signalBase = 'http://127.0.0.1:' + signaling.server.address().port;
  ipcMain.handle('ui-smoke-signal', () => ({ signalBase, lanAddresses: [
    { interface: 'Wi-Fi', ip: '192.168.1.20', url: 'http://192.168.1.20:8787' },
    { interface: 'VPN', ip: '10.0.0.1', url: 'http://10.0.0.1:8787' },
  ] }));
  ui = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/bootstrap') { response.end('<html><body></body></html>'); return; }
      const target = path.resolve(dist, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
      if (!target.startsWith(dist + path.sep)) { response.writeHead(403).end(); return; }
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      response.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
      response.end(await fs.readFile(target));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + ui.address().port;
  win = new BrowserWindow({ width: 1120, height: 900, show: false, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'ui-smoke-preload.cjs') } });
  await win.loadURL(origin + '/bootstrap');
  await win.webContents.executeJavaScript("localStorage.setItem('pairo.preferences.v1','null')");
  await win.loadURL(origin);
  const result = await win.webContents.executeJavaScript(`(async () => {
    const el = id => document.getElementById(id);
    const wait = async predicate => {
      const until = Date.now() + 5000;
      while (!predicate()) { if (Date.now() > until) throw new Error('UI did not reach expected state'); await new Promise(r => setTimeout(r, 20)); }
    };
    await wait(() => el('desktop-lan-select').options.length === 2);
    el('desktop-lan-select').value = 'http://10.0.0.1:8787';
    el('desktop-lan-select').dispatchEvent(new Event('change'));
    if (el('desktop-lan-addresses').textContent !== 'http://10.0.0.1:8787') throw new Error('Address selection is ignored');
    el('desktop-lan-select').value = 'http://192.168.1.20:8787';
    el('desktop-lan-select').dispatchEvent(new Event('change'));
    const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=360;
    canvas.getContext('2d').fillStyle='#294758'; canvas.getContext('2d').fillRect(0,0,640,360);
    const capture = canvas.captureStream(5);
    const track = capture.getVideoTracks()[0];
    navigator.mediaDevices.getDisplayMedia = async () => capture;
    el('capture-mic').checked = false;
    el('start-share').click();
    await wait(() => !el('pairing-qr').hidden && el('pairing-qr-image').complete && el('pairing-qr-image').naturalWidth > 0);
    await wait(() => el('desktop-feed-status').textContent === '等待手机配对');
    el('pairing-qr').scrollIntoView({ block: 'center' });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.uiSmokeTrack = track;
    return {invalidPreferencesRecovered:true,addressSelection:true,qrRendered:true,roomCode:el('room-code').textContent};
  })()`);
  await fs.mkdir(path.join(root, 'release', 'ui-qa'), { recursive: true });
  await fs.writeFile(path.join(root, 'release', 'ui-qa', 'desktop.png'), await captureRendered());
  await win.setContentSize(390, 844);
  const mobile = await win.webContents.executeJavaScript(`(async () => {
    document.getElementById('mobile-tab').click();
    window.scrollTo(0,0);
    if (window.uiSmokeTrack.readyState !== 'ended') throw new Error('Role switch kept capture running');
    if (!document.getElementById('pairing-qr').hidden) throw new Error('Stale QR code remained visible');
    if (document.getElementById('mobile-view').hidden) throw new Error('Phone view did not open');
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (document.documentElement.scrollWidth>window.innerWidth) throw new Error('Phone layout overflows');
    return {captureStopped:true,phoneLayoutFits:true};
  })()`);
  await fs.writeFile(path.join(root, 'release', 'ui-qa', 'mobile.png'), await captureRendered());
  console.log(JSON.stringify({ ...result, ...mobile }));
  clearTimeout(timeout); win.destroy();
  for (const socket of signaling.wss.clients) socket.terminate();
  signaling.wss.close(); signaling.server.close(); ui.close(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
