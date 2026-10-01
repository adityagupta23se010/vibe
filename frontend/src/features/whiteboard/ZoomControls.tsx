import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Map as MapIcon, Maximize, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { boundsOf, unionBBox, visibleWorldRect } from './geometry';
import type { WhiteboardBoard } from './useWhiteboardBoard';
import type { WhiteboardObject } from './types';

export function ZoomControls({ board }: { board: WhiteboardBoard }) {
  const [zoomLabel, setZoomLabel] = useState(100);
  useEffect(() => { const id = setInterval(() => setZoomLabel(Math.round(board.cameraRef.current.zoom * 100)), 150); return () => clearInterval(id); }, [board]);
  return (
    <div className="flex items-center gap-0.5 rounded-lg border bg-card p-1 shadow-sm">
      <Button variant="ghost" size="icon" className="size-7" aria-label="Zoom out" onClick={() => board.zoomTo(board.cameraRef.current.zoom / 1.2)}><Minus size={14} /></Button>
      <button type="button" className="w-12 text-center text-xs tabular-nums hover:underline" onClick={board.resetZoom}>{zoomLabel}%</button>
      <Button variant="ghost" size="icon" className="size-7" aria-label="Zoom in" onClick={() => board.zoomTo(board.cameraRef.current.zoom * 1.2)}><Plus size={14} /></Button>
      <div className="mx-1 h-5 w-px bg-border" />
      <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={board.fitToContent}><Maximize size={13} /> Fit</Button>
    </div>
  );
}

export function Minimap({ board }: { board: WhiteboardBoard }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const W = 180, H = 120;

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      if (canvas && !collapsed) {
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(100,116,139,0.1)';
        ctx.fillRect(0, 0, W, H);
        const objects = board.allObjects();
        const bbox = objects.length ? unionBBox(objects.map(boundsOf)) : null;
        if (bbox) {
          const pad = 20;
          const w = Math.max(1, bbox.maxX - bbox.minX), h = Math.max(1, bbox.maxY - bbox.minY);
          const scale = Math.min((W - pad) / w, (H - pad) / h);
          const ox = W / 2 - ((bbox.minX + bbox.maxX) / 2) * scale;
          const oy = H / 2 - ((bbox.minY + bbox.maxY) / 2) * scale;
          ctx.save();
          ctx.setTransform(scale, 0, 0, scale, ox, oy);
          objects.forEach(object => drawMinimapObject(ctx, object, 1 / scale));
          ctx.restore();
          const viewport = visibleWorldRect(board.cameraRef.current, board.viewportSizeRef.current.width, board.viewportSizeRef.current.height);
          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(viewport.minX * scale + ox, viewport.minY * scale + oy, (viewport.maxX - viewport.minX) * scale, (viewport.maxY - viewport.minY) * scale);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [board, collapsed]);

  return (
    <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <button type="button" onClick={() => setCollapsed(v => !v)} className="flex w-full items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50">
        <span className="flex items-center gap-1"><MapIcon size={12} /> Minimap</span>
        {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {!collapsed && <canvas ref={canvasRef} width={W} height={H} style={{ width: W, height: H }} />}
    </div>
  );
}

/** A cheap, low-fidelity rendering of a real object's shape (not just its bounding box) for the minimap — same silhouette and color, constant hairline width so it stays visible at any zoom. */
function drawMinimapObject(ctx: CanvasRenderingContext2D, object: WhiteboardObject, lineWidth: number) {
  ctx.strokeStyle = object.style.color;
  ctx.fillStyle = object.style.color;
  ctx.lineWidth = lineWidth;
  switch (object.type) {
    case 'stroke': {
      if (object.points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(object.points[0].x, object.points[0].y);
      object.points.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.stroke();
      break;
    }
    case 'line':
    case 'arrow': {
      ctx.beginPath();
      ctx.moveTo(object.x1, object.y1);
      ctx.lineTo(object.x2, object.y2);
      ctx.stroke();
      break;
    }
    case 'rectangle':
      ctx.strokeRect(object.x, object.y, object.width, object.height);
      break;
    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(object.x + object.width / 2, object.y + object.height / 2, Math.abs(object.width) / 2, Math.abs(object.height) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'text':
      ctx.fillRect(object.x, object.y, object.width, object.fontSize);
      break;
  }
}
