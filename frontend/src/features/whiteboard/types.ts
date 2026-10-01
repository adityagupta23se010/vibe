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

/** Owner overrides for one participant; absent = follows the room's voice policy. */
export type ParticipantVoicePermissions = { canJoin?: boolean; canSpeak?: boolean };
export type Participant = { userId: string; role: WhiteboardRole; joinedAt: string; voice?: ParticipantVoicePermissions };
export type VoicePolicy = { enabled: boolean; joinMuted: boolean; speakByDefault: boolean };
export type RemovedParticipant = { userId: string; name?: string; removedAt: string };
export type BoardSession = {
  _id: string; roomCode: string; name: string; createdBy: string; defaultRole: WhiteboardRole; participants: Participant[];
  boardLocked: boolean; voicePolicy: VoicePolicy;
  /** Only sent to the owner. */
  removed?: RemovedParticipant[];
  createdAt: string; updatedAt: string;
};
/** What *this* user may do — computed and pushed by the server; the UI only mirrors it. */
export type RoomAccess = { role: 'owner' | WhiteboardRole; isOwner: boolean; canEdit: boolean; canJoinVoice: boolean; canSpeak: boolean; joinMuted: boolean };

export type Presence = { userId: string; name: string };
export type RemoteCursor = { userId: string; name?: string; x: number; y: number; color: string; updatedAt: number };

export type ActivityOp = 'create' | 'update' | 'delete';
export type ActivityEntry = { _id?: string; sessionId: string; seq: number; userId: string; op: ActivityOp; objectId: string; snapshot?: WhiteboardObject; createdAt: string };

export type Camera = { x: number; y: number; zoom: number };
