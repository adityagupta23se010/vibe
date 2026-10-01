import {inject, injectable} from 'inversify';
import {Collection, ObjectId} from 'mongodb';
import {GLOBAL_TYPES} from '#root/types.js';
import {MongoDatabase} from '#shared/database/providers/mongo/MongoDatabase.js';
import {
  ActivityDocument,
  ObjectDocument,
  SessionDocument,
  WhiteboardRole,
} from './types.js';

@injectable()
export class WhiteboardRepository {
  private sessions!: Collection<SessionDocument>;
  private objects!: Collection<ObjectDocument>;
  private activity!: Collection<ActivityDocument>;
  constructor(
    @inject(GLOBAL_TYPES.Database) private readonly db: MongoDatabase,
  ) {}
  private async init() {
    if (this.sessions) return;
    this.sessions = await this.db.getCollection<SessionDocument>(
      'whiteboard_sessions',
    );
    this.objects =
      await this.db.getCollection<ObjectDocument>('whiteboard_objects');
    this.activity = await this.db.getCollection<ActivityDocument>(
      'whiteboard_activity',
    );
    await Promise.all([
      this.sessions.createIndex({roomCode: 1}, {unique: true}),
      this.sessions.createIndex({createdBy: 1}),
      this.objects.createIndex({sessionId: 1}),
      this.activity.createIndex({sessionId: 1, seq: 1}, {unique: true}),
    ]);
  }

  async createSession(session: SessionDocument) {
    await this.init();
    const result = await this.sessions.insertOne(session);
    return {...session, _id: result.insertedId};
  }
  async findSession(roomCode: string) {
    await this.init();
    return this.sessions.findOne({roomCode});
  }
  async findSessionById(id: string) {
    await this.init();
    return ObjectId.isValid(id)
      ? this.sessions.findOne({_id: new ObjectId(id)})
      : null;
  }
  async listSessions(userId: string, limit: number, offset: number) {
    await this.init();
    return this.sessions
      .find({
        $or: [
          {createdBy: new ObjectId(userId)},
          {'participants.userId': new ObjectId(userId)},
        ],
      })
      .sort({updatedAt: -1})
      .skip(offset)
      .limit(limit)
      .toArray();
  }
  async renameSession(sessionId: ObjectId, name: string) {
    await this.init();
    await this.sessions.updateOne(
      {_id: sessionId},
      {$set: {name, updatedAt: new Date()}},
    );
  }
  async touchSession(sessionId: ObjectId) {
    await this.init();
    await this.sessions.updateOne(
      {_id: sessionId},
      {$set: {updatedAt: new Date()}},
    );
  }
  async deleteSession(sessionId: ObjectId) {
    await this.init();
    await Promise.all([
      this.sessions.deleteOne({_id: sessionId}),
      this.objects.deleteMany({sessionId}),
      this.activity.deleteMany({sessionId}),
    ]);
  }
  async setDefaultRole(sessionId: ObjectId, defaultRole: WhiteboardRole) {
    await this.init();
    await this.sessions.updateOne(
      {_id: sessionId},
      {$set: {defaultRole, updatedAt: new Date()}},
    );
  }
  async upsertParticipant(
    sessionId: ObjectId,
    userId: string,
    role: WhiteboardRole,
  ) {
    await this.init();
    await this.sessions.updateOne(
      {_id: sessionId, 'participants.userId': {$ne: new ObjectId(userId)}},
      {
        $push: {
          participants: {
            userId: new ObjectId(userId),
            role,
            joinedAt: new Date(),
          },
        },
      },
    );
  }
  async setRole(sessionId: ObjectId, userId: string, role: WhiteboardRole) {
    await this.init();
    await this.sessions.updateOne(
      {_id: sessionId, 'participants.userId': new ObjectId(userId)},
      {$set: {'participants.$.role': role}},
    );
  }
  /** `null` clears an override so the participant follows the room policy again. */
  async setParticipantVoice(
    sessionId: ObjectId,
    userId: string,
    voice: {canJoin?: boolean | null; canSpeak?: boolean | null},
  ) {
    await this.init();
    const $set: Record<string, boolean> = {};
    const $unset: Record<string, ''> = {};
    for (const key of ['canJoin', 'canSpeak'] as const) {
      const value = voice[key];
      if (value === undefined) continue;
      if (value === null) $unset[`participants.$.voice.${key}`] = '';
      else $set[`participants.$.voice.${key}`] = value;
    }
    if (!Object.keys($set).length && !Object.keys($unset).length) return;
    await this.sessions.updateOne(
      {_id: sessionId, 'participants.userId': new ObjectId(userId)},
      {
        ...(Object.keys($set).length ? {$set} : {}),
        ...(Object.keys($unset).length ? {$unset} : {}),
      },
    );
  }
  /** Mute everyone: force a speak override of `false` onto the listed participants. */
  async blockSpeakingMany(sessionId: ObjectId, userIds: string[]) {
    await this.init();
    await this.sessions.updateOne(
      {_id: sessionId},
      {$set: {'participants.$[p].voice.canSpeak': false}},
      {
        arrayFilters: [
          {'p.userId': {$in: userIds.map(id => new ObjectId(id))}},
        ],
      },
    );
  }
  /** Unmute everyone: drop every owner-imposed mute, leaving explicit "allowed to speak" overrides intact. */
  async clearSpeakBlocks(sessionId: ObjectId) {
    await this.init();
    await this.sessions.updateOne(
      {_id: sessionId},
      {$unset: {'participants.$[p].voice.canSpeak': ''}},
      {arrayFilters: [{'p.voice.canSpeak': false}]},
    );
  }
  async setRoomSettings(
    sessionId: ObjectId,
    settings: Partial<Pick<SessionDocument, 'boardLocked' | 'voicePolicy'>>,
  ) {
    await this.init();
    await this.sessions.updateOne(
      {_id: sessionId},
      {$set: {...settings, updatedAt: new Date()}},
    );
  }
  async removeParticipant(
    sessionId: ObjectId,
    userId: string,
    name: string | undefined,
  ) {
    await this.init();
    const id = new ObjectId(userId);
    await this.sessions.updateOne({_id: sessionId}, {
      $pull: {participants: {userId: id}, removed: {userId: id}},
    } as any);
    await this.sessions.updateOne(
      {_id: sessionId},
      {$push: {removed: {userId: id, name, removedAt: new Date()}}},
    );
  }
  async readmitParticipant(sessionId: ObjectId, userId: string) {
    await this.init();
    await this.sessions.updateOne({_id: sessionId}, {
      $pull: {removed: {userId: new ObjectId(userId)}},
    } as any);
  }

  async listObjects(sessionId: ObjectId) {
    await this.init();
    return this.objects.find({sessionId}).toArray();
  }
  async getObject(sessionId: ObjectId, objectId: string) {
    await this.init();
    return this.objects.findOne({_id: objectId, sessionId});
  }
  async upsertObject(doc: ObjectDocument) {
    await this.init();
    await this.objects.replaceOne(
      {_id: doc._id, sessionId: doc.sessionId},
      doc,
      {upsert: true},
    );
    return doc;
  }
  async deleteObject(sessionId: ObjectId, objectId: string) {
    await this.init();
    return this.objects.findOneAndDelete({_id: objectId, sessionId});
  }
  async clear(sessionId: ObjectId) {
    await this.init();
    await this.objects.deleteMany({sessionId});
  }

  async nextSeq(sessionId: ObjectId) {
    await this.init();
    const last = await this.activity
      .find({sessionId})
      .sort({seq: -1})
      .limit(1)
      .toArray();
    return (last[0]?.seq ?? 0) + 1;
  }
  async appendActivity(entry: ActivityDocument) {
    await this.init();
    await this.activity.insertOne(entry);
    return entry;
  }
  async listActivity(sessionId: ObjectId, afterSeq: number, limit: number) {
    await this.init();
    return this.activity
      .find({sessionId, seq: {$gt: afterSeq}})
      .sort({seq: 1})
      .limit(limit)
      .toArray();
  }
}
