import { useCallback, useEffect, useRef, useState } from 'react';
import { whiteboardApi } from './api';
import { MAX_ZOOM, MIN_ZOOM, boundsOf, decimate, unionBBox } from './geometry';
import type { BoardSession, Camera, Point, Presence, RemoteCursor, Style, Tool, WhiteboardObject, WhiteboardRole } from './types';
import { useUndoRedo } from './useUndoRedo';
import { useWhiteboardSocket } from './useWhiteboardSocket';

const CURSOR_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];
export function colorForUser(userId: string) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

const uuid = () => crypto.randomUUID();
const CURSOR_STALE_MS = 8000;

export function useWhiteboardBoard(roomCode: string | undefined) {
  const selfIdRef = useRef<string | undefined>(undefined);
  const [selfId, setSelfId] = useState<string | undefined>(undefined);
  const objectsRef = useRef<Map<string, WhiteboardObject>>(new Map());
  const cameraRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const cursorsRef = useRef<Map<string, RemoteCursor>>(new Map());
  const liveObjectsRef = useRef<Map<string, WhiteboardObject>>(new Map());
  const selectionRef = useRef<Set<string>>(new Set());
  const viewportSizeRef = useRef({ width: 800, height: 600 });

  const [renderVersion, setRenderVersion] = useState(0);
  const bump = useCallback(() => setRenderVersion(v => v + 1), []);

  const [session, setSession] = useState<BoardSession | null>(null);
  const [role, setRoleState] = useState<WhiteboardRole>('viewer');
  const [isCreator, setIsCreator] = useState(false);
  const [participants, setParticipants] = useState<Presence[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'pending'>('saved');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#111827');
  const [strokeWidth, setStrokeWidth] = useState(4);

  const history = useUndoRedo();
  const isEditor = role === 'editor';

  const setSelection = useCallback((ids: string[]) => { selectionRef.current = new Set(ids); setSelectedIds(ids); bump(); }, [bump]);

  const applyRemote = {
    created: (object: WhiteboardObject) => { objectsRef.current.set(object.id, object); liveObjectsRef.current.delete(object.id); bump(); },
    updated: (object: WhiteboardObject) => { objectsRef.current.set(object.id, object); bump(); },
    deleted: ({ id }: { id: string }) => { objectsRef.current.delete(id); liveObjectsRef.current.delete(id); selectionRef.current.delete(id); setSelectedIds([...selectionRef.current]); bump(); },
  };

  const pruneCursors = useCallback(() => {
    const now = Date.now();
    let changed = false;
    cursorsRef.current.forEach((cursor, id) => { if (now - cursor.updatedAt > CURSOR_STALE_MS) { cursorsRef.current.delete(id); changed = true; } });
    if (changed) bump();
  }, [bump]);
  useEffect(() => { const timer = setInterval(pruneCursors, 3000); return () => clearInterval(timer); }, [pruneCursors]);

  const socket = useWhiteboardSocket({
    roomCode,
    onJoined: payload => {
      objectsRef.current = new Map(payload.objects.map(o => [o.id, o]));
      setSession(payload.session);
      setRoleState(payload.role);
      setIsCreator(payload.isCreator);
      selfIdRef.current = payload.userId;
      setSelfId(payload.userId);
      setLoading(false);
      bump();
    },
    onObjectCreated: applyRemote.created,
    onObjectUpdated: applyRemote.updated,
    onObjectDeleted: applyRemote.deleted,
    onStrokeLive: payload => { liveObjectsRef.current.set(payload.id, payload); bump(); },
    // Don't clear the live preview immediately — the persisted object:created
    // (same id) hasn't necessarily arrived yet (it's a separate, slower,
    // ack-based round trip), and clearing eagerly here causes the stroke to
    // visibly vanish and then pop back in once the persisted copy lands.
    // Let object:created/updated naturally replace it; this is only a
    // fallback for the rare case the create never lands (e.g. rejected).
    onStrokeLiveEnd: ({ id }) => {
      setTimeout(() => {
        if (liveObjectsRef.current.has(id) && !objectsRef.current.has(id)) { liveObjectsRef.current.delete(id); bump(); }
      }, 4000);
    },
    onObjectPreview: ({ id, patch }) => { const existing = objectsRef.current.get(id) || liveObjectsRef.current.get(id); if (existing) { liveObjectsRef.current.set(id, { ...existing, ...patch } as WhiteboardObject); bump(); } },
    onCursorMove: ({ userId, x, y }) => { if (userId === selfIdRef.current) return; cursorsRef.current.set(userId, { userId, x, y, color: colorForUser(userId), updatedAt: Date.now(), name: cursorsRef.current.get(userId)?.name }); bump(); },
    onCursorRemove: ({ userId }) => { cursorsRef.current.delete(userId); bump(); },
    onPresence: people => { setParticipants(people); people.forEach(p => { const c = cursorsRef.current.get(p.userId); if (c) c.name = p.name; }); },
    onPermissionsChanged: ({ userId, role: nextRole }) => {
      if (userId === selfIdRef.current) setRoleState(nextRole);
      setSession(prev => {
        if (!prev) return prev;
        const exists = prev.participants.some(p => p.userId === userId);
        const participants = exists
          ? prev.participants.map(p => (p.userId === userId ? { ...p, role: nextRole } : p))
          : [...prev.participants, { userId, role: nextRole, joinedAt: new Date().toISOString() }];
        return { ...prev, participants };
      });
    },
    // Keeps every connected client's view of who-has-what-role current even
    // when someone else joins after they did — otherwise the creator's
    // role dropdown shows nothing (or a stale default) for later joiners,
    // since session.participants was only ever sent to the joiner itself.
    onParticipants: participants => setSession(prev => (prev ? { ...prev, participants } : prev)),
    onDefaultRoleChanged: ({ role }) => setSession(prev => (prev ? { ...prev, defaultRole: role } : prev)),
    onClear: () => { objectsRef.current.clear(); liveObjectsRef.current.clear(); setSelection([]); bump(); },
    onError: message => setLoadError(message),
  });

  useEffect(() => {
    if (!roomCode) return;
    setLoading(true);
    setLoadError(undefined);
    whiteboardApi.load(roomCode).catch(() => setLoadError('Unable to load this whiteboard.'));
  }, [roomCode]);

  const style = useCallback((): Style => ({ color, strokeWidth }), [color, strokeWidth]);

  const createObject = useCallback(async (object: WhiteboardObject, opts: { recordHistory?: boolean } = { recordHistory: true }) => {
    objectsRef.current.set(object.id, object);
    bump();
    setSaveState('saving');
    try {
      await socket.emitAck('object:create', object);
      setSaveState('saved');
      if (opts.recordHistory !== false) {
        history.push({ undo: () => void deleteObject(object.id, false), redo: () => void createObject(object, { recordHistory: false }) });
      }
    } catch { objectsRef.current.delete(object.id); bump(); setSaveState('pending'); }
  }, [socket]);

  const updateObject = useCallback(async (id: string, patch: Partial<WhiteboardObject>, before?: WhiteboardObject, recordHistory = true) => {
    const existing = objectsRef.current.get(id);
    if (!existing) return;
    const prior = before ?? { ...existing };
    const next = { ...existing, ...patch } as WhiteboardObject;
    objectsRef.current.set(id, next);
    bump();
    setSaveState('saving');
    try {
      await socket.emitAck('object:update', { id, patch });
      setSaveState('saved');
      if (recordHistory) history.push({ undo: () => void updateObject(id, prior, next, false), redo: () => void updateObject(id, patch, prior, false) });
    } catch { objectsRef.current.set(id, existing); bump(); setSaveState('pending'); }
  }, [socket]);

  const deleteObject = useCallback(async (id: string, recordHistory = true) => {
    const existing = objectsRef.current.get(id);
    if (!existing) return;
    objectsRef.current.delete(id);
    selectionRef.current.delete(id);
    setSelectedIds([...selectionRef.current]);
    bump();
    try {
      await socket.emitAck('object:delete', { id });
      if (recordHistory) history.push({ undo: () => void createObject(existing, { recordHistory: false }), redo: () => void deleteObject(id, false) });
    } catch { objectsRef.current.set(id, existing); bump(); }
  }, [socket, createObject]);

  const previewPatch = useCallback((id: string, patch: Record<string, unknown>) => {
    const existing = objectsRef.current.get(id);
    if (!existing) return;
    objectsRef.current.set(id, { ...existing, ...patch } as WhiteboardObject);
    bump();
    socket.emit('object:preview', { id, patch });
  }, [socket]);

  const sendLiveStroke = useCallback((object: WhiteboardObject) => socket.emit('stroke:live', object), [socket]);
  const endLiveStroke = useCallback((id: string) => socket.emit('stroke:live-end', { id }), [socket]);
  const sendCursor = useCallback((point: Point) => socket.emit('cursor:move', point), [socket]);
  const clearCursor = useCallback(() => socket.emit('cursor:remove'), [socket]);

  const deleteSelected = useCallback(() => { [...selectionRef.current].forEach(id => void deleteObject(id)); }, [deleteObject]);
  const clearBoard = useCallback(async () => { await socket.emit('board:clear'); history.reset(); }, [socket, history]);
  const setParticipantRole = useCallback((userId: string, nextRole: WhiteboardRole) => socket.emit('participant:setRole', { userId, role: nextRole }), [socket]);
  const setDefaultRole = useCallback((nextRole: WhiteboardRole) => socket.emit('room:setDefaultRole', { role: nextRole }), [socket]);
  const renameBoard = useCallback(async (name: string) => { if (!roomCode) return; await whiteboardApi.rename(roomCode, name); setSession(prev => prev ? { ...prev, name } : prev); }, [roomCode]);

  const allObjects = useCallback(() => {
    const merged = new Map(objectsRef.current);
    liveObjectsRef.current.forEach((object, id) => merged.set(id, object));
    return [...merged.values()];
  }, []);

  const contentBounds = useCallback(() => {
    const boxes = [...objectsRef.current.values()].map(boundsOf);
    return boxes.length ? boxes : null;
  }, []);

  const zoomTo = useCallback((nextZoom: number) => {
    const { width, height } = viewportSizeRef.current;
    const cx = width / 2, cy = height / 2;
    const worldCenter = { x: (cx - cameraRef.current.x) / cameraRef.current.zoom, y: (cy - cameraRef.current.y) / cameraRef.current.zoom };
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    cameraRef.current = { zoom, x: cx - worldCenter.x * zoom, y: cy - worldCenter.y * zoom };
    bump();
  }, [bump]);

  const resetZoom = useCallback(() => zoomTo(1), [zoomTo]);

  const fitToContent = useCallback(() => {
    const boxes = contentBounds();
    const bbox = boxes ? unionBBox(boxes) : null;
    const { width, height } = viewportSizeRef.current;
    if (!bbox) { cameraRef.current = { x: width / 2, y: height / 2, zoom: 1 }; bump(); return; }
    const padding = 80;
    const contentWidth = Math.max(1, bbox.maxX - bbox.minX);
    const contentHeight = Math.max(1, bbox.maxY - bbox.minY);
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((width - padding * 2) / contentWidth, (height - padding * 2) / contentHeight)));
    const cx = (bbox.minX + bbox.maxX) / 2, cy = (bbox.minY + bbox.maxY) / 2;
    cameraRef.current = { zoom, x: width / 2 - cx * zoom, y: height / 2 - cy * zoom };
    bump();
  }, [contentBounds, bump]);

  return {
    objectsRef, cameraRef, cursorsRef, liveObjectsRef, selectionRef, viewportSizeRef, renderVersion, allObjects, contentBounds,
    zoomTo, resetZoom, fitToContent,
    session, role, isEditor, isCreator, participants, selfId, loading, loadError: loadError ?? socket.fatalError,
    connected: socket.connected, joined: socket.joined, reconnecting: socket.reconnecting, saveState,
    tool, setTool, color, setColor, strokeWidth, setStrokeWidth,
    selectedIds, setSelection,
    createObject, updateObject, deleteObject, deleteSelected, previewPatch,
    sendLiveStroke, endLiveStroke, sendCursor, clearCursor,
    clearBoard, setParticipantRole, setDefaultRole, renameBoard,
    undo: history.undo, redo: history.redo, canUndo: history.canUndo, canRedo: history.canRedo,
    style, uuid,
    decimatePoints: decimate,
    bump,
  };
}
export type WhiteboardBoard = ReturnType<typeof useWhiteboardBoard>;
