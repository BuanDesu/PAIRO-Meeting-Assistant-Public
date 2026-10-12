import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import security from '../electron/security.cjs';
import preferences from '../electron/preferences.cjs';
import vm from 'node:vm';

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
