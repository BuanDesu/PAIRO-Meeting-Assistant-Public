import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const androidDir = resolve(root, 'android');
const windows = process.platform === 'win32';
const command = resolve(root, 'node_modules', '.bin', windows ? 'cap.cmd' : 'cap');
const args = existsSync(androidDir) ? ['sync', 'android'] : ['add', 'android'];
console.log('Running Capacitor command:', args.join(' '));
const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: windows });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
