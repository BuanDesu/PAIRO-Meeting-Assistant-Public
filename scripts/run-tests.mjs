import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const files = (await readdir(new URL('../test/', import.meta.url))).filter(name => name.endsWith('.test.js')).map(name => 'test/' + name);
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', windowsHide: true });
child.on('exit', code => { process.exitCode = code ?? 1; });
child.on('error', error => { throw error; });
