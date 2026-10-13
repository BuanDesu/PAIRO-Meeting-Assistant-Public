import { clampCrop, cropCanvas } from './screenshot.js';

export function selectScreenshotRegion(video, signal) {
  signal?.throwIfAborted();
  const el = id => document.getElementById(id);
  const dialog = el('region-dialog'), preview = el('region-preview'), box = el('region-box'), send = el('region-send');
  if (!video.videoWidth || !video.videoHeight) return Promise.reject(new Error('画面尚未准备好'));
  const scale = Math.min(1, 3840 / video.videoWidth, 2160 / video.videoHeight);
  preview.width = Math.floor(video.videoWidth * scale); preview.height = Math.floor(video.videoHeight * scale);
  preview.getContext('2d').drawImage(video, 0, 0, preview.width, preview.height);
  send.disabled = true; box.hidden = true;
  for (const [id, value] of [['region-x', 0], ['region-y', 0], ['region-width', 100], ['region-height', 100]]) el(id).value = value;
  return new Promise((resolve, reject) => {
    let rectangle, start, completed = false;
    const listeners = [];
    const listen = (target, name, handler) => { target.addEventListener(name, handler); listeners.push([target, name, handler]); };
    const finish = (canvas, error) => {
      if (completed) return;
      completed = true;
      for (const [target, name, handler] of listeners) target.removeEventListener(name, handler);
      signal?.removeEventListener('abort', abort);
      dialog.close(); preview.width = 0; preview.height = 0; box.hidden = true;
      error ? reject(error) : resolve(canvas);
    };
    const abort = () => finish(null, signal.reason || new DOMException('区域选择已取消', 'AbortError'));
    const render = raw => {
      try { rectangle = clampCrop(preview.width, preview.height, raw); } catch { rectangle = null; }
      send.disabled = !rectangle || rectangle.width < 8 || rectangle.height < 8; box.hidden = !rectangle;
      if (!rectangle) return;
      for (const [property, value] of [['left', rectangle.x / preview.width], ['top', rectangle.y / preview.height], ['width', rectangle.width / preview.width], ['height', rectangle.height / preview.height]]) box.style[property] = value * 100 + '%';
      for (const [id, value] of [['region-x', rectangle.x / preview.width], ['region-y', rectangle.y / preview.height], ['region-width', rectangle.width / preview.width], ['region-height', rectangle.height / preview.height]]) el(id).value = (value * 100).toFixed(2);
    };
    const point = event => {
      const bounds = preview.getBoundingClientRect();
      return { x: Math.max(0, Math.min(preview.width, (event.clientX - bounds.left) / bounds.width * preview.width)),
        y: Math.max(0, Math.min(preview.height, (event.clientY - bounds.top) / bounds.height * preview.height)) };
    };
    listen(preview, 'pointerdown', event => { if (event.button !== 0) return; start = point(event); rectangle = null; send.disabled = true; box.hidden = true; preview.setPointerCapture(event.pointerId); event.preventDefault(); });
    listen(preview, 'pointermove', event => {
      if (!start) return;
      const end = point(event); render({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) });
    });
    listen(preview, 'pointerup', () => { start = null; });
    listen(preview, 'pointercancel', () => { start = null; rectangle = null; send.disabled = true; box.hidden = true; });
    for (const id of ['region-x', 'region-y', 'region-width', 'region-height']) listen(el(id), 'input', () => {
      const value = name => Number(el(name).value) / 100;
      render({ x: value('region-x') * preview.width, y: value('region-y') * preview.height,
        width: value('region-width') * preview.width, height: value('region-height') * preview.height });
    });
    listen(el('region-cancel'), 'click', () => finish(null));
    listen(dialog, 'cancel', event => { event.preventDefault(); finish(null); });
    listen(dialog, 'close', () => finish(null));
    listen(send, 'click', () => {
      if (send.disabled || !rectangle) return;
      try { finish(cropCanvas(preview, rectangle)); } catch (error) { finish(null, error); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    try { dialog.showModal(); } catch (error) { finish(null, error); }
    if (signal?.aborted) abort();
  });
}
