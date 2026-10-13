export const PAIRING_VERSION = 1;

export function scanFailureMessage(error) {
  const message = String(error?.message || '');
  if (/camera|permission|access wasn't provided|相机|权限/i.test(message)) {
    return '相机权限未开启。请在手机设置 → 应用 → PAIRO → 权限中允许相机，再返回重试；也可以手动填写地址与房间码。';
  }
  if (/cancel|取消/i.test(message)) return '扫码已取消，也可以手动填写地址与房间码。';
  if (/二维码|配对|版本|房间码|地址|设备时间/.test(message)) return message + '。可重试扫码，或手动填写地址与房间码。';
  return '无法完成扫码，请重新打开扫码；也可以手动填写地址与房间码。';
}

function validatePairing(value, now) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== 'pairo-pairing') throw new Error('这不是 PAIRO 配对二维码');
  if (value.version !== PAIRING_VERSION) throw new Error('配对版本不兼容，请同时更新电脑和手机程序');
  if (typeof value.room !== 'string' || !/^[A-Z2-9]{8,12}$/.test(value.room)) throw new Error('二维码中的房间码无效');
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 15 * 60 * 1000) throw new Error('配对二维码已过期或设备时间不一致，请核对时间并在电脑上刷新后重扫');
  let url;
  try { url = new URL(value.signalBase); } catch { throw new Error('二维码中的电脑地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /^(localhost|127\.|0\.0\.0\.0|\[::1\]|\[::\])/.test(url.hostname)) {
    throw new Error('二维码必须包含手机可访问的电脑地址');
  }
  return { signalBase: url.origin, room: value.room, expiresAt: value.expiresAt };
}

export function createPairingCode(signalBase, room, now = Date.now()) {
  const data = { type: 'pairo-pairing', version: PAIRING_VERSION, signalBase, room, expiresAt: now + 10 * 60 * 1000 };
  Object.assign(data, validatePairing(data, now));
  return JSON.stringify(data);
}

export function parsePairingCode(text, now = Date.now()) {
  if (typeof text !== 'string' || text.length > 2048) throw new Error('配对二维码内容无效');
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('请扫描电脑程序显示的 PAIRO 配对二维码'); }
  return validatePairing(value, now);
}

export async function checkSignaling(base, { nativeHttp, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  let url;
  try { url = new URL(base); } catch { throw new Error('请填写完整电脑地址，例如 http://192.168.1.23:8787'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('连接地址必须使用 http 或 https');
  url = new URL('/health', url.origin);
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('电脑未响应，请检查地址、同一 Wi-Fi 和电脑防火墙')); }, timeoutMs);
  });
  try {
    const operation = (async () => {
      let ok, data;
      if (nativeHttp) {
        const response = await nativeHttp.get({ url: url.href, responseType: 'json', connectTimeout: timeoutMs, readTimeout: timeoutMs });
        ok = response.status === 200;
        data = response.data;
      } else {
        const response = await fetchImpl(url, { signal: controller.signal, cache: 'no-store' });
        ok = response.ok;
        data = await response.json();
      }
      if (!ok || data?.ok !== true || data?.service !== 'p2p-meeting-copilot-signaling') throw new Error('此地址不是可用的 PAIRO 电脑服务，请核对电脑显示的地址');
      return '电脑服务可访问。请核对房间码后点击连接。';
    })();
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (/电脑|PAIRO/.test(error.message)) throw error;
    throw new Error('无法访问电脑，请确认程序已开启、两台设备在同一 Wi-Fi，且防火墙允许连接');
  } finally { clearTimeout(timer); }
}
