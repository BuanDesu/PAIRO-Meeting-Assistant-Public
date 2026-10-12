import test from 'node:test';
import assert from 'node:assert/strict';
import { androidVersionCode, verifyReleaseVersion } from '../scripts/release-version.mjs';

test('Android versions increase across patch, minor and major upgrades', () => {
  const versions = ['0.1.0', '0.1.1', '0.2.0', '0.999.999', '1.0.0'];
  const codes = versions.map(androidVersionCode);
  assert.ok(codes[0] > 1); // previously shipped debug APK
  for (let i = 1; i < codes.length; i++) assert.ok(codes[i] > codes[i - 1]);
  for (const version of ['0.1.0-beta', '1.1000.0', '1.0.1000', '9999.0.0', '01.0.0']) {
    assert.throws(() => androidVersionCode(version));
  }
});

test('release gate rejects mismatched tags and either lockfile version', () => {
  const pkg = { version: '0.2.0' };
  const lock = { version: '0.2.0', packages: { '': { version: '0.2.0' } } };
  assert.equal(verifyReleaseVersion(pkg, lock, 'refs/tags/v0.2.0').version, '0.2.0');
  assert.throws(() => verifyReleaseVersion(pkg, lock, 'refs/tags/v0.1.0'));
  assert.throws(() => verifyReleaseVersion(pkg, { ...lock, version: '0.1.0' }));
  assert.throws(() => verifyReleaseVersion(pkg, { ...lock, packages: { '': { version: '0.1.0' } } }));
});
