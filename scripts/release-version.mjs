import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function androidVersionCode(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error('Release version must be a stable major.minor.patch version');
  const [major, minor, patch] = match.slice(1).map(Number);
  const code = major * 1000000 + minor * 1000 + patch + 1;
  if (minor > 999 || patch > 999 || !Number.isSafeInteger(code) || code > 2100000000) {
    throw new Error('Version exceeds the Android version code range');
  }
  return code;
}

export function verifyReleaseVersion(pkg, lock, ref = '') {
  const code = androidVersionCode(pkg.version);
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    throw new Error('package.json and package-lock.json versions do not match');
  }
  if (ref.startsWith('refs/tags/') && ref !== 'refs/tags/v' + pkg.version) {
    throw new Error('Release tag does not match package.json version');
  }
  return { version: pkg.version, androidVersionCode: code };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyReleaseVersion(
    JSON.parse(readFileSync('package.json', 'utf8')),
    JSON.parse(readFileSync('package-lock.json', 'utf8')),
    process.env.GITHUB_REF || '',
  );
  console.log(JSON.stringify(result));
}
