import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

test('release asset gate rejects partial/wrong versions and generates both checksums', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pairo-release-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const exe = `Pairo-Meeting-Copilot-${version}-win-x64.exe`;
  const apk = `Pairo-Meeting-Copilot-${version}-android.apk`;
  const run = () => spawnSync(process.execPath, ['scripts/release-assets.mjs', root], { encoding: 'utf8', env: { ...process.env, GITHUB_REF: 'refs/tags/v' + version } });
  await writeFile(join(root, exe), 'test exe bytes');
  assert.notEqual(run().status, 0);
  await writeFile(join(root, apk), 'test apk bytes');
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  const checksums = await readFile(join(root, 'SHA256SUMS.txt'), 'utf8');
  assert.match(checksums, new RegExp(createHash('sha256').update('test apk bytes').digest('hex')));
  assert.equal(checksums.trim().split('\n').length, 2);
  await writeFile(join(root, 'Pairo-Meeting-Copilot-99.0.0-android.apk'), 'wrong version');
  assert.notEqual(run().status, 0);
});
