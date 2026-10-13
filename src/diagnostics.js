import { PROTOCOL_VERSION } from './protocol.js';
const choose = (value, allowed, fallback = 'unknown') => allowed.includes(value) ? value : fallback;
const media = stream => {
  const tracks = stream?.getTracks?.() || [];
  return { video: Math.min(10, tracks.filter(track => track.kind === 'video' && track.readyState === 'live').length),
    audio: Math.min(10, tracks.filter(track => track.kind === 'audio' && track.readyState === 'live').length) };
};

// Build from explicit states. Never serialize peers, preferences, errors, tracks or request bodies.
export function connectionDiagnostics({ version, platform, role, peer, localStream, remoteStream, modelPending = 0, now = Date.now() }) {
  const socketState = peer?.signal?.readyState;
  return {
    product: 'PAIRO', schema: 1,
    version: typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : 'unknown',
    protocol: PROTOCOL_VERSION,
    platform: choose(platform, ['web', 'android', 'ios']), role: choose(role, ['desktop', 'mobile']),
    phase: choose(peer?.phase, ['idle', 'connecting', 'waiting', 'connected', 'disconnected', 'reconnecting', 'failed']),
    signaling: Number.isInteger(socketState) && socketState >= 0 && socketState <= 3 ? ['connecting', 'open', 'closing', 'closed'][socketState] : 'none',
    peerConnection: choose(peer?.pc?.connectionState, ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'], 'none'),
    dataChannel: choose(peer?.channel?.readyState, ['connecting', 'open', 'closing', 'closed'], 'none'),
    localMedia: media(localStream), remoteMedia: media(remoteStream),
    pendingModelRequests: Number.isInteger(modelPending) && modelPending >= 0 && modelPending <= 8 ? modelPending : 0,
    generatedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
  };
}
