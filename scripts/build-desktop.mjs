import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { desktopBuildOptions } from './desktop-config.mjs';

const require = createRequire(import.meta.url);
const electronBuilder = require('electron-builder');
const root = process.cwd();
if (process.platform !== 'win32') throw new Error('The portable EXE target must be built on Windows.');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const electronVersion = require('electron/package.json').version;
const cacheRoot = process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'PairoMeetingCopilot', 'Cache') : resolve(root, '.electron-cache');
const electronZip = process.env.ELECTRON_DIST || resolve(cacheRoot, 'electron-v' + electronVersion + '-win32-x64.zip');
if (!process.env.ELECTRON_DIST) {
  const fetcher = resolve(root, 'scripts', 'fetch-electron.ps1');
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fetcher, '-Version', electronVersion, '-DestinationRoot', cacheRoot], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
} else if (!existsSync(electronZip)) {
  throw new Error('ELECTRON_DIST does not exist: ' + electronZip);
}
if (!existsSync(electronZip)) throw new Error('Verified Electron ZIP is missing: ' + electronZip);
const nsisHome = process.env.NSIS_HOME || resolve(process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || 'C:\Program Files (x86)', 'NSIS');
const makensis = resolve(nsisHome, 'makensis.exe');
if (!existsSync(makensis) || !existsSync(resolve(nsisHome, 'Plugins'))) throw new Error('NSIS 3.x was not found. Install NSIS or set NSIS_HOME.');

const built = await electronBuilder.build(desktopBuildOptions(pkg, electronZip, root));
console.log('Unpacked Electron app:', Array.isArray(built) ? built.join(', ') : 'created');

const outputDir = resolve(root, pkg.build.directories?.output || 'release');
const appDir = resolve(outputDir, 'win-unpacked');
const appExe = pkg.build.productName + '.exe';
if (!existsSync(resolve(appDir, appExe))) throw new Error('Unpacked Electron app is missing: ' + resolve(appDir, appExe));
mkdirSync(outputDir, { recursive: true });
const outputFile = resolve(outputDir, 'Pairo-Meeting-Copilot-' + pkg.version + '-win-x64.exe');
const template = readFileSync(resolve(root, 'scripts', 'portable.nsi'), 'utf8');
const portableScript = template
  .replaceAll('@APP_NAME@', pkg.build.productName)
  .replaceAll('@APP_VERSION@', pkg.version)
  .replaceAll('@APP_DIR@', appDir)
  .replaceAll('@APP_EXE@', appExe)
  .replaceAll('@OUT_FILE@', outputFile);
const scriptFile = resolve(outputDir, 'portable-build.nsi');
writeFileSync(scriptFile, portableScript, 'utf8');
const nsisResult = spawnSync(makensis, ['/V2', scriptFile], { cwd: root, stdio: 'inherit', env: { ...process.env, NSISDIR: nsisHome } });
if (nsisResult.error) throw nsisResult.error;
if (nsisResult.status !== 0) process.exit(nsisResult.status ?? 1);
if (!existsSync(outputFile)) throw new Error('NSIS completed but the portable EXE is missing: ' + outputFile);
console.log('Portable EXE:', outputFile);
const directoryZip = resolve(outputDir, 'Pairo-Meeting-Copilot-' + pkg.version + '-win-x64-folder.zip');
const zipResult = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'scripts', 'package-directory.ps1'), '-SourceDirectory', appDir, '-Destination', directoryZip], { cwd: root, stdio: 'inherit' });
if (zipResult.error) throw zipResult.error;
if (zipResult.status !== 0) process.exit(zipResult.status ?? 1);
if (!existsSync(directoryZip)) throw new Error('Directory ZIP was not created');
console.log('Directory ZIP:', directoryZip);
