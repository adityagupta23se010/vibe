const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * ICE servers come from VITE_WEBRTC_ICE_SERVERS (a JSON RTCIceServer[]), so
 * TURN can be configured per deployment. STUN alone is fine for local
 * development but fails behind symmetric NAT / strict firewalls — production
 * should list a TURN server, e.g.
 *   [{"urls":"stun:stun.example.org"},{"urls":"turn:turn.example.org:3478","username":"u","credential":"p"}]
 */
export function parseIceServers(raw: string | undefined): RTCIceServer[] {
  if (!raw?.trim()) return DEFAULT_ICE_SERVERS;
  try {
    const parsed = JSON.parse(raw);
    const valid = Array.isArray(parsed) && parsed.every(s => s && (typeof s.urls === 'string' || Array.isArray(s.urls)));
    if (valid && parsed.length) return parsed;
  } catch {
    /* fall through */
  }
  console.warn('Ignoring invalid VITE_WEBRTC_ICE_SERVERS; using default STUN server.');
  return DEFAULT_ICE_SERVERS;
}

export const iceServers = () => parseIceServers(import.meta.env.VITE_WEBRTC_ICE_SERVERS);
