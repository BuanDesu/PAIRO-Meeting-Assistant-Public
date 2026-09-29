import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('defines portable Windows and Capacitor Android outputs', async () => {
  const [pkgText, capacitorText, viteText, androidBuild, desktopBuild, portableScript] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../capacitor.config.json', import.meta.url), 'utf8'),
    readFile(new URL('../vite.config.js', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/build-android.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/build-desktop.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/portable.nsi', import.meta.url), 'utf8'),
  ]);
  const pkg = JSON.parse(pkgText);
  const capacitor = JSON.parse(capacitorText);
  assert.equal(pkg.main, 'electron/main.cjs');
  assert.equal(pkg.build.win.signAndEditExecutable, false);
  assert.match(pkg.scripts['desktop:portable'], /build-desktop/);
  assert.match(desktopBuild, /--dir/);
  assert.match(portableScript, /PORTABLE_EXECUTABLE_DIR/);
  assert.match(pkg.scripts['android:apk'], /build-android/);
  assert.match(androidBuild, /assembleDebug/);
  assert.equal(capacitor.appId, 'com.pairo.meetingcopilot');
  assert.equal(capacitor.server.androidScheme, 'http');
  assert.equal(capacitor.server.cleartext, true);
  assert.ok(viteText.includes("base: './'"));
});
