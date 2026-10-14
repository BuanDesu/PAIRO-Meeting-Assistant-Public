const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', Object.freeze({
  getSignalInfo: () => ipcRenderer.invoke('desktop:signal-info'),
  readPreferences: () => ipcRenderer.invoke('desktop:preferences-read'),
  writePreferences: value => ipcRenderer.invoke('desktop:preferences-write', value),
  openReleases: () => ipcRenderer.invoke('desktop:open-releases'),
  hideToTray: () => ipcRenderer.invoke('desktop:hide-to-tray'),
  getShortcuts: () => ipcRenderer.invoke('desktop:shortcuts-read'),
  configureShortcuts: value => ipcRenderer.invoke('desktop:shortcuts-write', value),
  speechStatus: () => ipcRenderer.invoke('desktop:speech-status'),
  installSpeech: () => ipcRenderer.invoke('desktop:speech-install'),
  transcribeAudio: pcm => ipcRenderer.invoke('desktop:speech-transcribe', pcm),
  cancelTranscription: () => ipcRenderer.invoke('desktop:speech-cancel'),
  onShortcutError: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('desktop-shortcut-error', listener);
    return () => ipcRenderer.removeListener('desktop-shortcut-error', listener);
  },
  onShortcut: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('desktop-shortcut', listener);
    return () => ipcRenderer.removeListener('desktop-shortcut', listener);
  },
}));
