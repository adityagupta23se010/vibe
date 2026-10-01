import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { BoardSession, Participant, Presence, WhiteboardObject, WhiteboardRole } from './types';

type JoinedPayload = { session: BoardSession; objects: WhiteboardObject[]; role: WhiteboardRole; isCreator: boolean; userId: string };
type Callbacks = {
  onJoined: (payload: JoinedPayload) => void;
  onObjectCreated: (object: WhiteboardObject) => void;
  onObjectUpdated: (object: WhiteboardObject) => void;
  onObjectDeleted: (payload: { id: string }) => void;
  onStrokeLive: (payload: any) => void;
  onStrokeLiveEnd: (payload: { id: string; userId: string }) => void;
  onObjectPreview: (payload: { id: string; patch: Record<string, unknown>; userId: string }) => void;
  onCursorMove: (payload: { userId: string; x: number; y: number }) => void;
  onCursorRemove: (payload: { userId: string }) => void;
  onPresence: (people: Presence[]) => void;
  onPermissionsChanged: (payload: { userId: string; role: WhiteboardRole }) => void;
  onParticipants: (participants: Participant[]) => void;
  onDefaultRoleChanged: (payload: { role: WhiteboardRole }) => void;
  onClear: () => void;
  onError: (message: string) => void;
};
type Options = { roomCode?: string } & Partial<Callbacks>;

const origin = (import.meta.env.VITE_BASE_URL || window.location.origin).replace(/\/api\/?$/, '');
const ACK_TIMEOUT = 5000;

export function useWhiteboardSocket({ roomCode, ...callbacks }: Options) {
  const socket = useRef<Socket | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const [connected, setConnected] = useState(false);
  const [joined, setJoined] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [fatalError, setFatalError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const s = io(origin, { auth: { token: localStorage.getItem('firebase-auth-token') }, transports: ['websocket', 'polling'], reconnectionAttempts: Infinity });
    socket.current = s;
    s.on('connect', () => { setConnected(true); setReconnecting(false); });
    s.on('disconnect', () => { setConnected(false); setJoined(false); });
    s.io.on('reconnect_attempt', () => setReconnecting(true));
    s.on('connect_error', () => setReconnecting(true));
    s.on('room:joined', (value: JoinedPayload) => { setJoined(true); callbacksRef.current.onJoined?.(value); });
    s.on('object:created', (value: WhiteboardObject) => callbacksRef.current.onObjectCreated?.(value));
    s.on('object:updated', (value: WhiteboardObject) => callbacksRef.current.onObjectUpdated?.(value));
    s.on('object:deleted', (value: { id: string }) => callbacksRef.current.onObjectDeleted?.(value));
    s.on('stroke:live', (value: any) => callbacksRef.current.onStrokeLive?.(value));
    s.on('stroke:live-end', (value: any) => callbacksRef.current.onStrokeLiveEnd?.(value));
    s.on('object:preview', (value: any) => callbacksRef.current.onObjectPreview?.(value));
    s.on('cursor:move', (value: any) => callbacksRef.current.onCursorMove?.(value));
    s.on('cursor:remove', (value: any) => callbacksRef.current.onCursorRemove?.(value));
    s.on('presence:update', (value: Presence[]) => callbacksRef.current.onPresence?.(value));
    s.on('room:permissions:changed', (value: any) => callbacksRef.current.onPermissionsChanged?.(value));
    s.on('room:participants', (value: Participant[]) => callbacksRef.current.onParticipants?.(value));
    s.on('room:defaultRole:changed', (value: any) => callbacksRef.current.onDefaultRoleChanged?.(value));
    s.on('board:clear', () => callbacksRef.current.onClear?.());
    s.on('whiteboard:error', (message: string) => callbacksRef.current.onError?.(message));
    return () => { s.disconnect(); };
  }, []);

  useEffect(() => {
    if (!roomCode || !socket.current) return;
    setJoined(false);
    setFatalError(undefined);
    const join = () => socket.current?.emit('join-room', { roomCode }, (ack: { ok: boolean }) => { if (!ack?.ok) setFatalError('Unable to load this whiteboard.'); });
    if (socket.current.connected) join();
    socket.current.on('connect', join);
    return () => { socket.current?.off('connect', join); socket.current?.emit('leave-room'); };
  }, [roomCode]);

  const emit = (event: string, payload?: unknown) => socket.current?.emit(event, payload);
  const emitAck = <T = any>(event: string, payload?: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const s = socket.current;
      if (!s) return reject(new Error('Not connected'));
      const timer = setTimeout(() => reject(new Error('Request timed out')), ACK_TIMEOUT);
      s.emit(event, payload, (ack: any) => { clearTimeout(timer); if (ack?.ok) resolve(ack); else reject(new Error('Request failed')); });
    });

  return { connected, joined, reconnecting, fatalError, emit, emitAck };
}
