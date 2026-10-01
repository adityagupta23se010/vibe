import { useCallback, useEffect, useRef, useState } from 'react';
import { bboxContainsPoint, bboxIntersects, boundsOf, screenToWorld, visibleWorldRect, worldToScreen, zoomAround } from './geometry';
import { drawGrid, drawMarquee, drawObject, drawSelectionBox } from './render';
import type { Point, WhiteboardObject } from './types';
import type { WhiteboardBoard } from './useWhiteboardBoard';

type DragMode = 'draw' | 'pan' | 'move' | 'marquee' | 'resize' | 'erase' | null;
type TextEdit = { id?: string; worldX: number; worldY: number; value: string; fontSize: number; color: string };

function hitTest(objects: WhiteboardObject[], x: number, y: number): WhiteboardObject | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    if (bboxContainsPoint(boundsOf(objects[i]), x, y)) return objects[i];
  }
  return null;
}

export function CanvasStage({ board }: { board: WhiteboardBoard }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragMode = useRef<DragMode>(null);
  const dragStart = useRef<Point>({ x: 0, y: 0 });
  const dragOrigCamera = useRef({ x: 0, y: 0 });
  const dragObjectOrigin = useRef<Map<string, WhiteboardObject>>(new Map());
  const draftId = useRef<string | null>(null);
  const draftPoints = useRef<Point[]>([]);
  const marqueeEnd = useRef<Point | null>(null);
  const spaceHeld = useRef(false);
  const lastCursorEmit = useRef(0);
  const erasedThisStroke = useRef<Set<string>>(new Set());
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);

  const { objectsRef, cameraRef, cursorsRef, selectionRef, allObjects, tool, setTool, isEditor } = board;

  // ---- render loop -------------------------------------------------------
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (canvas && container) {
        const ratio = window.devicePixelRatio || 1;
        const rect = container.getBoundingClientRect();
        if (canvas.width !== rect.width * ratio || canvas.height !== rect.height * ratio) {
          canvas.width = rect.width * ratio;
          canvas.height = rect.height * ratio;
        }
        board.viewportSizeRef.current = { width: rect.width, height: rect.height };
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        drawGrid(ctx, cameraRef.current, rect.width, rect.height, ratio);
        ctx.setTransform(cameraRef.current.zoom * ratio, 0, 0, cameraRef.current.zoom * ratio, cameraRef.current.x * ratio, cameraRef.current.y * ratio);

        const visible = visibleWorldRect(cameraRef.current, rect.width, rect.height);
        const objects = allObjects();
        objects.forEach(object => { if (bboxIntersects(boundsOf(object), visible)) drawObject(ctx, object); });
        const selected = objects.filter(o => selectionRef.current.has(o.id));
        if (selected.length) drawSelectionBox(ctx, selected, '#3b82f6');

        if (dragMode.current === 'marquee' && marqueeEnd.current) drawMarquee(ctx, cameraRef.current, dragStart.current, marqueeEnd.current, ratio);

        // remote cursors in screen space
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        cursorsRef.current.forEach(cursor => {
          const screen = worldToScreen(cameraRef.current, cursor.x, cursor.y);
          ctx.save();
          ctx.fillStyle = cursor.color;
          ctx.beginPath();
          ctx.arc(screen.x, screen.y, 4, 0, Math.PI * 2);
          ctx.fill();
          if (cursor.name) {
            ctx.font = '11px system-ui, sans-serif';
            const label = cursor.name;
            const w = ctx.measureText(label).width;
            ctx.fillStyle = cursor.color;
            ctx.fillRect(screen.x + 6, screen.y - 8, w + 8, 16);
            ctx.fillStyle = '#fff';
            ctx.fillText(label, screen.x + 10, screen.y + 4);
          }
          ctx.restore();
        });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [allObjects, cameraRef, cursorsRef, selectionRef]);

  // ---- pointer handling ---------------------------------------------------
  const toWorld = useCallback((event: React.PointerEvent): Point => {
    const rect = containerRef.current!.getBoundingClientRect();
    return screenToWorld(cameraRef.current, event.clientX - rect.left, event.clientY - rect.top);
  }, [cameraRef]);

  const beginDraw = (world: Point) => {
    const id = board.uuid();
    draftId.current = id;
    if (tool === 'pen') {
      draftPoints.current = [world];
      const object: WhiteboardObject = { id, type: 'stroke', points: [world], style: board.style() } as any;
      objectsRef.current.set(id, object);
    } else if (tool === 'line' || tool === 'arrow') {
      objectsRef.current.set(id, { id, type: tool, x1: world.x, y1: world.y, x2: world.x, y2: world.y, style: board.style() } as any);
    } else if (tool === 'rectangle' || tool === 'ellipse') {
      objectsRef.current.set(id, { id, type: tool, x: world.x, y: world.y, width: 0, height: 0, style: board.style() } as any);
    }
    board.bump();
  };

  const onPointerDown = (event: React.PointerEvent) => {
    const world = toWorld(event);
    dragStart.current = world;
    dragOrigCamera.current = { ...cameraRef.current };

    // Text is a single click-to-place action with no drag to track, and
    // capturing the pointer on a non-focusable canvas forces the newly
    // mounted (auto-focused) editor to immediately blur itself on release —
    // so skip capture entirely for this tool.
    if (tool !== 'text') (event.target as Element).setPointerCapture(event.pointerId);

    const wantsPan = tool === 'hand' || event.button === 1 || spaceHeld.current;
    if (wantsPan) { dragMode.current = 'pan'; return; }

    if (!isEditor && tool !== 'select') return;

    if (tool === 'select') {
      const objects = allObjects();
      const hit = hitTest(objects, world.x, world.y);
      if (hit) {
        if (!selectionRef.current.has(hit.id)) board.setSelection(event.shiftKey ? [...selectionRef.current, hit.id] : [hit.id]);
        // Viewers may select (to inspect) but never move.
        if (!isEditor) return;
        dragMode.current = 'move';
        dragObjectOrigin.current = new Map([...selectionRef.current].map(id => [id, { ...(objectsRef.current.get(id) as WhiteboardObject) }]));
      } else {
        if (!event.shiftKey) board.setSelection([]);
        dragMode.current = 'marquee';
        marqueeEnd.current = world;
      }
      return;
    }
    if (tool === 'eraser') { dragMode.current = 'erase'; erasedThisStroke.current = new Set(); eraseAt(world); return; }
    if (tool === 'text') { setTextEdit({ worldX: world.x, worldY: world.y, value: '', fontSize: Math.max(16, board.strokeWidth * 4), color: board.color }); return; }
    dragMode.current = 'draw';
    beginDraw(world);
  };

  const eraseAt = (world: Point) => {
    const hit = hitTest(allObjects(), world.x, world.y);
    if (hit && !erasedThisStroke.current.has(hit.id)) { erasedThisStroke.current.add(hit.id); void board.deleteObject(hit.id); }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const world = toWorld(event);
    const now = performance.now();
    if (now - lastCursorEmit.current > 40) { lastCursorEmit.current = now; board.sendCursor(world); }

    if (dragMode.current === 'pan') {
      const dx = (world.x - dragStart.current.x) * cameraRef.current.zoom;
      const dy = (world.y - dragStart.current.y) * cameraRef.current.zoom;
      cameraRef.current = { ...cameraRef.current, x: cameraRef.current.x + dx, y: cameraRef.current.y + dy };
      return;
    }
    if (dragMode.current === 'erase') { eraseAt(world); return; }
    if (dragMode.current === 'marquee') { marqueeEnd.current = world; board.bump(); return; }
    if (dragMode.current === 'move') {
      const dx = world.x - dragStart.current.x, dy = world.y - dragStart.current.y;
      dragObjectOrigin.current.forEach((orig, id) => board.previewPatch(id, translate(orig, dx, dy)));
      return;
    }
    if (dragMode.current === 'draw' && draftId.current) {
      const id = draftId.current;
      const existing = objectsRef.current.get(id);
      if (!existing) return;
      if (tool === 'pen') {
        draftPoints.current.push(world);
        objectsRef.current.set(id, { ...existing, points: [...draftPoints.current] } as any);
        board.sendLiveStroke(objectsRef.current.get(id)!);
      } else if (tool === 'line' || tool === 'arrow') {
        objectsRef.current.set(id, { ...existing, x2: world.x, y2: world.y } as any);
        board.sendLiveStroke(objectsRef.current.get(id)!);
      } else if (tool === 'rectangle' || tool === 'ellipse') {
        const base = existing as any;
        objectsRef.current.set(id, { ...existing, width: world.x - base.x, height: world.y - base.y } as any);
        board.sendLiveStroke(objectsRef.current.get(id)!);
      }
      board.bump();
    }
  };

  const onPointerUp = () => {
    if (dragMode.current === 'move') {
      dragObjectOrigin.current.forEach((orig, id) => { const current = objectsRef.current.get(id); if (current) void board.updateObject(id, diffPatch(orig, current), orig); });
      dragObjectOrigin.current = new Map();
    } else if (dragMode.current === 'marquee' && marqueeEnd.current) {
      const box = { minX: Math.min(dragStart.current.x, marqueeEnd.current.x), minY: Math.min(dragStart.current.y, marqueeEnd.current.y), maxX: Math.max(dragStart.current.x, marqueeEnd.current.x), maxY: Math.max(dragStart.current.y, marqueeEnd.current.y) };
      const ids = allObjects().filter(o => bboxIntersects(boundsOf(o), box)).map(o => o.id);
      board.setSelection(ids);
      marqueeEnd.current = null;
    } else if (dragMode.current === 'draw' && draftId.current) {
      const id = draftId.current;
      const object = objectsRef.current.get(id);
      objectsRef.current.delete(id);
      board.endLiveStroke(id);
      if (object && isMeaningful(object)) {
        const points = object.type === 'stroke' ? board.decimatePoints(object.points) : undefined;
        void board.createObject(points ? { ...object, points } as any : object);
      }
    }
    dragMode.current = null;
    draftId.current = null;
    board.bump();
  };

  const onWheel = (event: React.WheelEvent) => {
    event.preventDefault();
    const rect = containerRef.current!.getBoundingClientRect();
    const sx = event.clientX - rect.left, sy = event.clientY - rect.top;
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * 0.01);
      cameraRef.current = zoomAround(cameraRef.current, sx, sy, cameraRef.current.zoom * factor);
    } else {
      cameraRef.current = { ...cameraRef.current, x: cameraRef.current.x - event.deltaX, y: cameraRef.current.y - event.deltaY };
    }
  };

  // ---- keyboard shortcuts --------------------------------------------------
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      if (event.code === 'Space') spaceHeld.current = true;
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) board.redo(); else board.undo(); return; }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectionRef.current.size && isEditor) { event.preventDefault(); board.deleteSelected(); return; }
      if (event.key === 'Escape') { board.setSelection([]); setTextEdit(null); return; }
      const map: Record<string, typeof tool> = { v: 'select', h: 'hand', p: 'pen', e: 'eraser', t: 'text', r: 'rectangle', o: 'ellipse', l: 'line', a: 'arrow' };
      if (!mod && map[event.key.toLowerCase()]) setTool(map[event.key.toLowerCase()]!);
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === 'Space') spaceHeld.current = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); };
  }, [board, setTool, selectionRef]);

  const commitText = () => {
    if (!textEdit) return;
    const value = textEdit.value.trim();
    setTextEdit(null);
    if (!value) return;
    if (textEdit.id) { void board.updateObject(textEdit.id, { text: value } as any); }
    else { void board.createObject({ id: board.uuid(), type: 'text', x: textEdit.worldX, y: textEdit.worldY, width: Math.max(120, value.length * textEdit.fontSize * 0.6), text: value, fontSize: textEdit.fontSize, style: { color: textEdit.color, strokeWidth: 1 } } as any); }
  };

  const textScreen = textEdit ? worldToScreen(cameraRef.current, textEdit.worldX, textEdit.worldY) : null;

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden touch-none select-none">
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        style={{ cursor: tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={board.clearCursor}
        onWheel={onWheel}
        onDoubleClick={event => {
          if (tool !== 'select') return;
          const rect = containerRef.current!.getBoundingClientRect();
          const world = screenToWorld(cameraRef.current, event.clientX - rect.left, event.clientY - rect.top);
          const hit = hitTest(allObjects(), world.x, world.y);
          if (hit?.type === 'text') setTextEdit({ id: hit.id, worldX: hit.x, worldY: hit.y, value: hit.text, fontSize: hit.fontSize, color: hit.style.color });
        }}
      />
      {textEdit && textScreen && (
        <textarea
          autoFocus
          value={textEdit.value}
          onChange={e => setTextEdit({ ...textEdit, value: e.target.value })}
          onBlur={commitText}
          onKeyDown={e => { if (e.key === 'Escape') { setTextEdit(null); } if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitText(); } }}
          style={{ position: 'absolute', left: textScreen.x, top: textScreen.y, fontSize: textEdit.fontSize * cameraRef.current.zoom, color: textEdit.color, minWidth: 120 }}
          className="rounded border border-blue-400 bg-white/90 p-1 leading-tight outline-none"
        />
      )}
    </div>
  );
}

function translate(object: WhiteboardObject, dx: number, dy: number): Record<string, unknown> {
  switch (object.type) {
    case 'stroke': return { points: object.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
    case 'line': case 'arrow': return { x1: object.x1 + dx, y1: object.y1 + dy, x2: object.x2 + dx, y2: object.y2 + dy };
    case 'rectangle': case 'ellipse': return { x: object.x + dx, y: object.y + dy };
    case 'text': return { x: object.x + dx, y: object.y + dy };
  }
}
function diffPatch(before: WhiteboardObject, after: WhiteboardObject): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  Object.keys(after).forEach(key => { if (JSON.stringify((after as any)[key]) !== JSON.stringify((before as any)[key])) patch[key] = (after as any)[key]; });
  return patch;
}
function isMeaningful(object: WhiteboardObject): boolean {
  if (object.type === 'stroke') return object.points.length > 1;
  if (object.type === 'line' || object.type === 'arrow') return Math.hypot(object.x2 - object.x1, object.y2 - object.y1) > 2;
  if (object.type === 'rectangle' || object.type === 'ellipse') return Math.abs(object.width) > 2 && Math.abs(object.height) > 2;
  return true;
}
