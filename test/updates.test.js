import test from 'node:test';
import assert from 'node:assert/strict';
import { availableRelease, newerVersion, releaseVersion, checkLatestRelease, updateMessage, RELEASES_URL } from '../src/updates.js';

const release = (version = '0.3.0') => ({ draft: false, prerelease: false, tag_name: 'v' + version, assets: [
  { name: `Pairo-Meeting-Copilot-${version}-win-x64.exe`, state: 'uploaded', size: 100 },
  { name: `Pairo-Meeting-Copilot-${version}-android.apk`, state: 'uploaded', size: 100 },
] });

test('compares numeric stable versions and rejects malformed or prerelease tags', () => {
  assert.equal(newerVersion('v0.10.0', '0.9.9'), true);
  assert.equal(newerVersion('0.2.0', '0.2.0'), false);
  assert.equal(newerVersion('0.1.9', '0.2.0'), false);
  assert.equal(newerVersion('1.0.0', '0.99.99'), true);
  for (const tag of ['v0.3.0-beta', '0.03.0', 'v0.3.0\n', '<script>', '9999999999.0.0', null]) assert.equal(releaseVersion(tag), null);
});

test('only announces published stable releases with both matching uploaded packages', () => {
  assert.deepEqual(availableRelease(release(), '0.2.0'), { kind: 'newer', version: '0.3.0' });
  assert.equal(availableRelease(release('0.1.0'), '0.2.0').kind, 'current');
  assert.equal(availableRelease({ ...release(), draft: true }, '0.2.0').kind, 'unavailable');
  assert.equal(availableRelease({ ...release(), prerelease: true }, '0.2.0').kind, 'unavailable');
  const pending = release(); pending.assets[0].state = 'new';
  assert.equal(availableRelease(pending, '0.2.0').kind, 'incomplete');
  assert.equal(availableRelease({ ...release(), assets: [] }, '0.2.0').kind, 'incomplete');
});

test('checks only the fixed GitHub endpoint without credentials, redirects or model information', async () => {
  const data = release(); data.html_url = 'https://untrusted.example/';
  const result = await checkLatestRelease('0.2.0', { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/BuanDesu/PAIRO-Meeting-Assistant-Public/releases/latest');
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.headers.Authorization, undefined);
    return new Response(JSON.stringify(data));
  } });
  assert.deepEqual(result, { kind: 'newer', version: '0.3.0' });
  assert.equal(RELEASES_URL, 'https://github.com/BuanDesu/PAIRO-Meeting-Assistant-Public/releases/latest');
});

test('private access, rate limiting, malformed and oversized responses remain actionable', async () => {
  for (const [status, kind] of [[401, 'private'], [404, 'private'], [403, 'limited'], [429, 'limited'], [500, 'unavailable']]) {
    const result = await checkLatestRelease('0.2.0', { fetchImpl: async () => new Response('', { status }) });
    assert.equal(result.kind, kind);
    assert.ok(updateMessage(result).length > 10);
  }
  for (const body of ['{', 'x'.repeat(128 * 1024 + 1)]) {
    assert.equal((await checkLatestRelease('0.2.0', { fetchImpl: async () => new Response(body) })).kind, 'unavailable');
  }
});

test('hung version queries are aborted and do not prevent retry', async () => {
  let aborted = false;
  const result = await checkLatestRelease('0.2.0', { timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(new Error('timeout')); }, { once: true });
  }) });
  assert.equal(aborted, true); assert.equal(result.kind, 'unavailable');
  assert.equal((await checkLatestRelease('0.2.0', { fetchImpl: async () => new Response(JSON.stringify(release())) })).kind, 'newer');
});
