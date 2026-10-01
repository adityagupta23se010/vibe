import {Server, Socket} from 'socket.io';
import {IAuthService} from '#auth/interfaces/IAuthService.js';
import {computeAccess} from './access.js';
import {serializeSession, WhiteboardService} from './WhiteboardService.js';
import type {RoomAccess} from './types.js';

export type RoomSocket = Socket & {
  data: {user?: any; roomCode?: string; access?: RoomAccess};
};

/**
 * A realtime capability living inside a collaboration room (voice today;
 * video, chat, hand-raise later). The gateway owns room membership and
 * access; capabilities are told when either changes so they can enforce it
 * on their own runtime state without the gateway knowing their internals.
 */
export interface RoomCapability {
  /** The socket left the room (navigated away, disconnected or was removed). */
  onRoomLeave(socket: RoomSocket): void;
  /** socket.data.access was recomputed for these sockets of `roomCode`. */
  onAccessChanged(roomCode: string, sockets: RoomSocket[]): void;
}

type Ack = (response: {ok: boolean; error?: string}) => void;

/** One display name for a participant across presence, cursors and voice. */
export const displayName = (user: any): string =>
  [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim() ||
  user?.name ||
  user?.email ||
  'Participant';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Request failed';

/** Socket.IO passes the ack as the last argument whether or not a payload was sent. */
const splitArgs = (args: unknown[]) => {
  const last = args[args.length - 1];
  const ack = typeof last === 'function' ? (last as Ack) : undefined;
  const payload = (ack ? args.slice(0, -1) : args)[0];
  return {
    payload: (payload && typeof payload === 'object' ? payload : {}) as any,
    ack,
  };
};

/** Realtime transport; persistence and all authorization remain in WhiteboardService. */
export class WhiteboardGateway {
  private presence = new Map<string, Map<string, any>>();
  constructor(
    private readonly io: Server,
    private readonly auth: IAuthService,
    private readonly service: WhiteboardService,
    private readonly capabilities: RoomCapability[] = [],
  ) {
    io.use(async (socket, next) => {
      try {
        socket.data.user = await this.auth.getCurrentUserFromToken(
          socket.handshake.auth?.token,
        );
        next();
      } catch {
        next(new Error('Unauthorized'));
      }
    });
    io.on('connection', socket => this.bind(socket as RoomSocket));
  }

  private bind(socket: RoomSocket) {
    const userId = () => socket.data.user._id.toString();
    const fail = (error: unknown) =>
      socket.emit('whiteboard:error', message(error));
    const currentRoom = () => {
      const roomCode = socket.data.roomCode;
      if (!roomCode) throw new Error('Join a room first');
      return roomCode;
    };
    // Ephemeral relays are not persisted, so the service never sees them —
    // gate them here on the server-computed access, or a viewer could paint
    // "ghost" strokes on everyone else's screen.
    const editableRoom = () =>
      socket.data.access?.canEdit ? socket.data.roomCode : undefined;

    socket.on('join-room', async (...args: unknown[]) => {
      const {payload, ack} = splitArgs(args);
      try {
        if (socket.data.roomCode) this.leaveRoom(socket);
        const roomCode = String(payload.roomCode ?? '');
        const board = await this.service.get(roomCode, userId());
        void socket.join(roomCode);
        socket.data.roomCode = roomCode;
        socket.data.access = board.access;
        this.addPresence(socket, roomCode);
        socket.emit('room:joined', board);
        // Others learn the newcomer's role/permissions (and the newcomer gets
        // the canonical state) through the same per-socket sync as moderation.
        await this.syncRoom(roomCode);
        ack?.({ok: true});
      } catch (error) {
        ack?.({ok: false, error: message(error)});
      }
    });

    socket.on('leave-room', () => this.leaveRoom(socket));

    socket.on('object:create', async (input, ack) => {
      try {
        const saved = await this.service.createObject(
          currentRoom(),
          userId(),
          input,
        );
        this.io.to(currentRoom()).emit('object:created', saved);
        ack?.({ok: true, object: saved});
      } catch (error) {
        fail(error);
        ack?.({ok: false, error: message(error)});
      }
    });
    socket.on('object:update', async ({id, patch}, ack) => {
      try {
        const saved = await this.service.updateObject(
          currentRoom(),
          userId(),
          id,
          patch,
        );
        this.io.to(currentRoom()).emit('object:updated', saved);
        ack?.({ok: true, object: saved});
      } catch (error) {
        fail(error);
        ack?.({ok: false, error: message(error)});
      }
    });
    socket.on('object:delete', async ({id}, ack) => {
      try {
        const deleted = await this.service.deleteObject(
          currentRoom(),
          userId(),
          id,
        );
        if (deleted) this.io.to(currentRoom()).emit('object:deleted', {id});
        ack?.({ok: true});
      } catch (error) {
        fail(error);
        ack?.({ok: false, error: message(error)});
      }
    });

    socket.on('stroke:live', payload => {
      const roomCode = editableRoom();
      if (roomCode)
        socket.to(roomCode).emit('stroke:live', {...payload, userId: userId()});
    });
    socket.on('stroke:live-end', payload => {
      const roomCode = editableRoom();
      if (roomCode)
        socket
          .to(roomCode)
          .emit('stroke:live-end', {...payload, userId: userId()});
    });
    // Ephemeral, unpersisted preview for in-progress object move/resize — the
    // authoritative, persisted state is written once via object:update on release.
    socket.on('object:preview', payload => {
      const roomCode = editableRoom();
      if (roomCode)
        socket
          .to(roomCode)
          .emit('object:preview', {...payload, userId: userId()});
    });

    socket.on('board:clear', async () => {
      try {
        await this.service.clear(currentRoom(), userId());
        this.io.to(currentRoom()).emit('board:clear');
      } catch (error) {
        fail(error);
      }
    });

    // ---- moderation (owner only; ownership is re-checked by the service on every call) ----
    const moderate = (
      event: string,
      action: (roomCode: string, payload: any) => Promise<unknown>,
    ) =>
      socket.on(event, async (...args: unknown[]) => {
        const {payload, ack} = splitArgs(args);
        try {
          const roomCode = currentRoom();
          await action(roomCode, payload);
          await this.syncRoom(roomCode);
          ack?.({ok: true});
        } catch (error) {
          ack?.({ok: false, error: message(error)});
        }
      });
    const role = (value: unknown) => {
      if (value !== 'editor' && value !== 'viewer')
        throw new Error('Invalid role request');
      return value;
    };

    moderate('participant:setRole', (roomCode, {userId: target, role: r}) =>
      this.service.setRole(roomCode, userId(), String(target), role(r)),
    );
    moderate('room:setDefaultRole', (roomCode, {role: r}) =>
      this.service.setDefaultRole(roomCode, userId(), role(r)),
    );
    moderate('participant:setVoice', (roomCode, {userId: target, ...voice}) =>
      this.service.setVoicePermissions(roomCode, userId(), String(target), {
        canJoin: voice.canJoin,
        canSpeak: voice.canSpeak,
      }),
    );
    moderate('room:setSettings', (roomCode, settings) =>
      this.service.setRoomSettings(roomCode, userId(), {
        boardLocked: settings.boardLocked,
        voicePolicy: settings.voicePolicy,
      }),
    );
    moderate('voice:muteAll', roomCode =>
      this.service.muteAll(roomCode, userId(), this.presentUserIds(roomCode)),
    );
    moderate('voice:unmuteAll', roomCode =>
      this.service.unmuteAll(roomCode, userId()),
    );
    moderate('participant:remove', async (roomCode, {userId: target}) => {
      const targetId = String(target);
      const name = [...(this.presence.get(roomCode)?.values() ?? [])].find(
        p => p.userId === targetId,
      )?.name;
      await this.service.removeParticipant(roomCode, userId(), targetId, name);
      // Persisted first, so the target cannot rejoin; then evict every live
      // socket of theirs so they stop receiving room events immediately.
      for (const s of this.roomSockets(roomCode)) {
        if (s.data.user._id.toString() !== targetId) continue;
        s.emit('room:removed', {
          message:
            'You were removed from this collaboration room by the room owner.',
        });
        this.leaveRoom(s);
      }
    });
    moderate('participant:readmit', (roomCode, {userId: target}) =>
      this.service.readmitParticipant(roomCode, userId(), String(target)),
    );

    socket.on('cursor:move', payload => {
      const roomCode = socket.data.roomCode;
      if (roomCode)
        socket.to(roomCode).emit('cursor:move', {...payload, userId: userId()});
    });
    socket.on('cursor:remove', () => {
      const roomCode = socket.data.roomCode;
      if (roomCode)
        socket.to(roomCode).emit('cursor:remove', {userId: userId()});
    });

    socket.on('disconnect', () => this.leaveRoom(socket));
  }

  private roomSockets(roomCode: string): RoomSocket[] {
    const ids = this.io.sockets.adapter.rooms.get(roomCode) ?? new Set();
    return [...ids]
      .map(id => this.io.sockets.sockets.get(id) as RoomSocket | undefined)
      .filter((s): s is RoomSocket => !!s);
  }

  private presentUserIds(roomCode: string) {
    return [...(this.presence.get(roomCode)?.values() ?? [])].map(
      p => p.userId as string,
    );
  }

  /**
   * Re-derives every connected member's access from persisted state and
   * pushes it — each socket receives only its own access, and only the owner
   * receives owner-only data (the removed list).
   */
  private async syncRoom(roomCode: string) {
    const session = await this.service.roomState(roomCode);
    if (!session) return;
    const sockets = this.roomSockets(roomCode).filter(
      s => s.data.roomCode === roomCode,
    );
    for (const s of sockets) {
      const access = computeAccess(session, s.data.user._id.toString());
      s.data.access = access;
      s.emit('room:state', {
        session: serializeSession(session, access.isOwner),
        access,
      });
    }
    for (const capability of this.capabilities)
      capability.onAccessChanged(roomCode, sockets);
  }

  private addPresence(socket: RoomSocket, roomCode: string) {
    const people = this.presence.get(roomCode) ?? new Map();
    people.set(socket.id, {
      userId: socket.data.user._id.toString(),
      name: displayName(socket.data.user),
    });
    this.presence.set(roomCode, people);
    this.broadcastPresence(roomCode);
  }
  private leaveRoom(socket: RoomSocket) {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    for (const capability of this.capabilities) capability.onRoomLeave(socket);
    const people = this.presence.get(roomCode);
    people?.delete(socket.id);
    if (people && !people.size) this.presence.delete(roomCode);
    void socket.leave(roomCode);
    socket.data.roomCode = undefined;
    socket.data.access = undefined;
    socket
      .to(roomCode)
      .emit('cursor:remove', {userId: socket.data.user._id.toString()});
    this.broadcastPresence(roomCode);
  }
  private broadcastPresence(roomCode: string) {
    const people = [...(this.presence.get(roomCode)?.values() ?? [])];
    this.io
      .to(roomCode)
      .emit('presence:update', [
        ...new Map(people.map(person => [person.userId, person])).values(),
      ]);
  }
}
