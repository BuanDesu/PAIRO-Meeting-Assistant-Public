const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopBridge', {
  getSignalInfo: () => ipcRenderer.invoke('ui-smoke-signal'),
  readPreferences: async () => ({}),
  writePreferences: async () => {},
  onShortcut: () => {},
});
