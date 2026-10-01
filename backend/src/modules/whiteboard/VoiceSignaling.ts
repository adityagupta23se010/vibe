import {Server} from 'socket.io';
import {VoiceRegistry} from './VoiceRegistry.js';
import {displayName, RoomCapability, RoomSocket} from './WhiteboardGateway.js';

const MAX_SIGNAL_BYTES = 20_000;

const isSdp = (value: any) =>
  !!value &&
  (value.type === 'offer' || value.type === 'answer') &&
  typeof value.sdp === 'string' &&
  value.sdp.length < MAX_SIGNAL_BYTES;
const isCandidate = (value: any) =>
  !!value && typeof value === 'object' && JSON.stringify(value).length < 4_000;

/**
 * WebRTC signaling only — audio never touches the server. Identity, room
 * membership and voice permissions all come from socket.data, which the
 * WhiteboardGateway sets from persisted room state after authorizing the
 * user, so nothing here trusts the client.
 *
 * Mesh caveat: with peer-to-peer audio the server cannot physically stop a
 * modified client from sending sound. Enforcement is therefore layered —
 * the server refuses joins/unmutes and evicts revoked users (which makes
 * honest peers close those connections), and every client also refuses to
 * play audio from anyone the server marks as force-muted. An SFU transport
 * would make this enforcement server-side.
 */
export class VoiceSignaling implements RoomCapability {
  readonly registry = new VoiceRegistry();

  constructor(private readonly io: Server) {
    io.on('connection', socket => this.bind(socket as RoomSocket));
  }

  private bind(socket: RoomSocket) {
    const room = () => socket.data.roomCode;
    // Voice is valid only for the room the socket is currently authorized in.
    const active = () => {
      const roomCode = room();
      return roomCode && this.registry.roomOf(socket.id) === roomCode
        ? roomCode
        : undefined;
    };

    // Clients may emit with or without a payload; the ack is always the last arg.
    socket.on('voice:join', (...args: unknown[]) => {
      const last = args[args.length - 1];
      const ack =
        typeof last === 'function'
          ? (last as (response: unknown) => void)
          : undefined;
      const roomCode = room();
      const access = socket.data.access;
      if (!roomCode || !socket.data.user || !access)
        return ack?.({ok: false, error: 'Join the room first'});
      if (!access.canJoinVoice)
        return ack?.({
          ok: false,
          error: 'The room owner has not allowed you to use voice.',
        });
      const forced = !access.canSpeak;
      const muted = forced || access.joinMuted;
      const {evicted, peers} = this.registry.join(
        roomCode,
        {
          socketId: socket.id,
          userId: socket.data.user._id.toString(),
          name: displayName(socket.data.user),
        },
        {muted, forced},
      );
      if (evicted) this.io.to(evicted).emit('voice:replaced');
      // Broadcast before acking so every client (joiner included) already
      // holds the updated list when the joiner starts negotiating.
      this.broadcast(roomCode);
      ack?.({ok: true, peers, muted, forced});
    });

    socket.on('voice:leave', () => this.drop(socket));

    // Lets anyone in the room (in voice or not) learn who is already talking
    // when they arrive — broadcasts only fire on changes.
    socket.on('voice:sync', () => {
      const roomCode = room();
      if (roomCode)
        socket.emit('voice:participants', this.registry.list(roomCode));
    });

    socket.on('voice:state', payload => {
      const roomCode = active();
      const muted = payload?.muted;
      if (!roomCode || typeof muted !== 'boolean') return;
      // A force-muted participant cannot unmute themselves; re-send the
      // authoritative list so a tampered client is corrected.
      if (!muted && this.registry.get(socket.id)?.forced) {
        socket.emit('voice:participants', this.registry.list(roomCode));
        return;
      }
      this.registry.setMuted(socket.id, muted);
      this.broadcast(roomCode);
    });

    const relay = (
      event: 'voice:offer' | 'voice:answer' | 'voice:ice-candidate',
      key: 'sdp' | 'candidate',
      valid: (value: any) => boolean,
    ) =>
      socket.on(event, payload => {
        const to = payload?.to;
        if (!active() || typeof to !== 'string' || !valid(payload[key])) return;
        // Both ends must be in this room's voice set — no cross-room relay.
        if (!this.registry.sameRoom(socket.id, to)) return;
        this.io.to(to).emit(event, {from: socket.id, [key]: payload[key]});
      });
    relay('voice:offer', 'sdp', isSdp);
    relay('voice:answer', 'sdp', isSdp);
    relay('voice:ice-candidate', 'candidate', isCandidate);

    socket.on('disconnect', () => this.drop(socket));
  }

  // ---- RoomCapability ----

  onRoomLeave(socket: RoomSocket) {
    this.drop(socket);
  }

  /** Applies new permissions to anyone currently in voice: revoke, force-mute or release. */
  onAccessChanged(roomCode: string, sockets: RoomSocket[]) {
    let changed = false;
    for (const s of sockets) {
      const participant = this.registry.get(s.id);
      if (!participant || !s.data.access) continue;
      if (!s.data.access.canJoinVoice) {
        this.registry.leave(s.id);
        s.emit('voice:revoked', {
          message: 'The room owner turned off voice for you.',
        });
        changed = true;
        continue;
      }
      const forced = !s.data.access.canSpeak;
      if (forced !== participant.forced) {
        this.registry.setForced(s.id, forced);
        changed = true;
      }
    }
    if (changed) this.broadcast(roomCode);
  }

  private drop(socket: RoomSocket) {
    const roomCode = this.registry.leave(socket.id);
    if (roomCode) this.broadcast(roomCode);
  }

  private broadcast(roomCode: string) {
    this.io
      .to(roomCode)
      .emit('voice:participants', this.registry.list(roomCode));
  }
}
