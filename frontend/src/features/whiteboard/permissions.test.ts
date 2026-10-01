import { describe, expect, it } from 'vitest';
import { permissionsOf } from './permissions';
import type { BoardSession } from './types';

const session = (over: Partial<BoardSession> = {}): BoardSession => ({
  _id: 's', roomCode: 'r', name: 'n', createdBy: 'owner', defaultRole: 'viewer',
  participants: [
    { userId: 'ed', role: 'editor', joinedAt: '' },
    { userId: 'vw', role: 'viewer', joinedAt: '', voice: { canSpeak: false } },
  ],
  boardLocked: false,
  voicePolicy: { enabled: true, joinMuted: false, speakByDefault: true },
  createdAt: '', updatedAt: '',
  ...over,
});

describe('permissionsOf (display mirror of server access)', () => {
  it('owner can always do everything', () => {
    expect(permissionsOf(session({ boardLocked: true, voicePolicy: { enabled: false, joinMuted: true, speakByDefault: false } }), 'owner'))
      .toMatchObject({ isOwner: true, canEdit: true, canJoinVoice: true, canSpeak: true });
  });
  it('reflects roles, lock, voice policy and per-user overrides', () => {
    expect(permissionsOf(session(), 'ed')).toMatchObject({ canEdit: true, canSpeak: true, hasVoiceOverride: false });
    expect(permissionsOf(session(), 'vw')).toMatchObject({ canEdit: false, canSpeak: false, hasVoiceOverride: true });
    expect(permissionsOf(session({ boardLocked: true }), 'ed').canEdit).toBe(false);
    expect(permissionsOf(session({ voicePolicy: { enabled: false, joinMuted: false, speakByDefault: true } }), 'ed').canJoinVoice).toBe(false);
    // Unknown (not yet joined) users get the default role.
    expect(permissionsOf(session(), 'new')).toMatchObject({ role: 'viewer', canEdit: false });
  });
});
