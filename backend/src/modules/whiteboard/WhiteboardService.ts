import crypto from 'node:crypto';
import {inject, injectable} from 'inversify';
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from 'routing-controllers';
import {ObjectId} from 'mongodb';
import {WhiteboardRepository} from './WhiteboardRepository.js';
import {
  ActivityDocument,
  ObjectDocument,
  SessionDocument,
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

const serializeSession = (s: SessionDocument) => ({
  ...s,
  _id: s._id!.toString(),
  createdBy: s.createdBy.toString(),
  participants: s.participants.map(p => ({...p, userId: p.userId.toString()})),
});
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
    const role =
      session.participants.find(p => p.userId.toString() === userId)?.role ??
      session.defaultRole;
    const isCreator = session.createdBy.toString() === userId;
    return {session, role, isCreator};
  }

  async get(roomCode: string, userId: string) {
    const {session, role, isCreator} = await this.permission(roomCode, userId);
    const objects = (await this.repository.listObjects(session._id!)).map(
      serializeObject,
    );
    return {
      session: serializeSession(session),
      objects,
      role,
      isCreator,
      userId,
    };
  }

  async listMine(userId: string, limit: number, offset: number) {
    return (
      await this.repository.listSessions(
        userId,
        Math.min(Math.max(limit, 1), 100),
        Math.max(offset, 0),
      )
    ).map(serializeSession);
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
    const {role, isCreator} = await this.permission(roomCode, userId);
    return {role, isCreator};
  }

  async setDefaultRole(
    roomCode: string,
    userId: string,
    defaultRole: WhiteboardRole,
  ) {
    const {session, isCreator} = await this.permission(roomCode, userId);
    if (!isCreator)
      throw new ForbiddenError(
        'Only the room creator can change default access',
      );
    await this.repository.setDefaultRole(session._id!, defaultRole);
  }

  async setRole(
    roomCode: string,
    creatorId: string,
    userId: string,
    role: WhiteboardRole,
  ) {
    const {session, isCreator} = await this.permission(roomCode, creatorId);
    if (!isCreator)
      throw new ForbiddenError('Only the room creator can change roles');
    await this.repository.setRole(session._id!, userId, role);
  }

  private requireEditor(role: WhiteboardRole) {
    if (role !== 'editor')
      throw new ForbiddenError('You have view-only access');
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
    const seq = await this.repository.nextSeq(sessionId);
    await this.repository.appendActivity({
      sessionId,
      seq,
      userId: new ObjectId(userId),
      op,
      objectId,
      snapshot,
      createdAt: new Date(),
    });
  }

  async createObject(
    roomCode: string,
    userId: string,
    input: WhiteboardObjectInput,
  ) {
    const {session, role} = await this.permission(roomCode, userId);
    this.requireEditor(role);
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
    const {session, role} = await this.permission(roomCode, userId);
    this.requireEditor(role);
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
    const {session, role} = await this.permission(roomCode, userId);
    this.requireEditor(role);
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
