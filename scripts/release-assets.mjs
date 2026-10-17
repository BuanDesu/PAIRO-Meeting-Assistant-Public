import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyReleaseVersion } from './release-version.mjs';

const { version } = verifyReleaseVersion(JSON.parse(readFileSync('package.json', 'utf8')), JSON.parse(readFileSync('package-lock.json', 'utf8')), process.env.GITHUB_REF || '');
const root = resolve(process.argv[2] || 'artifacts');
const files = [];
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (/\.(exe|apk|zip)$/.test(entry.name)) files.push(path);
  }
}
collect(root);
const expected = [`Pairo-Meeting-Copilot-${version}-android.apk`, `Pairo-Meeting-Copilot-${version}-win-x64.exe`, `Pairo-Meeting-Copilot-${version}-win-x64-folder.zip`].sort();
if (JSON.stringify(files.map(path => basename(path)).sort()) !== JSON.stringify(expected)) throw new Error('Release needs one EXE, APK and directory ZIP with the matching version');
const checksums = files.sort((a, b) => basename(a).localeCompare(basename(b))).map(path => {
  const bytes = readFileSync(path);
  if (bytes.length === 0) throw new Error('Release artifact is empty');
  return createHash('sha256').update(bytes).digest('hex') + '  ' + basename(path);
}).join('\n') + '\n';
writeFileSync(resolve(root, 'SHA256SUMS.txt'), checksums);
writeFileSync(resolve(root, 'RELEASE_NOTES.md'), `## 下载与使用\n\n- Windows 10/11 64 位电脑：下载 \`Pairo-Meeting-Copilot-${version}-win-x64.exe\`，放入可写文件夹后双击启动。单文件版每次启动会解压运行文件。\n- 希望后续打开更快：下载 \`Pairo-Meeting-Copilot-${version}-win-x64-folder.zip\`，完整解压后打开其中的 \`Pairo Meeting Copilot.exe\`。它是可运行程序，设置保存在旁边的 PAIRO-data 文件夹。\n- Android 8 或更高版本手机：下载 \`Pairo-Meeting-Copilot-${version}-android.apk\`，按系统提示允许浏览器安装应用。\n- 电脑与手机连接同一可信 Wi-Fi；详细配对与 AI 配置步骤请参阅 [使用指南](https://github.com/BuanDesu/PAIRO-Meeting-Assistant/blob/v${version}/README.md)。\n\nAPK 使用固定正式签名，后续正式版本可以覆盖安装。此前 v0.1.0 调试包首次迁移可能需要先卸载，请先记录非秘密设置。Windows 程序目前未签名。API Key 仅保存在本次会话内存，截图和问题只在请求 AI 时发送到你配置的服务。\n\n\`SHA256SUMS.txt\` 包含 EXE、目录 ZIP 和 APK 三份文件的校验值。页面底部的 Source code 是源码。\n`);
const changelog = resolve('docs', 'releases', `v${version}.md`);
if (existsSync(changelog)) {
  const notes = resolve(root, 'RELEASE_NOTES.md');
  writeFileSync(notes, readFileSync(changelog, 'utf8').trim() + '\n\n' + readFileSync(notes, 'utf8'));
}
console.log('Release asset names, versions and SHA-256 checksums verified.');
