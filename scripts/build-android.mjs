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
const release = process.argv.includes('--release');
if (release) {
  for (const name of ['PAIRO_ANDROID_KEYSTORE', 'PAIRO_ANDROID_STORE_PASSWORD', 'PAIRO_ANDROID_KEY_ALIAS', 'PAIRO_ANDROID_KEY_PASSWORD']) {
    if (!process.env[name]) throw new Error('Release signing configuration is missing: ' + name);
  }
  if (!existsSync(process.env.PAIRO_ANDROID_KEYSTORE)) throw new Error('Release keystore does not exist');
}
const command = resolve(androidDir, windows ? 'gradlew.bat' : 'gradlew');
const result = spawnSync(command, [release ? 'assembleRelease' : 'assembleDebug'], { cwd: androidDir, stdio: 'inherit', shell: windows });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  const variant = release ? 'release' : 'debug';
  const apk = resolve(androidDir, 'app', 'build', 'outputs', 'apk', variant, `app-${variant}.apk`);
  if (!existsSync(apk)) throw new Error('Gradle completed but the APK is missing: ' + apk);
  console.log('APK:', apk);
}
