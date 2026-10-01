import { buildAudioConstraints } from './constraints';
import { VoiceDiagnostics } from './diagnostics';
import { iceServers } from './iceServers';
import { MeshTransport } from './MeshTransport';
import { SpeakingDetector } from './SpeakingDetector';
import type { PeerState, SignalingChannel, VoiceError, VoicePeerInfo, VoiceStatus, VoiceTransport, TransportEvents } from './types';

export const LOCAL_ID = 'local';
const ACK_TIMEOUT_MS = 5000;

export type VoiceSnapshot = {
  status: VoiceStatus;
  error?: VoiceError;
  muted: boolean;
  /** Everyone currently in voice in this room (server-authoritative), including self. */
  participants: VoicePeerInfo[];
  /** Remote audio keyed by the remote socket id. */
  remoteStreams: ReadonlyMap<string, MediaStream>;
  /** Ids (LOCAL_ID or remote socket id) whose audio is currently above the speaking threshold. */
  speaking: ReadonlySet<string>;
  selfSocketId?: string;
  /** Short, non-error status for the user ("You joined muted."). */
  notice?: string;
  /** Mirrors of the server-computed permissions for this user. */
  canJoin: boolean;
  canSpeak: boolean;
};

/** The voice-relevant part of the server's per-user access. */
export type VoiceAccess = { canJoinVoice: boolean; canSpeak: boolean };

export const MESSAGES = {
  forcedMute: 'You have been muted by the room owner.',
  allowedToSpeak: 'The room owner allowed you to speak. Unmute when you are ready.',
  joinedMuted: 'You joined muted.',
  joinedForced: 'You joined muted. The room owner will let you speak.',
  notAllowed: 'The room owner has not allowed you to use voice.',
  voiceAllowed: 'The room owner allowed you to use voice.',
};

export type VoiceSessionDeps = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createTransport?: (signaling: SignalingChannel, events: TransportEvents) => VoiceTransport;
  createDetector?: (onChange: (id: string, speaking: boolean) => void) => Pick<SpeakingDetector, 'add' | 'remove' | 'dispose'>;
  supported?: () => boolean;
  /** Development diagnostics (getStats polling); defaults to on only under `vite dev`. */
  diagnostics?: boolean;
};

type Phase = 'idle' | 'acquiring' | 'joining' | 'joined' | 'awaiting-room' | 'failed';

export function describeMediaError(error: unknown): VoiceError {
  const name = (error as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return { kind: 'permission-denied', message: 'Microphone permission is required to join voice.' };
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError')
    return { kind: 'no-device', message: 'No microphone was found. Connect one and try again.' };
  if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError')
    return { kind: 'device-busy', message: 'Your microphone is unavailable — another application may be using it.' };
  return { kind: 'failed', message: 'Could not start voice. Please try again.' };
}

const browserSupportsVoice = () =>
  typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof RTCPeerConnection !== 'undefined';

/**
 * Voice lifecycle for one collaboration room, independent of React and of the
 * whiteboard. It shares the room's authenticated socket for signaling only.
 *
 * Joining is always explicit (the mic is never requested on page load), and
 * leaving or losing voice never affects board membership.
 */
export class VoiceSession {
  private phase: Phase = 'idle';
  private roomReady = false;
  private muted = false;
  private error?: VoiceError;
  private local: MediaStream | null = null;
  private transport: VoiceTransport | null = null;
  private participants: VoicePeerInfo[] = [];
  private remoteStreams = new Map<string, MediaStream>();
  private peerStates = new Map<string, PeerState>();
  private speaking = new Set<string>();
  private detector: Pick<SpeakingDetector, 'add' | 'remove' | 'dispose'>;
  private listeners = new Set<() => void>();
  private snapshot: VoiceSnapshot;
  private disposed = false;
  private joinAttempt = 0;
  private announceSeq = 0;
  private notice?: string;
  // Permissive until the server says otherwise; the server enforces regardless.
  private access: VoiceAccess = { canJoinVoice: true, canSpeak: true };

  constructor(private readonly signaling: SignalingChannel, private readonly deps: VoiceSessionDeps = {}) {
    this.detector = (deps.createDetector ?? (cb => new SpeakingDetector(cb)))((id, speaking) => {
      if (speaking) this.speaking.add(id);
      else this.speaking.delete(id);
      this.emit();
    });
    signaling.on('voice:participants', this.onParticipants);
    signaling.on('voice:replaced', this.onReplaced);
    signaling.on('voice:revoked', this.onRevoked);
    this.snapshot = this.buildSnapshot();
  }

  // ---- external store API (useSyncExternalStore) ----
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;

  get supported() {
    return (this.deps.supported ?? browserSupportsVoice)();
  }

  /** Called whenever the board's room membership changes (initial join, socket drop, reconnect). */
  setRoomReady(ready: boolean) {
    if (this.roomReady === ready) return;
    this.roomReady = ready;
    // The server drops voice membership whenever the socket leaves the room, so
    // after any outage we re-announce; existing peer connections keep carrying
    // audio meanwhile, which is why the transport is not torn down here.
    if (!ready && (this.phase === 'joined' || this.phase === 'joining')) this.phase = 'awaiting-room';
    if (!ready) this.participants = [];
    // Fetch who is already in voice so the participant list is right even before we join.
    if (ready) this.signaling.emit('voice:sync');
    if (ready && this.phase === 'awaiting-room') void this.announce();
    this.emit();
  }

  /**
   * Applies the server-pushed permissions. Enforcement lives on the server;
   * this keeps the local mic and UI consistent with it immediately.
   */
  setAccess(next: VoiceAccess) {
    const prev = this.access;
    this.access = next;
    const inVoice = this.phase !== 'idle' && this.phase !== 'failed';
    if (!next.canJoinVoice && inVoice) {
      this.revoke(MESSAGES.notAllowed);
      return;
    }
    // Voice re-allowed: drop the stale "not allowed" error so Join is offered plainly.
    if (next.canJoinVoice && !prev.canJoinVoice && this.error?.kind === 'not-allowed') {
      this.error = undefined;
      this.notice = MESSAGES.voiceAllowed;
    }
    if (inVoice && prev.canSpeak !== next.canSpeak) {
      if (!next.canSpeak) {
        this.applyMute(true);
        this.notice = MESSAGES.forcedMute;
      } else {
        this.notice = MESSAGES.allowedToSpeak;
      }
    }
    this.emit();
  }

  async join() {
    if (this.disposed || this.phase !== 'idle' && this.phase !== 'failed') return;
    this.error = undefined;
    this.notice = undefined;
    if (!this.access.canJoinVoice) {
      this.error = { kind: 'not-allowed', message: MESSAGES.notAllowed };
      this.emit();
      return;
    }
    if (!this.supported) {
      this.error = { kind: 'unsupported', message: 'Voice chat is not supported in this browser (a secure https connection is required).' };
      this.emit();
      return;
    }
    this.phase = 'acquiring';
    this.emit();
    const attempt = ++this.joinAttempt;
    try {
      const getUserMedia = this.deps.getUserMedia ?? (c => navigator.mediaDevices.getUserMedia(c));
      const stream = await getUserMedia(buildAudioConstraints());
      if (attempt !== this.joinAttempt || this.disposed) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      this.local = stream;
      this.muted = false;
      this.detector.add(LOCAL_ID, stream);
      // Headset unplugged / device revoked: the track ends on its own and the
      // call would otherwise silently carry nothing.
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', this.onLocalTrackEnded));
    } catch (error) {
      if (attempt !== this.joinAttempt) return;
      this.phase = 'idle';
      this.error = describeMediaError(error);
      this.emit();
      return;
    }
    if (this.roomReady) await this.announce();
    else {
      this.phase = 'awaiting-room';
      this.emit();
    }
  }

  leave() {
    if (this.phase === 'idle') return;
    this.joinAttempt++;
    const wasAnnounced = this.phase === 'joined' || this.phase === 'joining';
    this.teardown();
    if (wasAnnounced && this.signaling.connected) this.signaling.emit('voice:leave');
    this.phase = 'idle';
    this.error = undefined;
    this.notice = undefined;
    this.emit();
  }

  setMuted(muted: boolean) {
    if (!this.local) return;
    if (!muted && !this.access.canSpeak) {
      // Forced mute: only the owner can lift it.
      this.notice = MESSAGES.forcedMute;
      this.emit();
      return;
    }
    this.notice = undefined;
    this.applyMute(muted);
    this.emit(); // local UI updates immediately; the server echo is for everyone else
    if (this.phase === 'joined') this.signaling.emit('voice:state', { muted });
  }

  /** Disable rather than remove the track: peers stay connected, no renegotiation. */
  private applyMute(muted: boolean) {
    this.muted = muted;
    this.local?.getAudioTracks().forEach(track => (track.enabled = !muted));
  }

  toggleMute() {
    this.setMuted(!this.muted);
  }

  dispose() {
    if (this.disposed) return;
    this.leave();
    this.disposed = true;
    this.signaling.off('voice:participants', this.onParticipants);
    this.signaling.off('voice:replaced', this.onReplaced);
    this.signaling.off('voice:revoked', this.onRevoked);
    this.detector.dispose();
    this.listeners.clear();
  }

  // ---- internals ----
  private async announce() {
    if (!this.local) return;
    const attempt = this.joinAttempt;
    const seq = ++this.announceSeq;
    this.phase = 'joining';
    this.emit();
    const rejoin = !!this.transport;
    let ack: { ok: boolean; error?: string; peers?: VoicePeerInfo[]; muted?: boolean; forced?: boolean } | undefined;
    try {
      ack = (await this.signaling.timeout(ACK_TIMEOUT_MS).emitWithAck('voice:join')) as typeof ack;
    } catch {
      ack = undefined;
    }
    if (attempt !== this.joinAttempt || seq !== this.announceSeq || this.disposed || this.phase !== 'joining') return;
    if (!ack?.ok) {
      // A socket drop mid-join is retried when the room is back; anything else is a hard failure.
      if (!this.roomReady) {
        this.phase = 'awaiting-room';
      } else if (ack?.error) {
        // The server refused (e.g. voice not allowed) — not a connectivity problem.
        this.teardown();
        this.phase = 'idle';
        this.error = { kind: 'not-allowed', message: ack.error };
      } else {
        this.teardown();
        this.phase = 'failed';
        this.error = { kind: 'failed', message: 'Could not connect to voice. Please try again.' };
      }
      this.emit();
      return;
    }
    // The server decides the starting mic state (room "join muted" policy or a
    // forced mute); apply it before any media can flow. On a reconnect, keep
    // what the user had unless the owner has forced a mute.
    const serverMuted = !!ack.muted;
    const wantMuted = ack.forced ? true : rejoin ? this.muted : serverMuted;
    this.applyMute(wantMuted);
    // Fresh transport per announcement: after a reconnect our socket id changed,
    // so every peer must be renegotiated against the new identity.
    this.transport?.close();
    this.transport = this.createTransport();
    this.transport.start(this.local, ack.peers ?? []);
    this.phase = 'joined';
    this.startDiagnostics();
    if (wantMuted !== serverMuted) this.signaling.emit('voice:state', { muted: wantMuted });
    if (!rejoin && ack.forced) this.notice = MESSAGES.joinedForced;
    else if (!rejoin && serverMuted) this.notice = MESSAGES.joinedMuted;
    this.emit();
  }

  private createTransport(): VoiceTransport {
    const events: TransportEvents = {
      onRemoteStream: (socketId, stream) => {
        if (stream) {
          this.remoteStreams.set(socketId, stream);
          this.detector.add(socketId, stream);
        } else if (this.remoteStreams.delete(socketId)) {
          this.detector.remove(socketId);
        }
        this.emit();
      },
      onPeerState: (socketId, state) => {
        if (state) this.peerStates.set(socketId, state);
        else this.peerStates.delete(socketId);
        this.emit();
      },
    };
    if (this.deps.createTransport) return this.deps.createTransport(this.signaling, events);
    return new MeshTransport(this.signaling, iceServers(), events);
  }

  private diagnostics?: VoiceDiagnostics;
  private startDiagnostics() {
    if (!(this.deps.diagnostics ?? import.meta.env.DEV)) return;
    this.diagnostics ??= new VoiceDiagnostics({
      connections: () => this.transport?.connections?.() ?? new Map(),
      voicePeers: () => this.participants.filter(p => p.socketId !== this.signaling.id).length,
      remoteStreams: () => this.remoteStreams.size,
    });
    this.diagnostics.start();
  }

  private onLocalTrackEnded = () => {
    if (!this.local) return;
    this.leave();
    this.error = { kind: 'device-lost', message: 'Your microphone was disconnected. Check it and join voice again.' };
    this.emit();
  };

  private teardown() {
    this.diagnostics?.stop();
    this.transport?.close();
    this.transport = null;
    for (const id of [...this.remoteStreams.keys()]) this.detector.remove(id);
    this.remoteStreams.clear();
    this.peerStates.clear();
    this.detector.remove(LOCAL_ID);
    this.local?.getTracks().forEach(track => {
      track.removeEventListener('ended', this.onLocalTrackEnded);
      track.stop();
    });
    this.local = null;
    this.muted = false;
  }

  private onParticipants = (list: VoicePeerInfo[]) => {
    this.participants = Array.isArray(list) ? list : [];
    if (this.phase === 'joined') this.transport?.sync(this.participants.filter(p => p.socketId !== this.signaling.id));
    this.emit();
  };

  private onRevoked = (payload?: { message?: string }) => this.revoke(payload?.message || MESSAGES.notAllowed);

  /** Leave voice because the owner disallowed it; the user stays in the room. */
  private revoke(message: string) {
    if (this.phase === 'idle' && !this.local) return;
    this.joinAttempt++;
    this.teardown();
    this.phase = 'idle';
    this.notice = undefined;
    this.error = { kind: 'not-allowed', message };
    this.emit();
  }

  private onReplaced = () => {
    this.joinAttempt++;
    this.teardown();
    this.phase = 'idle';
    this.error = { kind: 'replaced', message: 'Voice was opened in another tab or window.' };
    this.emit();
  };

  private status(): VoiceStatus {
    switch (this.phase) {
      case 'idle':
        return 'idle';
      case 'failed':
        return 'disconnected';
      case 'acquiring':
      case 'joining':
        return this.transport ? 'reconnecting' : 'connecting';
      case 'awaiting-room':
        return this.transport ? 'reconnecting' : 'connecting';
      case 'joined': {
        const states = [...this.peerStates.values()];
        return states.some(s => s === 'reconnecting' || s === 'failed') ? 'reconnecting' : 'connected';
      }
    }
  }

  private buildSnapshot(): VoiceSnapshot {
    return {
      status: this.status(),
      error: this.error,
      muted: this.muted,
      participants: this.participants,
      remoteStreams: new Map(this.remoteStreams),
      speaking: new Set(this.speaking),
      selfSocketId: this.signaling.id,
      notice: this.notice,
      canJoin: this.access.canJoinVoice,
      canSpeak: this.access.canSpeak,
    };
  }

  private emit() {
    if (this.disposed) return;
    this.snapshot = this.buildSnapshot();
    this.listeners.forEach(listener => listener());
  }
}

