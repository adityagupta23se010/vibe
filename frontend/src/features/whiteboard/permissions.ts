import type { BoardSession, WhiteboardRole } from './types';

export type ParticipantPermissions = {
  isOwner: boolean;
  role: WhiteboardRole;
  canEdit: boolean;
  canJoinVoice: boolean;
  canSpeak: boolean;
  /** Owner overrides currently set for this participant (vs. following room defaults). */
  hasVoiceOverride: boolean;
};

/**
 * Display-only mirror of the server's computeAccess, so the owner can see at a
 * glance what each participant may do. It never gates anything — the server
 * re-derives and enforces access on every operation.
 */
export function permissionsOf(session: BoardSession, userId: string): ParticipantPermissions {
  const participant = session.participants.find(p => p.userId === userId);
  const role = participant?.role ?? session.defaultRole;
  if (session.createdBy === userId) {
    return { isOwner: true, role, canEdit: true, canJoinVoice: true, canSpeak: true, hasVoiceOverride: false };
  }
  const voice = participant?.voice;
  return {
    isOwner: false,
    role,
    canEdit: role === 'editor' && !session.boardLocked,
    canJoinVoice: session.voicePolicy.enabled && voice?.canJoin !== false,
    canSpeak: voice?.canSpeak ?? session.voicePolicy.speakByDefault,
    hasVoiceOverride: voice?.canJoin !== undefined || voice?.canSpeak !== undefined,
  };
}
