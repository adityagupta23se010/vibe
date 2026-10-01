import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Socket } from 'socket.io-client';
import { LOCAL_ID, VoiceSession, type VoiceAccess, type VoiceSnapshot } from './voice/VoiceSession';

export type ParticipantVoice = { joined: true; muted: boolean; forced: boolean; speaking: boolean };

const IDLE: VoiceSnapshot = { status: 'idle', muted: false, participants: [], remoteStreams: new Map(), speaking: new Set(), canJoin: true, canSpeak: true };
const noopSubscribe = () => () => undefined;

/**
 * React binding for VoiceSession. `roomReady` is the board's "joined" flag:
 * voice signaling is only valid once the server has authorized the socket for
 * the room, and is re-announced automatically after a reconnect. `access`
 * is the server-pushed permission set for this user.
 */
export function useVoiceChat(socket: Socket | null, roomReady: boolean, access: VoiceAccess | null) {
  const [session, setSession] = useState<VoiceSession | null>(null);

  useEffect(() => {
    if (!socket) return;
    const next = new VoiceSession(socket);
    setSession(next);
    return () => {
      next.dispose();
      setSession(null);
    };
  }, [socket]);

  useEffect(() => {
    session?.setRoomReady(roomReady);
  }, [session, roomReady]);

  const canJoinVoice = access?.canJoinVoice ?? true;
  const canSpeak = access?.canSpeak ?? true;
  useEffect(() => {
    session?.setAccess({ canJoinVoice, canSpeak });
  }, [session, canJoinVoice, canSpeak]);

  const snapshot = useSyncExternalStore(session?.subscribe ?? noopSubscribe, session?.getSnapshot ?? (() => IDLE));

  /** Voice state per userId, for the unified participant list. Absent = not in voice. */
  const byUser = useMemo(() => {
    const map = new Map<string, ParticipantVoice>();
    for (const p of snapshot.participants) {
      const self = p.socketId === snapshot.selfSocketId;
      map.set(p.userId, {
        joined: true,
        // Own mute state is local-first so the UI never lags the click.
        muted: self ? snapshot.muted : p.muted,
        forced: self ? !snapshot.canSpeak : p.forced,
        // A force-muted peer's audio is not played, so never show them as speaking.
        speaking: !(self ? !snapshot.canSpeak : p.forced) && snapshot.speaking.has(self ? LOCAL_ID : p.socketId),
      });
    }
    return map;
  }, [snapshot]);

  /** Peers whose audio this client refuses to play (owner force-muted). */
  const silenced = useMemo(() => new Set(snapshot.participants.filter(p => p.forced).map(p => p.socketId)), [snapshot.participants]);

  return {
    ...snapshot,
    byUser,
    silenced,
    supported: session?.supported ?? true,
    inVoice: snapshot.status !== 'idle' && snapshot.status !== 'disconnected',
    join: () => void session?.join(),
    leave: () => session?.leave(),
    toggleMute: () => session?.toggleMute(),
  };
}
export type VoiceChat = ReturnType<typeof useVoiceChat>;
