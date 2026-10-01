/** A participant's live voice session, as broadcast by the server (ephemeral, never persisted). */
export type VoicePeerInfo = {
  socketId: string; userId: string; name: string; muted: boolean;
  /** Muted by the room owner; the participant cannot unmute, and peers refuse to play their audio. */
  forced: boolean;
};

/** User-facing voice lifecycle. 'idle' means the user has not joined voice. */
export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type VoiceErrorKind = 'permission-denied' | 'no-device' | 'device-busy' | 'device-lost' | 'unsupported' | 'replaced' | 'not-allowed' | 'failed';
export type VoiceError = { kind: VoiceErrorKind; message: string };

export type PeerState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

// Mirrors Socket.IO's own listener type; each handler validates its payload.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => void;

/** The subset of a Socket.IO client the voice layer needs — keeps it testable and transport-agnostic. */
export interface SignalingChannel {
  readonly connected: boolean;
  readonly id?: string;
  emit(event: string, payload?: unknown): unknown;
  on(event: string, handler: Handler): unknown;
  off(event: string, handler: Handler): unknown;
  timeout(ms: number): { emitWithAck(event: string, payload?: unknown): Promise<unknown> };
}

/**
 * Media transport boundary. The mesh implementation connects every pair of
 * participants directly; an SFU implementation would publish one upstream and
 * subscribe to the server's downstreams, behind this same interface — so the
 * session, hook and UI do not change when the topology does.
 */
export interface VoiceTransport {
  /** Start sending `local` to the current voice peers (the joiner initiates). */
  start(local: MediaStream, peers: VoicePeerInfo[]): void;
  /** Reconcile with the server's authoritative list (drops peers that left). */
  sync(peers: VoicePeerInfo[]): void;
  close(): void;
  /** Underlying connections, for development diagnostics (optional for other transports). */
  connections?(): ReadonlyMap<string, RTCPeerConnection>;
}

export type TransportEvents = {
  onRemoteStream: (socketId: string, stream: MediaStream | null) => void;
  onPeerState: (socketId: string, state: PeerState | null) => void;
};
