export type VoiceParticipant = {
  socketId: string;
  userId: string;
  name: string;
  muted: boolean;
  /** Muted by the room owner — the participant cannot unmute themselves. */
  forced: boolean;
};

/**
 * Ephemeral, in-memory voice membership per collaboration room. Nothing here
 * is persisted: it mirrors who currently has a live signaling session.
 * One voice session per user per room — a newer join replaces an older one.
 */
export class VoiceRegistry {
  private rooms = new Map<string, Map<string, VoiceParticipant>>();
  private socketRoom = new Map<string, string>();

  join(
    roomCode: string,
    participant: Omit<VoiceParticipant, 'muted' | 'forced'>,
    initial: {muted: boolean; forced: boolean} = {muted: false, forced: false},
  ) {
    this.leave(participant.socketId);
    const room = this.rooms.get(roomCode) ?? new Map();
    let evicted: string | undefined;
    for (const existing of room.values()) {
      if (existing.userId === participant.userId) {
        evicted = existing.socketId;
        room.delete(existing.socketId);
        this.socketRoom.delete(existing.socketId);
      }
    }
    room.set(participant.socketId, {
      ...participant,
      muted: initial.muted || initial.forced,
      forced: initial.forced,
    });
    this.rooms.set(roomCode, room);
    this.socketRoom.set(participant.socketId, roomCode);
    return {
      evicted,
      peers: this.list(roomCode).filter(
        p => p.socketId !== participant.socketId,
      ),
    };
  }

  leave(socketId: string) {
    const roomCode = this.socketRoom.get(socketId);
    if (!roomCode) return undefined;
    this.socketRoom.delete(socketId);
    const room = this.rooms.get(roomCode);
    room?.delete(socketId);
    if (room && room.size === 0) this.rooms.delete(roomCode);
    return roomCode;
  }

  setMuted(socketId: string, muted: boolean) {
    const roomCode = this.socketRoom.get(socketId);
    const participant = roomCode && this.rooms.get(roomCode)?.get(socketId);
    if (!participant) return undefined;
    participant.muted = muted;
    return roomCode;
  }

  /** Owner force-mute on/off. Forcing also mutes; releasing leaves the mic muted until the user unmutes. */
  setForced(socketId: string, forced: boolean) {
    const participant = this.get(socketId);
    if (!participant) return undefined;
    participant.forced = forced;
    if (forced) participant.muted = true;
    return this.socketRoom.get(socketId);
  }

  roomOf(socketId: string) {
    return this.socketRoom.get(socketId);
  }

  get(socketId: string) {
    const roomCode = this.socketRoom.get(socketId);
    return roomCode ? this.rooms.get(roomCode)?.get(socketId) : undefined;
  }

  list(roomCode: string): VoiceParticipant[] {
    return [...(this.rooms.get(roomCode)?.values() ?? [])];
  }

  sameRoom(a: string, b: string) {
    const room = this.socketRoom.get(a);
    return !!room && room === this.socketRoom.get(b);
  }
}
