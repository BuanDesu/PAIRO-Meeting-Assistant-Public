const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', Object.freeze({
  getSignalInfo: () => ipcRenderer.invoke('desktop:signal-info'),
  onShortcut: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('desktop-shortcut', listener);
    return () => ipcRenderer.removeListener('desktop-shortcut', listener);
  },
}));
