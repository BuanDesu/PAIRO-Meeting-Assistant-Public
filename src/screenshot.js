import { validScreenshotId } from './screenshot-transfer.js';

export function clampCrop(width, height, rectangle = { x: 0, y: 0, width, height }) {
  if (![width, height, rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isFinite)
    || width < 1 || height < 1 || rectangle.width <= 0 || rectangle.height <= 0) throw new Error('请选择有效的截图区域');
  // Round inward so pixels outside the user-selected region are never included.
  const x = Math.ceil(Math.max(0, rectangle.x)), y = Math.ceil(Math.max(0, rectangle.y));
  const right = Math.floor(Math.min(width, rectangle.x + rectangle.width)), bottom = Math.floor(Math.min(height, rectangle.y + rectangle.height));
  if (right <= x || bottom <= y) throw new Error('截图区域过小，请重新框选');
  return { x, y, width: right - x, height: bottom - y };
}

export function cropCanvas(source, rectangle) {
  const crop = clampCrop(source.videoWidth || source.width, source.videoHeight || source.height, rectangle);
  const scale = Math.min(1, 1440 / crop.width, 1440 / crop.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(crop.width * scale)); canvas.height = Math.max(1, Math.floor(crop.height * scale));
  canvas.getContext('2d').drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function screenshotPayload(canvas) {
  const image = canvas.toDataURL('image/jpeg', 0.74);
  if (image.length > 3500000) throw new Error('截图仍然过大，请选择更小的区域后重试');
  return { image, width: canvas.width, height: canvas.height, at: Date.now() };
}

export async function decodeScreenshot(message, { timeoutMs = 10000, signal } = {}) {
  if (typeof message.image !== 'string' || message.image.length > 3500000 || !/^data:image\/(jpeg|png|webp);base64,/i.test(message.image)
    || (message.id !== undefined && !validScreenshotId(message.id))) throw new Error('收到无效的截图');
  signal?.throwIfAborted();
  const image = new Image();
  let timer, abort;
  try {
    await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason || new DOMException('接收已取消', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      image.onload = resolve; image.onerror = () => reject(new Error('截图无法解码'));
      timer = setTimeout(() => reject(new Error('截图解码超时')), timeoutMs);
      image.src = message.image;
    });
    signal?.throwIfAborted();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16000000) throw new Error('截图尺寸超过限制');
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    image.onload = null; image.onerror = null; image.src = '';
  }
}
