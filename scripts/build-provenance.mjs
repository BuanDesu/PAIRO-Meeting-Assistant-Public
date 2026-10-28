import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyReleaseVersion } from './release-version.mjs';

export function buildProvenance(root = process.cwd(), env = process.env) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = git('rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(commit) || (env.GITHUB_SHA && env.GITHUB_SHA !== commit)) {
    throw new Error('Build source does not match the expected Git commit');
  }
  if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('Build source contains modified tracked files');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'));
  const version = verifyReleaseVersion(pkg, lock, env.GITHUB_REF || '');
  return {
    schemaVersion: 1,
    ...version,
    sourceRepository: 'https://github.com/BuanDesu/PAIRO-Meeting-Assistant-Public',
    sourceCommit: commit,
    components: {
      electron: lock.packages['node_modules/electron'].version,
      capacitorAndroid: lock.packages['node_modules/@capacitor/android'].version,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = resolve('dist');
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'build-provenance.json'), JSON.stringify(buildProvenance(), null, 2) + '\n');
  console.log('Recorded verified source identity in dist/build-provenance.json');
}
