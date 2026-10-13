import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('every literal main and screenshot-region element lookup is present in the HTML', async () => {
  const [html, main, region] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/screenshot-region.js', import.meta.url), 'utf8'),
  ]);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const used = new Set([...(main + region).matchAll(/(?:\$|el)\('([a-z][a-z0-9-]*)'\)/g)].map(match => match[1]));
  const missing = [...used].filter(id => !ids.has(id));
  assert.deepEqual(missing, []);
});
