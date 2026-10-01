import type {
  RoomAccess,
  SessionDocument,
  VoicePolicy,
  WhiteboardRole,
} from './types.js';

export const DEFAULT_VOICE_POLICY: VoicePolicy = {
  enabled: true,
  joinMuted: false,
  speakByDefault: true,
};

/**
 * What each persisted role may do on the board. New roles (e.g. a TA
 * "moderator") are added here and in WhiteboardRole — every check below and
 * in the service reads capabilities, never role names.
 */
export const ROLE_CAPABILITIES: Record<WhiteboardRole, {canEdit: boolean}> = {
  editor: {canEdit: true},
  viewer: {canEdit: false},
};

export const voicePolicyOf = (
  session: Pick<SessionDocument, 'voicePolicy'>,
) => ({
  ...DEFAULT_VOICE_POLICY,
  ...(session.voicePolicy ?? {}),
});

export const isOwner = (
  session: Pick<SessionDocument, 'createdBy'>,
  userId: string,
) => session.createdBy.toString() === userId;

/**
 * The single authority for what a user may do in a room. Derived entirely
 * from persisted room state and the server-resolved identity — never from
 * anything the client claims. The owner is unconditionally allowed
 * everything, so no room setting can lock the owner out.
 */
export function computeAccess(
  session: SessionDocument,
  userId: string,
): RoomAccess {
  const policy = voicePolicyOf(session);
  if (isOwner(session, userId)) {
    return {
      role: 'owner',
      isOwner: true,
      canEdit: true,
      canJoinVoice: true,
      canSpeak: true,
      joinMuted: false,
    };
  }
  const participant = session.participants.find(
    p => p.userId.toString() === userId,
  );
  const role = participant?.role ?? session.defaultRole;
  return {
    role,
    isOwner: false,
    canEdit: ROLE_CAPABILITIES[role]?.canEdit === true && !session.boardLocked,
    canJoinVoice: policy.enabled && participant?.voice?.canJoin !== false,
    canSpeak: participant?.voice?.canSpeak ?? policy.speakByDefault,
    joinMuted: policy.joinMuted,
  };
}
