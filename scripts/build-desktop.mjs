import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
if (process.platform !== 'win32') throw new Error('The portable EXE target must be built on Windows.');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const programFilesX86 = process.env['ProgramFiles(x86)'] || process.env.ProgramFiles || 'C:\Program Files (x86)';
const nsisHome = process.env.NSIS_HOME || resolve(programFilesX86, 'NSIS');
const makensis = resolve(nsisHome, 'makensis.exe');
if (!existsSync(makensis) || !existsSync(resolve(nsisHome, 'Plugins'))) {
  throw new Error('NSIS 3.x was not found. Install NSIS or set NSIS_HOME.');
}
const builder = resolve(root, 'node_modules', '.bin', 'electron-builder.cmd');
const builderResult = spawnSync(builder, ['--dir', '--win', '--x64'], { cwd: root, stdio: 'inherit', shell: true });
if (builderResult.error) throw builderResult.error;
if (builderResult.status !== 0) process.exit(builderResult.status ?? 1);

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
