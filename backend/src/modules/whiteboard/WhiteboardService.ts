import crypto from 'node:crypto';
import {inject, injectable} from 'inversify';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from 'routing-controllers';
import {ObjectId} from 'mongodb';
import {WhiteboardRepository} from './WhiteboardRepository.js';
import {computeAccess, voicePolicyOf} from './access.js';
import {
  ActivityDocument,
  ObjectDocument,
  RoomAccess,
  SessionDocument,
  VoicePolicy,
  WHITEBOARD_TYPES,
  WhiteboardObject,
  WhiteboardObjectInput,
  WhiteboardObjectType,
  WhiteboardRole,
} from './types.js';

const OBJECT_TYPES: WhiteboardObjectType[] = [
  'stroke',
  'line',
  'arrow',
  'rectangle',
  'ellipse',
  'text',
];
const UUID_RE = /^[a-z0-9-]{8,64}$/i;
const COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);

/**
 * Client view of a room. Policy defaults are filled in for boards created
 * before moderation existed; the removed list is only shown to the owner.
 */
export const serializeSession = (s: SessionDocument, forOwner = false) => {
  // activitySeq is a server-internal counter; removed is owner-only (below).
  const {removed, activitySeq: _activitySeq, ...rest} = s;
  return {
    ...rest,
    _id: s._id!.toString(),
    createdBy: s.createdBy.toString(),
    participants: s.participants.map(p => ({
      ...p,
      userId: p.userId.toString(),
    })),
    boardLocked: !!s.boardLocked,
    voicePolicy: voicePolicyOf(s),
    ...(forOwner
      ? {
          removed: (removed ?? []).map(r => ({
            ...r,
            userId: r.userId.toString(),
          })),
        }
      : {}),
  };
};
const serializeObject = (o: ObjectDocument): WhiteboardObject => ({
  ...(o as any),
  id: o._id,
  sessionId: o.sessionId.toString(),
  createdBy: o.createdBy.toString(),
  updatedBy: o.updatedBy.toString(),
});
const serializeActivity = (a: ActivityDocument) => ({
  ...a,
  _id: a._id?.toString(),
  sessionId: a.sessionId.toString(),
  userId: a.userId.toString(),
  snapshot: a.snapshot ? serializeObject(a.snapshot) : undefined,
});

@injectable()
export class WhiteboardService {
  constructor(
    @inject(WHITEBOARD_TYPES.Repository)
    private readonly repository: WhiteboardRepository,
  ) {}

  private validUser(id: string) {
    if (!id || !/^[a-f\d]{24}$/i.test(id))
      throw new BadRequestError('Invalid user');
  }

  async create(userId: string, name?: string) {
    this.validUser(userId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const roomCode = crypto.randomBytes(6).toString('base64url');
      const now = new Date();
      try {
        return serializeSession(
          await this.repository.createSession({
            createdBy: new ObjectId(userId),
            roomCode,
            name: (name || 'Untitled whiteboard').slice(0, 120),
            accessMode: 'anyone-with-link',
            defaultRole: 'editor',
            activitySeq: 0,
            participants: [
              {userId: new ObjectId(userId), role: 'editor', joinedAt: now},
            ],
            createdAt: now,
            updatedAt: now,
          }),
        );
      } catch (error: any) {
        if (error?.code !== 11000 || attempt === 4) throw error;
      }
    }
    throw new BadRequestError('Could not create whiteboard');
  }

  /** Internal: loads the session and resolves the caller's role, auto-joining them as a participant at the board's default role on first visit. */
  private async permission(roomCode: string, userId: string) {
    const session = await this.repository.findSession(roomCode);
    if (!session) throw new NotFoundError('Whiteboard not found');
    if (session.removed?.some(r => r.userId.toString() === userId))
      throw new ForbiddenError(
        'You were removed from this collaboration room by the room owner.',
      );
    const existing = session.participants.find(
      p => p.userId.toString() === userId,
    );
    if (!existing) {
      await this.repository.upsertParticipant(
        session._id!,
        userId,
        session.defaultRole,
      );
      session.participants.push({
        userId: new ObjectId(userId),
        role: session.defaultRole,
        joinedAt: new Date(),
      });
    }
    const access = computeAccess(session, userId);
    return {session, access, role: access.role, isCreator: access.isOwner};
  }

  async get(roomCode: string, userId: string) {
    const {session, access} = await this.permission(roomCode, userId);
    const objects = (await this.repository.listObjects(session._id!)).map(
      serializeObject,
    );
    return {
      session: serializeSession(session, access.isOwner),
      objects,
      role: access.role,
      isCreator: access.isOwner,
      access,
      userId,
    };
  }

  /** Current persisted room state, without auto-joining anyone — for pushing live access updates. */
  async roomState(roomCode: string) {
    return this.repository.findSession(roomCode);
  }

  async listMine(userId: string, limit: number, offset: number) {
    return (
      await this.repository.listSessions(
        userId,
        Math.min(Math.max(limit, 1), 100),
        Math.max(offset, 0),
      )
    ).map(session => serializeSession(session));
  }

  async rename(roomCode: string, userId: string, name: string) {
    const {session, isCreator} = await this.permission(roomCode, userId);
    if (!isCreator)
      throw new ForbiddenError('Only the room creator can rename the board');
    if (!name?.trim()) throw new BadRequestError('Name is required');
    await this.repository.renameSession(
      session._id!,
      name.trim().slice(0, 120),
    );
  }

  async remove(roomCode: string, userId: string) {
    const {session, isCreator} = await this.permission(roomCode, userId);
    if (!isCreator)
      throw new ForbiddenError('Only the room creator can delete the board');
    await this.repository.deleteSession(session._id!);
  }

  async role(roomCode: string, userId: string) {
    const {access} = await this.permission(roomCode, userId);
    return {role: access.role, isCreator: access.isOwner, access};
  }

  /** Every moderation operation goes through here: the caller's ownership is resolved from the DB, never from the client. */
  private async requireOwner(roomCode: string, userId: string) {
    const ctx = await this.permission(roomCode, userId);
    if (!ctx.access.isOwner)
      throw new ForbiddenError('Only the room owner can do that');
    return ctx.session;
  }

  /** Target must be a current, non-owner participant — the owner can never demote, mute or remove themselves. */
  private requireTarget(session: SessionDocument, targetId: string) {
    this.validUser(targetId);
    if (session.createdBy.toString() === targetId)
      throw new ForbiddenError('The room owner cannot be changed');
    const participant = session.participants.find(
      p => p.userId.toString() === targetId,
    );
    if (!participant) throw new NotFoundError('Participant not found');
    return participant;
  }

  async setDefaultRole(
    roomCode: string,
    userId: string,
    defaultRole: WhiteboardRole,
  ) {
    const session = await this.requireOwner(roomCode, userId);
    await this.repository.setDefaultRole(session._id!, defaultRole);
  }

  async setRole(
    roomCode: string,
    ownerId: string,
    userId: string,
    role: WhiteboardRole,
  ) {
    const session = await this.requireOwner(roomCode, ownerId);
    this.requireTarget(session, userId);
    await this.repository.setRole(session._id!, userId, role);
  }

  async setVoicePermissions(
    roomCode: string,
    ownerId: string,
    userId: string,
    voice: {canJoin?: boolean | null; canSpeak?: boolean | null},
  ) {
    const session = await this.requireOwner(roomCode, ownerId);
    this.requireTarget(session, userId);
    const valid = (v: unknown) =>
      v === undefined || v === null || typeof v === 'boolean';
    if (!valid(voice?.canJoin) || !valid(voice?.canSpeak))
      throw new BadRequestError('Invalid voice permissions');
    await this.repository.setParticipantVoice(session._id!, userId, {
      canJoin: voice.canJoin,
      canSpeak: voice.canSpeak,
    });
  }

  async setRoomSettings(
    roomCode: string,
    ownerId: string,
    input: {boardLocked?: boolean; voicePolicy?: Partial<VoicePolicy>},
  ) {
    const session = await this.requireOwner(roomCode, ownerId);
    const update: {boardLocked?: boolean; voicePolicy?: VoicePolicy} = {};
    if (input?.boardLocked !== undefined) {
      if (typeof input.boardLocked !== 'boolean')
        throw new BadRequestError('Invalid room setting');
      update.boardLocked = input.boardLocked;
    }
    if (input?.voicePolicy !== undefined) {
      const next = {...voicePolicyOf(session)};
      for (const key of ['enabled', 'joinMuted', 'speakByDefault'] as const) {
        const value = input.voicePolicy?.[key];
        if (value === undefined) continue;
        if (typeof value !== 'boolean')
          throw new BadRequestError('Invalid voice policy');
        next[key] = value;
      }
      update.voicePolicy = next;
    }
    await this.repository.setRoomSettings(session._id!, update);
  }

  /**
   * "Mute everyone now": revokes speaking for the given participants (those
   * currently in the room). It is a one-off action, distinct from the
   * speakByDefault policy that governs people who arrive later.
   */
  async muteAll(roomCode: string, ownerId: string, userIds: string[]) {
    const session = await this.requireOwner(roomCode, ownerId);
    const targets = [...new Set(userIds)].filter(
      id =>
        id !== session.createdBy.toString() &&
        session.participants.some(p => p.userId.toString() === id),
    );
    if (targets.length)
      await this.repository.blockSpeakingMany(session._id!, targets);
  }

  /**
   * Undo for "mute everyone" (and any individual owner mutes): removes every
   * owner-imposed mute so participants can unmute themselves again. Mutes are
   * stored per participant, so changing the room policy alone never lifts
   * them — this is the explicit way to. People the owner explicitly allowed
   * to speak keep that permission.
   */
  async unmuteAll(roomCode: string, ownerId: string) {
    const session = await this.requireOwner(roomCode, ownerId);
    await this.repository.clearSpeakBlocks(session._id!);
  }

  async removeParticipant(
    roomCode: string,
    ownerId: string,
    userId: string,
    name?: string,
  ) {
    const session = await this.requireOwner(roomCode, ownerId);
    this.requireTarget(session, userId);
    await this.repository.removeParticipant(
      session._id!,
      userId,
      name?.slice(0, 120),
    );
  }

  async readmitParticipant(roomCode: string, ownerId: string, userId: string) {
    const session = await this.requireOwner(roomCode, ownerId);
    this.validUser(userId);
    await this.repository.readmitParticipant(session._id!, userId);
  }

  private requireEditor(access: RoomAccess) {
    if (!access.canEdit)
      throw new ForbiddenError(
        access.role === 'viewer'
          ? 'You have view-only access'
          : 'The whiteboard is locked by the room owner',
      );
  }

  private validateObject(input: WhiteboardObjectInput) {
    if (!input.id || !UUID_RE.test(input.id))
      throw new BadRequestError('Object id is invalid');
    if (!OBJECT_TYPES.includes(input.type))
      throw new BadRequestError('Object type is invalid');
    const style = (input as any).style;
    if (
      !style ||
      typeof style.color !== 'string' ||
      !COLOR_RE.test(style.color)
    )
      throw new BadRequestError('Object colour is invalid');
    if (
      !finite(style.strokeWidth) ||
      style.strokeWidth <= 0 ||
      style.strokeWidth > 200
    )
      throw new BadRequestError('Stroke width is invalid');
    if (
      style.fill !== undefined &&
      (typeof style.fill !== 'string' || !COLOR_RE.test(style.fill))
    )
      throw new BadRequestError('Fill colour is invalid');
    switch (input.type) {
      case 'stroke': {
        const points = (input as any).points;
        if (
          !Array.isArray(points) ||
          !points.length ||
          points.length > 20000 ||
          !points.every((p: any) => finite(p?.x) && finite(p?.y))
        )
          throw new BadRequestError('Stroke points are invalid');
        break;
      }
      case 'line':
      case 'arrow': {
        const o = input as any;
        if (![o.x1, o.y1, o.x2, o.y2].every(finite))
          throw new BadRequestError('Line coordinates are invalid');
        break;
      }
      case 'rectangle':
      case 'ellipse': {
        const o = input as any;
        if (![o.x, o.y, o.width, o.height].every(finite))
          throw new BadRequestError('Shape geometry is invalid');
        break;
      }
      case 'text': {
        const o = input as any;
        if (!finite(o.x) || !finite(o.y) || !finite(o.width))
          throw new BadRequestError('Text position is invalid');
        if (typeof o.text !== 'string' || o.text.length > 10000)
          throw new BadRequestError('Text content is invalid');
        if (!finite(o.fontSize) || o.fontSize <= 0 || o.fontSize > 400)
          throw new BadRequestError('Font size is invalid');
        break;
      }
    }
  }

  private async log(
    sessionId: ObjectId,
    userId: string,
    op: 'create' | 'update' | 'delete',
    objectId: string,
    snapshot?: ObjectDocument,
  ) {
    // nextSeq is atomic; the retry only guards against legacy data that
    // already holds a seq ahead of the counter.
    for (let attempt = 0; ; attempt++) {
      const seq = await this.repository.nextSeq(sessionId);
      try {
        await this.repository.appendActivity({
          sessionId,
          seq,
          userId: new ObjectId(userId),
          op,
          objectId,
          snapshot,
          createdAt: new Date(),
        });
        return;
      } catch (error: any) {
        if (error?.code !== 11000 || attempt >= 4) throw error;
      }
    }
  }

  async createObject(
    roomCode: string,
    userId: string,
    input: WhiteboardObjectInput,
  ) {
    const {session, access} = await this.permission(roomCode, userId);
    this.requireEditor(access);
    this.validateObject(input);
    const now = new Date();
    const doc: ObjectDocument = {
      ...(input as any),
      _id: input.id,
      sessionId: session._id!,
      createdBy: new ObjectId(userId),
      updatedBy: new ObjectId(userId),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.upsertObject(doc);
    await this.log(session._id!, userId, 'create', doc._id, doc);
    await this.repository.touchSession(session._id!);
    return serializeObject(doc);
  }

  async updateObject(
    roomCode: string,
    userId: string,
    objectId: string,
    patch: Partial<WhiteboardObjectInput>,
  ) {
    const {session, access} = await this.permission(roomCode, userId);
    this.requireEditor(access);
    const existing = await this.repository.getObject(session._id!, objectId);
    if (!existing) throw new NotFoundError('Object not found');
    const merged: any = {...existing, ...patch};
    delete merged.id;
    this.validateObject({...merged, id: objectId});
    const doc: ObjectDocument = {
      ...merged,
      _id: objectId,
      sessionId: session._id!,
      createdBy: existing.createdBy,
      updatedBy: new ObjectId(userId),
      version: existing.version + 1,
      createdAt: existing.createdAt,
      updatedAt: new Date(),
    };
    await this.repository.upsertObject(doc);
    await this.log(session._id!, userId, 'update', doc._id, doc);
    await this.repository.touchSession(session._id!);
    return serializeObject(doc);
  }

  async deleteObject(roomCode: string, userId: string, objectId: string) {
    const {session, access} = await this.permission(roomCode, userId);
    this.requireEditor(access);
    const deleted = await this.repository.deleteObject(session._id!, objectId);
    if (!deleted) return null;
    await this.log(session._id!, userId, 'delete', objectId);
    await this.repository.touchSession(session._id!);
    return serializeObject(deleted);
  }

  async clear(roomCode: string, userId: string) {
    const {session, isCreator} = await this.permission(roomCode, userId);
    if (!isCreator)
      throw new ForbiddenError('Only the room creator can clear the board');
    await this.repository.clear(session._id!);
    await this.log(session._id!, userId, 'delete', '*');
  }

  async activity(
    roomCode: string,
    userId: string,
    after: number,
    limit: number,
  ) {
    const {session} = await this.permission(roomCode, userId);
    return (
      await this.repository.listActivity(
        session._id!,
        Math.max(after, 0),
        Math.min(Math.max(limit, 1), 500),
      )
    ).map(serializeActivity);
  }
}
