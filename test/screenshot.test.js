import test from 'node:test';
import assert from 'node:assert/strict';
import { clampCrop, decodeScreenshot } from '../src/screenshot.js';

test('crop rounds inward and clips to the image without including pixels outside the selection', () => {
  assert.deepEqual(clampCrop(640, 360, { x: 10.2, y: 20.4, width: 101.5, height: 50.3 }), { x: 11, y: 21, width: 100, height: 49 });
  assert.deepEqual(clampCrop(640, 360, { x: 620, y: 350, width: 200, height: 100 }), { x: 620, y: 350, width: 20, height: 10 });
  assert.deepEqual(clampCrop(640, 360), { x: 0, y: 0, width: 640, height: 360 });
  assert.throws(() => clampCrop(640, 360, { x: NaN, y: 0, width: 10, height: 10 }));
  assert.throws(() => clampCrop(640, 360, { x: 700, y: 0, width: 10, height: 10 }));
});

test('invalid image, decode failure, timeout and cancellation are never acknowledged as received', async t => {
  const original = globalThis.Image;
  t.after(() => { globalThis.Image = original; });
  globalThis.Image = class { set src(value) { if (value) queueMicrotask(() => this.onerror?.()); } };
  await assert.rejects(decodeScreenshot({ image: 'data:image/jpeg;base64,BROKEN', id: 'valid-id' }), /解码/);
  await assert.rejects(decodeScreenshot({ image: 'https://external.example/image.png' }), /无效/);
  globalThis.Image = class { set src(value) {} };
  await assert.rejects(decodeScreenshot({ image: 'data:image/png;base64,TEST' }, { timeoutMs: 10 }), /超时/);
  const controller = new AbortController();
  const decoding = decodeScreenshot({ image: 'data:image/png;base64,TEST' }, { signal: controller.signal });
  controller.abort(); await assert.rejects(decoding, { name: 'AbortError' });
});
