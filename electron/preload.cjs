const { contextBridge, ipcRenderer } = require('electron');
const invoke = async (channel, ...args) => {
  try { return await ipcRenderer.invoke(channel, ...args); }
  catch (error) { throw new Error(String(error.message || '操作未完成').replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
};

contextBridge.exposeInMainWorld('desktopBridge', Object.freeze({
  getSignalInfo: () => ipcRenderer.invoke('desktop:signal-info'),
  readPreferences: () => ipcRenderer.invoke('desktop:preferences-read'),
  writePreferences: value => ipcRenderer.invoke('desktop:preferences-write', value),
  openReleases: () => ipcRenderer.invoke('desktop:open-releases'),
  hideToTray: () => ipcRenderer.invoke('desktop:hide-to-tray'),
  copySelection: () => invoke('desktop:copy-selection'),
  prepareTyping: () => invoke('desktop:typing-prepare'),
  typeAnswer: value => invoke('desktop:typing-start', value),
  cancelTyping: () => invoke('desktop:typing-cancel'),
  readTypingSettings: () => invoke('desktop:typing-settings-read'),
  saveTypingSettings: value => invoke('desktop:typing-settings-write', value),
  onTypingStatus: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('desktop-typing-status', listener);
    return () => ipcRenderer.removeListener('desktop-typing-status', listener);
  },
  getShortcuts: () => ipcRenderer.invoke('desktop:shortcuts-read'),
  configureShortcuts: value => invoke('desktop:shortcuts-write', value),
  speechStatus: () => ipcRenderer.invoke('desktop:speech-status'),
  installSpeech: () => invoke('desktop:speech-install'),
  transcribeAudio: pcm => invoke('desktop:speech-transcribe', pcm),
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
