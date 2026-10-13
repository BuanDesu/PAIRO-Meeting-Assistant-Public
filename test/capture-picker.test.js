import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import pickerModule from '../electron/capture-picker.cjs';

function fixture(timeoutMs) {
  const handlers = new Map(), parent = new EventEmitter(); parent.isDestroyed = () => false;
  let window;
  class Window extends EventEmitter {
    constructor(options) { super(); window = this; this.options = options; this.webContents = new EventEmitter(); this.webContents.mainFrame = {}; this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; }; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    removeMenu() {} show() { this.shown = true; }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
  }
  const sources = [{ id: 'window:42:0', name: 'Sensitive <title>', thumbnail: { toDataURL: () => 'data:image/png;base64,test' } }];
  const result = pickerModule.showCapturePicker({ parent, sources, BrowserWindow: Window, ipcMain: { handle: (id, handler) => handlers.set(id, handler), removeHandler: id => handlers.delete(id) }, timeoutMs });
  return { sources, parent, window, result, handlers, event: { sender: window.webContents, senderFrame: window.webContents.mainFrame } };
}

test('preview and selection IPC are confined to the picker main frame and a listed source', async () => {
  const fx = fixture(1000), list = [...fx.handlers.values()][0], choose = [...fx.handlers.values()][1];
  assert.equal(fx.window.options.webPreferences.nodeIntegration, false);
  assert.equal(fx.window.options.webPreferences.sandbox, true);
  assert.equal(fx.window.openHandler().action, 'deny');
  assert.throws(() => list({ sender: {}, senderFrame: fx.event.senderFrame }), /Untrusted/);
  assert.throws(() => choose({ sender: fx.event.sender, senderFrame: { url: fx.event.senderFrame.url } }, fx.sources[0].id), /Untrusted/);
  assert.equal(list(fx.event)[0].thumbnail, 'data:image/png;base64,test');
  assert.throws(() => choose(fx.event, 'window:unknown'), /Unknown/);
  choose(fx.event, fx.sources[0].id);
  assert.equal(await fx.result, fx.sources[0]);
  assert.equal(fx.handlers.size, 0);
  assert.equal(fx.window.destroyed, true);
});

test('picker cancellation, parent close and timeout release the pending request and IPC handlers', async () => {
  for (const kind of ['cancel', 'parent', 'timeout']) {
    const fx = fixture(kind === 'timeout' ? 10 : 1000);
    if (kind === 'cancel') [...fx.handlers.values()][1](fx.event, null);
    if (kind === 'parent') fx.parent.emit('closed');
    assert.equal(await fx.result, null);
    assert.equal(fx.handlers.size, 0);
    assert.equal(fx.parent.listenerCount('closed'), 0);
  }
});
