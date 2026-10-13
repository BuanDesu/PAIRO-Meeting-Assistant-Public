const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopBridge', {
  getSignalInfo: () => ipcRenderer.invoke('ui-smoke-signal'),
  readPreferences: async () => ({}),
  writePreferences: async () => {},
  openReleases: () => ipcRenderer.invoke('ui-smoke-open-releases'),
  onShortcut: () => {},
  saveQaSnapshot: name => ipcRenderer.invoke('ui-smoke-snapshot', name),
});
