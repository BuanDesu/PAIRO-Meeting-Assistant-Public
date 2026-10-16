import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.platform !== 'win32') throw new Error('Windows is required for the generated browser input fixture.');
const child = spawn(require('electron'), [fileURLToPath(new URL('./smoke-text-browser.cjs', import.meta.url))], { stdio: 'inherit', windowsHide: true, env });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
