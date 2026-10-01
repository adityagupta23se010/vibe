import type { Camera, Point, WhiteboardObject } from './types';

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

export function screenToWorld(camera: Camera, sx: number, sy: number): Point {
  return { x: (sx - camera.x) / camera.zoom, y: (sy - camera.y) / camera.zoom };
}
export function worldToScreen(camera: Camera, wx: number, wy: number): Point {
  return { x: wx * camera.zoom + camera.x, y: wy * camera.zoom + camera.y };
}

/** Camera-space transform to apply to a 2D context so world coordinates can be drawn directly. */
export function applyCameraTransform(ctx: CanvasRenderingContext2D, camera: Camera) {
  ctx.setTransform(camera.zoom, 0, 0, camera.zoom, camera.x, camera.y);
}

export function zoomAround(camera: Camera, screenX: number, screenY: number, nextZoom: number): Camera {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
  const worldBefore = screenToWorld(camera, screenX, screenY);
  const x = screenX - worldBefore.x * zoom;
  const y = screenY - worldBefore.y * zoom;
  return { x, y, zoom };
}

export type BBox = { minX: number; minY: number; maxX: number; maxY: number };

export function boundsOf(object: WhiteboardObject): BBox {
  switch (object.type) {
    case 'stroke': {
      const pad = object.style.strokeWidth;
      const xs = object.points.map(p => p.x);
      const ys = object.points.map(p => p.y);
      return { minX: Math.min(...xs) - pad, minY: Math.min(...ys) - pad, maxX: Math.max(...xs) + pad, maxY: Math.max(...ys) + pad };
    }
    case 'line':
    case 'arrow': {
      const pad = object.style.strokeWidth + 6;
      return { minX: Math.min(object.x1, object.x2) - pad, minY: Math.min(object.y1, object.y2) - pad, maxX: Math.max(object.x1, object.x2) + pad, maxY: Math.max(object.y1, object.y2) + pad };
    }
    case 'rectangle':
    case 'ellipse': {
      const pad = object.style.strokeWidth;
      return { minX: Math.min(object.x, object.x + object.width) - pad, minY: Math.min(object.y, object.y + object.height) - pad, maxX: Math.max(object.x, object.x + object.width) + pad, maxY: Math.max(object.y, object.y + object.height) + pad };
    }
    case 'text':
      return { minX: object.x, minY: object.y, maxX: object.x + object.width, maxY: object.y + object.fontSize * 1.4 };
  }
}

export function bboxIntersects(a: BBox, b: BBox) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
export function bboxContainsPoint(b: BBox, x: number, y: number, pad = 4) {
  return x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;
}
export function unionBBox(boxes: BBox[]): BBox | null {
  if (!boxes.length) return null;
  return {
    minX: Math.min(...boxes.map(b => b.minX)),
    minY: Math.min(...boxes.map(b => b.minY)),
    maxX: Math.max(...boxes.map(b => b.maxX)),
    maxY: Math.max(...boxes.map(b => b.maxY)),
  };
}

export function visibleWorldRect(camera: Camera, width: number, height: number): BBox {
  const topLeft = screenToWorld(camera, 0, 0);
  const bottomRight = screenToWorld(camera, width, height);
  return { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y };
}

/** Smooths a freehand path by drawing quadratic curves through consecutive midpoints — cheap, no extra deps, removes pointer jitter without adding latency. */
export function strokePath(ctx: CanvasRenderingContext2D, points: Point[]) {
  if (points.length < 2) { if (points[0]) { ctx.moveTo(points[0].x, points[0].y); ctx.lineTo(points[0].x + 0.01, points[0].y); } return; }
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
    ctx.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x, last.y);
}

/** Drops points that are closer than `minDist` world-units to the previous kept point, so dense pointermove events don't bloat storage/bandwidth. */
export function decimate(points: Point[], minDist = 1.5): Point[] {
  if (points.length <= 2) return points;
  const kept: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = kept[kept.length - 1];
    const dx = points[i].x - prev.x, dy = points[i].y - prev.y;
    if (dx * dx + dy * dy >= minDist * minDist || i === points.length - 1) kept.push(points[i]);
  }
  return kept;
}
