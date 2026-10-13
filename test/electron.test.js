import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import security from '../electron/security.cjs';
import preferences from '../electron/preferences.cjs';
import vm from 'node:vm';

test('release-page IPC accepts only the app main frame and always uses a fixed HTTPS destination', async () => {
  const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const handlers = new Map(), opened = [];
  const frame = { url: 'http://127.0.0.1:5000/' };
  const contents = { mainFrame: frame, getURL: () => frame.url };
  const context = {
    mainWindow: { isDestroyed: () => false, webContents: contents },
    uiOrigin: () => 'http://127.0.0.1:5000', isTrustedUiUrl: security.isTrustedUiUrl,
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    shell: { openExternal: url => { opened.push(url); } },
  };
  vm.runInNewContext(source.slice(source.indexOf('function trustedContents'), source.indexOf('const hasSingleInstanceLock')) + source.slice(source.indexOf("ipcMain.handle('desktop:signal-info'"), source.indexOf('app.whenReady()')), context);
  const open = handlers.get('desktop:open-releases');
  open({ sender: contents, senderFrame: frame }, 'https://untrusted.example/');
  assert.deepEqual(opened, ['https://github.com/BuanDesu/p2p-meeting-copilot/releases/latest']);
  assert.throws(() => open({ sender: contents, senderFrame: { url: frame.url } }), /Untrusted/);
  assert.throws(() => open({ sender: {}, senderFrame: frame }), /Untrusted/);
  frame.url = 'https://untrusted.example/';
  assert.throws(() => open({ sender: contents, senderFrame: frame }), /Untrusted/);
  assert.equal(opened.length, 1);
});

test('allows legacy and modern display permission while separating microphone and camera', () => {
  assert.equal(security.mediaPermissionKind('media', { mediaTypes: [] }), 'display');
  assert.equal(security.mediaPermissionKind('display-capture', { mediaTypes: ['video'] }), 'display');
  assert.equal(security.mediaPermissionKind('media', { mediaTypes: ['audio'] }), 'microphone');
  assert.equal(security.mediaPermissionKind('media', { mediaTypes: ['video', 'audio'] }), 'deny');
  assert.equal(security.mediaPermissionKind('clipboard-read'), 'deny');
  assert.equal(security.isTrustedUiUrl('http://127.0.0.1:5000/', 'http://127.0.0.1:5000'), true);
  assert.equal(security.isTrustedUiUrl('http://127.0.0.1:5001/', 'http://127.0.0.1:5000'), false);
  assert.equal(security.isTrustedUiUrl('https://evil.example', 'http://127.0.0.1:5000'), false);
});

test('preferences survive store recreation and never persist API keys', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pairo-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = preferences.createPreferencesStore(directory);
  assert.deepEqual(await first.read(), {});
  await Promise.all([
    first.write({ endpoint: 'https://old.example', apiKey: 'secret' }),
    first.write({ endpoint: 'https://llm.example', model: 'vision', signalBase: '', apiKey: 'secret' }),
  ]);
  const reopened = preferences.createPreferencesStore(directory);
  assert.deepEqual(await reopened.read(), { endpoint: 'https://llm.example', model: 'vision', signalBase: '' });
  assert.ok(!(await readFile(join(directory, 'preferences.json'), 'utf8')).includes('secret'));
});

test('cancelled screen picker consumes the Electron callback exactly once even when it throws', async () => {
  const source = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
  const fragment = source.slice(source.indexOf('function configureDisplayCapture()'), source.indexOf('function registerShortcuts()'));
  let handler;
  const frame = { url: 'http://127.0.0.1:5000/' };
  vm.runInNewContext(fragment + '\nconfigureDisplayCapture();', {
    session: { defaultSession: { setDisplayMediaRequestHandler: value => { handler = value; } } },
    mainWindow: { webContents: { mainFrame: frame } },
    isTrustedUiUrl: security.isTrustedUiUrl, uiOrigin: () => 'http://127.0.0.1:5000',
    desktopCapturer: { getSources: async () => [] }, console,
  });
  let calls = 0;
  await handler({ frame }, () => { calls++; throw new Error('Invalid video source'); });
  assert.equal(calls, 1);
});
