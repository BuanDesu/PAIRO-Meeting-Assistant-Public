const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopBridge', {
  getSignalInfo: () => ipcRenderer.invoke('ui-smoke-signal'),
  readPreferences: async () => ({}),
  writePreferences: async () => {},
  openReleases: () => ipcRenderer.invoke('ui-smoke-open-releases'),
  copySelection: () => ipcRenderer.invoke('ui-smoke-selection'),
  prepareTyping: () => ipcRenderer.invoke('ui-smoke-typing-prepare'),
  typeAnswer: value => ipcRenderer.invoke('ui-smoke-typing-start', value),
  cancelTyping: async () => {},
  readTypingSettings: () => ipcRenderer.invoke('ui-smoke-typing-settings-read'),
  saveTypingSettings: value => ipcRenderer.invoke('ui-smoke-typing-settings-write', value),
  onShortcut: callback => { ipcRenderer.on('ui-smoke-shortcut', (_event, action) => callback(action)); },
  saveQaSnapshot: name => ipcRenderer.invoke('ui-smoke-snapshot', name),
});
