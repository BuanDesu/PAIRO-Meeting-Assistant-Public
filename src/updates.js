export const RELEASES_URL = 'https://github.com/BuanDesu/p2p-meeting-copilot/releases/latest';
const LATEST_API = 'https://api.github.com/repos/BuanDesu/p2p-meeting-copilot/releases/latest';
const MAX_RESPONSE_BYTES = 128 * 1024;

export function releaseVersion(value) {
  const match = typeof value === 'string' && /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.exec(value);
  return match ? match.slice(1).map(Number) : null;
}

export function newerVersion(candidate, current) {
  const left = releaseVersion(candidate), right = releaseVersion(current);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

export function availableRelease(data, current) {
  if (!data || data.draft !== false || data.prerelease !== false || !releaseVersion(data.tag_name)) return { kind: 'unavailable' };
  const version = releaseVersion(data.tag_name).join('.');
  const names = new Set(Array.isArray(data.assets) ? data.assets.filter(a => a?.state === 'uploaded' && a.size > 0).map(a => a.name) : []);
  if (!names.has(`Pairo-Meeting-Copilot-${version}-win-x64.exe`) || !names.has(`Pairo-Meeting-Copilot-${version}-android.apk`)) return { kind: 'incomplete' };
  return { kind: newerVersion(version, current) ? 'newer' : 'current', version };
}

export async function checkLatestRelease(current, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reader;
  try {
    const response = await fetchImpl(LATEST_API, {
      credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
    });
    if (response.status === 401 || response.status === 404) return { kind: 'private' };
    if (response.status === 403 || response.status === 429) return { kind: 'limited' };
    if (!response.ok || !response.body) return { kind: 'unavailable' };
    reader = response.body.getReader();
    let bytes = 0, text = '';
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) return { kind: 'unavailable' };
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return availableRelease(JSON.parse(text), current);
  } catch { return { kind: 'unavailable' }; }
  finally { clearTimeout(timer); try { await reader?.cancel(); } catch { /* response already closed */ } }
}

export function updateMessage(result) {
  switch (result.kind) {
    case 'newer': return `发现正式版本 ${result.version}。请到发布页下载 EXE 和 APK，同时更新电脑与手机。`;
    case 'current': return `可读取的正式版本为 ${result.version}，没有比当前更高的正式版本。`;
    case 'private': return '仓库未公开或暂时无法读取版本。请打开发布页，在浏览器登录有仓库权限的 GitHub 账号，查看版本号。';
    case 'limited': return 'GitHub 暂时限制了版本查询。请稍后重试，或直接打开发布页查看。';
    case 'incomplete': return '发布页的安装包尚未齐备，请稍后再查看。';
    default: return '暂时无法检查版本。请检查网络后重试，也可以直接打开发布页。';
  }
}
