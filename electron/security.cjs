function isTrustedUiUrl(value, origin) {
  try { return Boolean(origin) && new URL(value).origin === origin; } catch { return false; }
}

function mediaPermissionKind(permission, details = {}) {
  if (permission === 'display-capture') return 'display';
  if (permission !== 'media' || !Array.isArray(details.mediaTypes)) return 'deny';
  // Electron 44 reports display capture as media with no physical device types.
  if (!details.mediaTypes.length) return 'display';
  if (details.mediaTypes.every(type => type === 'audio')) return 'microphone';
  return 'deny';
}

module.exports = { isTrustedUiUrl, mediaPermissionKind };
