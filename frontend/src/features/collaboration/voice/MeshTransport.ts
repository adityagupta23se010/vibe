import type { PeerState, SignalingChannel, TransportEvents, VoicePeerInfo, VoiceTransport } from './types';

type Peer = {
  pc: RTCPeerConnection;
  /** The one stream played for this peer; reused if ontrack fires again (renegotiation). */
  stream?: MediaStream;
  initiator: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  restartTimer?: ReturnType<typeof setTimeout>;
};

const RESTART_DELAY_MS = 3000;

/**
 * Full-mesh WebRTC audio: one RTCPeerConnection per remote participant.
 * Suitable for the 2–6 person rooms this LMS targets; upstream bandwidth grows
 * linearly with room size, which is why media sits behind VoiceTransport.
 *
 * Glare-free by construction: the joiner always offers to existing peers, and
 * only the original offerer performs ICE restarts.
 */
export class MeshTransport implements VoiceTransport {
  private peers = new Map<string, Peer>();
  private local: MediaStream | null = null;
  private closed = false;

  constructor(
    private readonly signaling: SignalingChannel,
    private readonly iceServers: RTCIceServer[],
    private readonly events: TransportEvents,
    private readonly PeerConnection: typeof RTCPeerConnection = globalThis.RTCPeerConnection,
  ) {
    signaling.on('voice:offer', this.handleOffer);
    signaling.on('voice:answer', this.handleAnswer);
    signaling.on('voice:ice-candidate', this.handleCandidate);
  }

  start(local: MediaStream, peers: VoicePeerInfo[]) {
    this.local = local;
    for (const peer of peers) void this.offer(peer.socketId);
  }

  sync(peers: VoicePeerInfo[]) {
    const present = new Set(peers.map(p => p.socketId));
    for (const socketId of [...this.peers.keys()]) if (!present.has(socketId)) this.drop(socketId);
  }

  close() {
    this.closed = true;
    this.signaling.off('voice:offer', this.handleOffer);
    this.signaling.off('voice:answer', this.handleAnswer);
    this.signaling.off('voice:ice-candidate', this.handleCandidate);
    for (const socketId of [...this.peers.keys()]) this.drop(socketId);
    this.local = null;
  }

  peerCount() {
    return this.peers.size;
  }

  /** Live peer connections by remote socket id — for development diagnostics only. */
  connections(): ReadonlyMap<string, RTCPeerConnection> {
    return new Map([...this.peers].map(([id, peer]) => [id, peer.pc]));
  }

  private create(socketId: string, initiator: boolean): Peer {
    this.drop(socketId);
    const pc = new this.PeerConnection({ iceServers: this.iceServers });
    const peer: Peer = { pc, initiator, pendingCandidates: [] };
    this.peers.set(socketId, peer);
    this.local?.getAudioTracks().forEach(track => pc.addTrack(track, this.local!));

    pc.onicecandidate = e => {
      if (e.candidate) this.signaling.emit('voice:ice-candidate', { to: socketId, candidate: e.candidate.toJSON() });
    };
    pc.ontrack = e => {
      // Keep one stable stream per peer so the <audio> element is never
      // re-attached (or doubled) when the browser re-fires ontrack.
      const stream = e.streams[0] ?? peer.stream ?? new MediaStream();
      if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
      if (stream === peer.stream) return;
      peer.stream = stream;
      this.events.onRemoteStream(socketId, stream);
    };
    pc.onconnectionstatechange = () => this.onConnectionState(socketId, peer);
    this.events.onPeerState(socketId, 'connecting');
    return peer;
  }

  private onConnectionState(socketId: string, peer: Peer) {
    if (this.peers.get(socketId) !== peer) return;
    const state = peer.pc.connectionState;
    const mapped: PeerState =
      state === 'connected' ? 'connected' : state === 'failed' ? 'failed' : state === 'disconnected' ? 'reconnecting' : 'connecting';
    this.events.onPeerState(socketId, mapped);
    clearTimeout(peer.restartTimer);
    if (state === 'failed' && peer.initiator) void this.offer(socketId, true);
    // 'disconnected' often self-heals; restart ICE only if it persists.
    if (state === 'disconnected' && peer.initiator) {
      peer.restartTimer = setTimeout(() => {
        if (this.peers.get(socketId) === peer && peer.pc.connectionState !== 'connected') void this.offer(socketId, true);
      }, RESTART_DELAY_MS);
    }
  }

  private async offer(socketId: string, iceRestart = false) {
    try {
      const peer = iceRestart && this.peers.get(socketId) ? this.peers.get(socketId)! : this.create(socketId, true);
      const offer = await peer.pc.createOffer({ iceRestart });
      if (this.closed || this.peers.get(socketId) !== peer) return;
      await peer.pc.setLocalDescription(offer);
      this.signaling.emit('voice:offer', { to: socketId, sdp: { type: offer.type, sdp: offer.sdp } });
    } catch (error) {
      console.warn('Voice: offer failed', error);
      this.events.onPeerState(socketId, 'failed');
    }
  }

  private handleOffer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
    if (this.closed || !this.local) return;
    try {
      // An offer for an existing answerer-side peer is an ICE restart; reuse it.
      const existing = this.peers.get(from);
      const peer = existing && !existing.initiator ? existing : this.create(from, false);
      await peer.pc.setRemoteDescription(sdp);
      await this.flushCandidates(peer);
      const answer = await peer.pc.createAnswer();
      if (this.closed || this.peers.get(from) !== peer) return;
      await peer.pc.setLocalDescription(answer);
      this.signaling.emit('voice:answer', { to: from, sdp: { type: answer.type, sdp: answer.sdp } });
    } catch (error) {
      console.warn('Voice: answering failed', error);
      this.events.onPeerState(from, 'failed');
    }
  };

  private handleAnswer = async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
    const peer = this.peers.get(from);
    if (!peer || peer.pc.signalingState !== 'have-local-offer') return;
    try {
      await peer.pc.setRemoteDescription(sdp);
      await this.flushCandidates(peer);
    } catch (error) {
      console.warn('Voice: applying answer failed', error);
    }
  };

  private handleCandidate = async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
    const peer = this.peers.get(from);
    if (!peer) return;
    // Candidates can outrun the description they belong to; buffer until it lands.
    if (!peer.pc.remoteDescription) {
      peer.pendingCandidates.push(candidate);
      return;
    }
    await peer.pc.addIceCandidate(candidate).catch(() => undefined);
  };

  private async flushCandidates(peer: Peer) {
    const queued = peer.pendingCandidates.splice(0);
    for (const candidate of queued) await peer.pc.addIceCandidate(candidate).catch(() => undefined);
  }

  private drop(socketId: string) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    clearTimeout(peer.restartTimer);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.peers.delete(socketId);
    this.events.onRemoteStream(socketId, null);
    this.events.onPeerState(socketId, null);
  }
}
