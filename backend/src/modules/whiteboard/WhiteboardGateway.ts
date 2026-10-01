import {Server, Socket} from 'socket.io';
import {IAuthService} from '#auth/interfaces/IAuthService.js';
import {WhiteboardService} from './WhiteboardService.js';

type BoardSocket = Socket & {data: {user?: any; roomCode?: string}};

/** Realtime transport; persistence and all authorization remain in WhiteboardService. */
export class WhiteboardGateway {
  private presence = new Map<string, Map<string, any>>();
  constructor(
    private readonly io: Server,
    private readonly auth: IAuthService,
    private readonly service: WhiteboardService,
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
    io.on('connection', socket => this.bind(socket as BoardSocket));
  }

  private bind(socket: BoardSocket) {
    const userId = () => socket.data.user._id.toString();
    const fail = (error: unknown) =>
      socket.emit(
        'whiteboard:error',
        error instanceof Error ? error.message : 'Whiteboard request failed',
      );
    const currentRoom = () => {
      const roomCode = socket.data.roomCode;
      if (!roomCode) throw new Error('Join a room first');
      return roomCode;
    };

    socket.on('join-room', async ({roomCode}, ack) => {
      try {
        if (socket.data.roomCode) {
          this.removePresence(socket);
        }
        const board = await this.service.get(roomCode, userId());
        void socket.join(roomCode);
        socket.data.roomCode = roomCode;
        this.addPresence(socket, roomCode);
        socket.emit('room:joined', board);
        // Other already-connected clients only learn about this join via
        // presence:update (ephemeral, no role info) — without this, their
        // local copy of session.participants never gains the new
        // participant's row, so the editor/viewer dropdown shows nothing (or
        // a stale fallback) for anyone who joins after they did.
        socket.to(roomCode).emit('room:participants', board.session.participants);
        ack?.({ok: true});
      } catch (error) {
        fail(error);
        ack?.({ok: false});
      }
    });

    socket.on('leave-room', () => this.removePresence(socket));

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
        ack?.({ok: false});
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
        ack?.({ok: false});
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
        ack?.({ok: false});
      }
    });

    socket.on('stroke:live', payload => {
      const roomCode = socket.data.roomCode;
      if (roomCode)
        socket.to(roomCode).emit('stroke:live', {...payload, userId: userId()});
    });
    socket.on('stroke:live-end', payload => {
      const roomCode = socket.data.roomCode;
      if (roomCode)
        socket
          .to(roomCode)
          .emit('stroke:live-end', {...payload, userId: userId()});
    });
    // Ephemeral, unpersisted preview for in-progress object move/resize — the
    // authoritative, persisted state is written once via object:update on release.
    socket.on('object:preview', payload => {
      const roomCode = socket.data.roomCode;
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

    socket.on('participant:setRole', async ({userId: participantId, role}) => {
      try {
        if (!['editor', 'viewer'].includes(role))
          throw new Error('Invalid role request');
        await this.service.setRole(
          currentRoom(),
          userId(),
          participantId,
          role,
        );
        this.io
          .to(currentRoom())
          .emit('room:permissions:changed', {userId: participantId, role});
      } catch (error) {
        fail(error);
      }
    });
    socket.on('room:setDefaultRole', async ({role}) => {
      try {
        if (!['editor', 'viewer'].includes(role))
          throw new Error('Invalid role request');
        await this.service.setDefaultRole(currentRoom(), userId(), role);
        this.io
          .to(currentRoom())
          .emit('room:defaultRole:changed', {role});
      } catch (error) {
        fail(error);
      }
    });

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

    socket.on('disconnect', () => this.removePresence(socket));
  }

  private addPresence(socket: BoardSocket, roomCode: string) {
    const people = this.presence.get(roomCode) ?? new Map();
    people.set(socket.id, {
      userId: socket.data.user._id.toString(),
      name: socket.data.user.name || socket.data.user.email || 'Participant',
    });
    this.presence.set(roomCode, people);
    this.broadcastPresence(roomCode);
  }
  private removePresence(socket: BoardSocket) {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    this.presence.get(roomCode)?.delete(socket.id);
    void socket.leave(roomCode);
    socket.data.roomCode = undefined;
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
