import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyReleaseVersion } from './release-version.mjs';

const root = process.cwd();
const androidDir = resolve(root, 'android');
const windows = process.platform === 'win32';
const command = resolve(root, 'node_modules', '.bin', windows ? 'cap.cmd' : 'cap');
const args = existsSync(androidDir) ? ['sync', 'android'] : ['add', 'android'];
console.log('Running Capacitor command:', args.join(' '));
const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: windows });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  const nativeDir = resolve(androidDir, 'app', 'src', 'main', 'java', 'com', 'pairo', 'meetingcopilot');
  for (const file of ['MainActivity.java', 'ModelStreamPlugin.java']) {
    copyFileSync(resolve(root, 'native', 'android', file), resolve(nativeDir, file));
  }
  const version = verifyReleaseVersion(
    JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')),
    JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')),
    process.env.GITHUB_REF || '',
  );
  writeFileSync(resolve(androidDir, 'pairo-version.json'), JSON.stringify(version));
  const buildPath = resolve(androidDir, 'app', 'build.gradle');
  let build = readFileSync(buildPath, 'utf8');
  const releaseConfig = "apply from: '../../scripts/android-release.gradle'";
  if (!build.includes(releaseConfig)) writeFileSync(buildPath, build + '\n' + releaseConfig + '\n');
  const variablesPath = resolve(androidDir, 'variables.gradle');
  const variables = readFileSync(variablesPath, 'utf8').replace(/minSdkVersion\s*=\s*\d+/, 'minSdkVersion = 26');
  writeFileSync(variablesPath, variables);
  const manifestPath = resolve(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
  let manifest = readFileSync(manifestPath, 'utf8');
  if (!manifest.includes('android.permission.CAMERA')) {
    manifest = manifest.replace('</manifest>', '<uses-permission android:name="android.permission.CAMERA" />\n    <uses-feature android:name="android.hardware.camera" android:required="false" />\n</manifest>');
    writeFileSync(manifestPath, manifest);
  }
}
