import {ObjectId} from 'mongodb';

export type WhiteboardObjectType =
  | 'stroke'
  | 'line'
  | 'arrow'
  | 'rectangle'
  | 'ellipse'
  | 'text';
export type WhiteboardRole = 'editor' | 'viewer';
export type WhiteboardActivityOp = 'create' | 'update' | 'delete';

export interface WhiteboardPoint {
  x: number;
  y: number;
}

export interface WhiteboardObjectStyle {
  color: string;
  strokeWidth: number;
  fill?: string;
}

/** Discriminated union of everything that can live on the board. All geometry is in world (canvas) coordinates — camera/zoom is purely client-local and never stored. */
export interface WhiteboardObjectBase {
  id: string;
  sessionId: string;
  type: WhiteboardObjectType;
  style: WhiteboardObjectStyle;
  createdBy: string;
  updatedBy: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
export interface WhiteboardStrokeObject extends WhiteboardObjectBase {
  type: 'stroke';
  points: WhiteboardPoint[];
}
export interface WhiteboardLineObject extends WhiteboardObjectBase {
  type: 'line' | 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface WhiteboardRectObject extends WhiteboardObjectBase {
  type: 'rectangle' | 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface WhiteboardTextObject extends WhiteboardObjectBase {
  type: 'text';
  x: number;
  y: number;
  width: number;
  text: string;
  fontSize: number;
}
export type WhiteboardObject =
  | WhiteboardStrokeObject
  | WhiteboardLineObject
  | WhiteboardRectObject
  | WhiteboardTextObject;

/** Client-submitted payload for create/update — server assigns id continuity, version, timestamps, ownership. */
export type WhiteboardObjectInput = Omit<
  WhiteboardObject,
  | 'sessionId'
  | 'createdBy'
  | 'updatedBy'
  | 'version'
  | 'createdAt'
  | 'updatedAt'
>;

/** Room-wide voice rules, set by the owner. Persisted with the session. */
export interface VoicePolicy {
  /** Off = only the owner may use voice ("lock voice"). */
  enabled: boolean;
  /** Participants join voice with their microphone off (they may unmute if allowed to speak). */
  joinMuted: boolean;
  /** Off = participants may only speak once the owner allows them individually. */
  speakByDefault: boolean;
}

/** Owner overrides for one participant; undefined means "follow the room policy". */
export interface ParticipantVoicePermissions {
  canJoin?: boolean;
  canSpeak?: boolean;
}

export interface RemovedParticipant<Id = string> {
  userId: Id;
  name?: string;
  removedAt: Date;
}

/** What the requesting user may do right now — computed server-side, sent to that user only. */
export interface RoomAccess {
  role: 'owner' | WhiteboardRole;
  isOwner: boolean;
  canEdit: boolean;
  canJoinVoice: boolean;
  canSpeak: boolean;
  joinMuted: boolean;
}

export interface WhiteboardParticipant<Id = string> {
  userId: Id;
  role: WhiteboardRole;
  joinedAt: Date;
  voice?: ParticipantVoicePermissions;
}

export interface WhiteboardSession {
  _id?: string;
  createdBy: string;
  roomCode: string;
  name: string;
  accessMode: 'anyone-with-link';
  defaultRole: WhiteboardRole;
  participants: WhiteboardParticipant[];
  /** "Lock whiteboard": everyone but the owner is read-only; roles are kept for when it is unlocked. */
  boardLocked?: boolean;
  voicePolicy?: VoicePolicy;
  /** Users the owner removed; they cannot re-enter via the link until re-admitted. */
  removed?: RemovedParticipant[];
  createdAt: Date;
  updatedAt: Date;
}

export interface WhiteboardActivityEntry {
  _id?: string;
  sessionId: string;
  seq: number;
  userId: string;
  op: WhiteboardActivityOp;
  objectId: string;
  /** Full object state after a create/update, for replay + undo inversion. Undefined for delete. */
  snapshot?: WhiteboardObject;
  createdAt: Date;
}

export type SessionDocument = Omit<
  WhiteboardSession,
  '_id' | 'createdBy' | 'participants' | 'removed'
> & {
  _id?: ObjectId;
  createdBy: ObjectId;
  participants: WhiteboardParticipant<ObjectId>[];
  removed?: RemovedParticipant<ObjectId>[];
};
export type ObjectDocument = Omit<
  WhiteboardObject,
  'id' | 'sessionId' | 'createdBy' | 'updatedBy'
> & {
  _id: string;
  sessionId: ObjectId;
  createdBy: ObjectId;
  updatedBy: ObjectId;
};
export type ActivityDocument = Omit<
  WhiteboardActivityEntry,
  '_id' | 'sessionId' | 'userId' | 'snapshot'
> & {
  _id?: ObjectId;
  sessionId: ObjectId;
  userId: ObjectId;
  snapshot?: ObjectDocument;
};

export const WHITEBOARD_TYPES = {
  Repository: Symbol.for('WhiteboardRepository'),
  Service: Symbol.for('WhiteboardService'),
};
