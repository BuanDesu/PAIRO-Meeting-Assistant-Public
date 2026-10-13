const { contextBridge, ipcRenderer } = require('electron');
const argument = process.argv.find(value => value.startsWith('--pairo-capture-token='));
const token = argument?.slice('--pairo-capture-token='.length);
if (/^[a-f0-9-]{36}$/.test(token || '')) {
  contextBridge.exposeInMainWorld('capturePicker', Object.freeze({
    list: () => ipcRenderer.invoke('capture:list:' + token),
    choose: id => ipcRenderer.invoke('capture:choose:' + token, id),
  }));
}
