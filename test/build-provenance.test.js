import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProvenance } from '../scripts/build-provenance.mjs';

test('build provenance records the actual clean source and rejects mismatched or modified inputs', t => {
  const root = mkdtempSync(join(tmpdir(), 'pairo-provenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ version: '1.2.3', packages: { '': { version: '1.2.3' }, 'node_modules/electron': { version: '44.4.5' }, 'node_modules/@capacitor/android': { version: '8.5.2' } } }));
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
  const commit = git('rev-parse', 'HEAD');
  const result = buildProvenance(root, { GITHUB_SHA: commit, GITHUB_REF: 'refs/tags/v1.2.3' });
  assert.equal(result.sourceCommit, commit);
  assert.equal(result.version, '1.2.3');
  assert.equal(result.androidVersionCode, 1002004);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.throws(() => buildProvenance(root, { GITHUB_SHA: '0'.repeat(40) }), /expected Git commit/);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.4' }));
  assert.throws(() => buildProvenance(root, {}), /modified tracked files/);
});
