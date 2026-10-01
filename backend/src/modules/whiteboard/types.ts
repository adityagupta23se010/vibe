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

export interface WhiteboardSession {
  _id?: string;
  createdBy: string;
  roomCode: string;
  name: string;
  accessMode: 'anyone-with-link';
  defaultRole: WhiteboardRole;
  participants: Array<{userId: string; role: WhiteboardRole; joinedAt: Date}>;
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
  '_id' | 'createdBy' | 'participants'
> & {
  _id?: ObjectId;
  createdBy: ObjectId;
  participants: Array<{userId: ObjectId; role: WhiteboardRole; joinedAt: Date}>;
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
