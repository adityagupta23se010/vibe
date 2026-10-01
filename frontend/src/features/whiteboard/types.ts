export type Tool = 'select' | 'hand' | 'pen' | 'eraser' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'text';
export type WhiteboardObjectType = 'stroke' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'text';
export type WhiteboardRole = 'editor' | 'viewer';

export type Point = { x: number; y: number };
export type Style = { color: string; strokeWidth: number; fill?: string };

export type BaseObject = { id: string; sessionId?: string; type: WhiteboardObjectType; style: Style; createdBy?: string; updatedBy?: string; version?: number; createdAt?: string; updatedAt?: string };
export type StrokeObject = BaseObject & { type: 'stroke'; points: Point[] };
export type LineObject = BaseObject & { type: 'line' | 'arrow'; x1: number; y1: number; x2: number; y2: number };
export type RectObject = BaseObject & { type: 'rectangle' | 'ellipse'; x: number; y: number; width: number; height: number };
export type TextObject = BaseObject & { type: 'text'; x: number; y: number; width: number; text: string; fontSize: number };
export type WhiteboardObject = StrokeObject | LineObject | RectObject | TextObject;

export type Participant = { userId: string; role: WhiteboardRole; joinedAt: string };
export type BoardSession = { _id: string; roomCode: string; name: string; createdBy: string; defaultRole: WhiteboardRole; participants: Participant[]; createdAt: string; updatedAt: string };

export type Presence = { userId: string; name: string };
export type RemoteCursor = { userId: string; name?: string; x: number; y: number; color: string; updatedAt: number };

export type ActivityOp = 'create' | 'update' | 'delete';
export type ActivityEntry = { _id?: string; sessionId: string; seq: number; userId: string; op: ActivityOp; objectId: string; snapshot?: WhiteboardObject; createdAt: string };

export type Camera = { x: number; y: number; zoom: number };
