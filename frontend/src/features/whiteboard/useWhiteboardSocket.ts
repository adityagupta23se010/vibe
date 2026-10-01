import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { BoardSession, Presence, RoomAccess, WhiteboardObject } from './types';

type JoinedPayload = { session: BoardSession; objects: WhiteboardObject[]; access: RoomAccess; userId: string };
export type RoomStatePayload = { session: BoardSession; access: RoomAccess };
export type Ack = { ok: boolean; error?: string };
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
  onRoomState: (payload: RoomStatePayload) => void;
  onRemoved: (payload: { message: string }) => void;
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
  // Once removed, never auto-rejoin on reconnect.
  const [removed, setRemoved] = useState<string | undefined>(undefined);
  // Exposed so other realtime capabilities in the room (voice) share this one
  // authenticated connection instead of opening their own.
  const [instance, setInstance] = useState<Socket | null>(null);

  useEffect(() => {
    const s = io(origin, { auth: { token: localStorage.getItem('firebase-auth-token') }, transports: ['websocket', 'polling'], reconnectionAttempts: Infinity });
    socket.current = s;
    setInstance(s);
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
    // One authoritative push for roles, permissions and room policy — sent per user by the server.
    s.on('room:state', (value: RoomStatePayload) => callbacksRef.current.onRoomState?.(value));
    s.on('room:removed', (value: { message: string }) => { setRemoved(value.message); callbacksRef.current.onRemoved?.(value); });
    s.on('board:clear', () => callbacksRef.current.onClear?.());
    s.on('whiteboard:error', (message: string) => callbacksRef.current.onError?.(message));
    return () => { s.disconnect(); setInstance(null); };
  }, []);

  useEffect(() => {
    if (!roomCode || !socket.current || removed) return;
    setJoined(false);
    setFatalError(undefined);
    const join = () => socket.current?.emit('join-room', { roomCode }, (ack: Ack) => { if (!ack?.ok) setFatalError(ack?.error || 'Unable to load this whiteboard.'); });
    if (socket.current.connected) join();
    socket.current.on('connect', join);
    return () => { socket.current?.off('connect', join); socket.current?.emit('leave-room'); };
  }, [roomCode, removed]);
  useEffect(() => { if (removed) setJoined(false); }, [removed]);

  const emit = (event: string, payload?: unknown) => socket.current?.emit(event, payload);
  const emitAck = <T = any>(event: string, payload?: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      const s = socket.current;
      if (!s) return reject(new Error('Not connected'));
      const timer = setTimeout(() => reject(new Error('Request timed out')), ACK_TIMEOUT);
      s.emit(event, payload, (ack: any) => { clearTimeout(timer); if (ack?.ok) resolve(ack); else reject(new Error(ack?.error || 'Request failed')); });
    });

  return { socket: instance, connected, joined, reconnecting, fatalError: removed ?? fatalError, removed: !!removed, emit, emitAck };
}
