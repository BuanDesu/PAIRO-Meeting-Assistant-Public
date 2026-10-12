const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', Object.freeze({
  getSignalInfo: () => ipcRenderer.invoke('desktop:signal-info'),
  readPreferences: () => ipcRenderer.invoke('desktop:preferences-read'),
  writePreferences: value => ipcRenderer.invoke('desktop:preferences-write', value),
  onShortcut: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('desktop-shortcut', listener);
    return () => ipcRenderer.removeListener('desktop-shortcut', listener);
  },
}));
