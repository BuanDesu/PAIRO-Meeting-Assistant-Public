const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

function showCapturePicker({ parent, sources, BrowserWindow, ipcMain, timeoutMs = 120000, visible = true }) {
  if (!parent || parent.isDestroyed() || !sources.length) return Promise.resolve(null);
  return new Promise(resolve => {
    const token = randomUUID(), listChannel = 'capture:list:' + token, chooseChannel = 'capture:choose:' + token;
    const file = path.join(__dirname, 'capture-picker.html'), url = pathToFileURL(file).href;
    const picker = new BrowserWindow({
      parent, modal: true, width: 880, height: 700, minWidth: 560, minHeight: 420, show: false,
      title: '选择共享内容', backgroundColor: '#0b1421',
      webPreferences: { preload: path.join(__dirname, 'capture-picker-preload.cjs'), sandbox: true,
        contextIsolation: true, nodeIntegration: false, webSecurity: true,
        partition: 'pairo-capture-' + token, additionalArguments: ['--pairo-capture-token=' + token] },
    });
    let finished = false;
    const complete = source => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      ipcMain.removeHandler(listChannel); ipcMain.removeHandler(chooseChannel);
      parent.removeListener('closed', cancel);
      if (!picker.isDestroyed()) picker.destroy();
      resolve(source);
    };
    const cancel = () => complete(null);
    const validSender = event => !finished && !picker.isDestroyed() && event.sender === picker.webContents
      && event.senderFrame === picker.webContents.mainFrame && event.senderFrame.url === url;
    const timer = setTimeout(cancel, timeoutMs);
    parent.once('closed', cancel);
    picker.once('closed', cancel);
    picker.webContents.once('render-process-gone', cancel);
    picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    picker.webContents.on('will-navigate', (event, destination) => { if (destination !== url) event.preventDefault(); });
    ipcMain.handle(listChannel, event => {
      if (!validSender(event)) throw new Error('Untrusted capture picker sender');
      return sources.map(source => ({ id: source.id, name: source.name,
        kind: source.id.startsWith('screen:') ? 'screen' : 'window', thumbnail: source.thumbnail.toDataURL() }));
    });
    ipcMain.handle(chooseChannel, (event, id) => {
      if (!validSender(event)) throw new Error('Untrusted capture picker sender');
      if (id === null) { cancel(); return; }
      const source = typeof id === 'string' && sources.find(item => item.id === id);
      if (!source) throw new Error('Unknown capture source');
      complete(source);
    });
    picker.removeMenu();
    if (visible) picker.once('ready-to-show', () => { if (!finished) picker.show(); });
    picker.loadFile(file).catch(cancel);
  });
}

module.exports = { showCapturePicker };
