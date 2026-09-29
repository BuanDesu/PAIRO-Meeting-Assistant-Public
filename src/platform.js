export function defaultRoleForPlatform(platform) {
  return platform === 'android' ? 'mobile' : 'desktop';
}
