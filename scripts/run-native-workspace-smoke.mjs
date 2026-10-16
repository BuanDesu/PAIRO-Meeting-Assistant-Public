import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.platform !== 'win32') throw new Error('Native workspace validation requires Windows x64.');
if (!process.argv.includes('--text-only')) {
  const fixture = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./prepare-speech-qa.ps1', import.meta.url))], { stdio: 'inherit', windowsHide: true });
  if (fixture.error) throw fixture.error;
  if (fixture.status !== 0) process.exit(fixture.status ?? 1);
}
const child = spawn(require('electron'), [fileURLToPath(new URL('./smoke-native-workspace.cjs', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true, env });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
