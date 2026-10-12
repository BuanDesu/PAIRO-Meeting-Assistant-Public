import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export function desktopBuildOptions(pkg, electronZip, projectDir) {
  const builder = require('electron-builder');
  return {
    projectDir,
    targets: builder.createTargets([builder.Platform.WINDOWS], 'dir', 'x64'),
    config: { ...pkg.build, electronDist: electronZip },
  };
}
