import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const androidDir = resolve(root, 'android');
if (!existsSync(androidDir)) {
  console.error('Android platform is not initialized. Run: npx cap add android');
  process.exit(1);
}
const windows = process.platform === 'win32';
const command = resolve(androidDir, windows ? 'gradlew.bat' : 'gradlew');
const result = spawnSync(command, ['assembleDebug'], { cwd: androidDir, stdio: 'inherit', shell: windows });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  const apk = resolve(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!existsSync(apk)) throw new Error('Gradle completed but the APK is missing: ' + apk);
  console.log('APK:', apk);
}
