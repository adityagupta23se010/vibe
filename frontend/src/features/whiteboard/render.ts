import { boundsOf, strokePath } from './geometry';
import type { Camera, WhiteboardObject } from './types';

// The drawing surface is always a plain white sheet, like a real whiteboard —
// it deliberately ignores the app's light/dark theme so strokes (many of
// which default to dark ink) stay legible and consistent for every viewer.
export function drawGrid(ctx: CanvasRenderingContext2D, camera: Camera, width: number, height: number, ratio = 1) {
  ctx.save();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  const step = pickGridStep(camera.zoom);
  const screenStep = step * camera.zoom;
  if (screenStep > 6) {
    ctx.strokeStyle = 'rgba(15,23,42,0.08)';
    ctx.lineWidth = 1;
    const offsetX = camera.x % screenStep;
    const offsetY = camera.y % screenStep;
    ctx.beginPath();
    for (let x = offsetX; x < width; x += screenStep) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
    for (let y = offsetY; y < height; y += screenStep) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
    ctx.stroke();
  }
  ctx.restore();
}
function pickGridStep(zoom: number) {
  const target = 64;
  let step = 10;
  while (step * zoom < target) step *= 2;
  while (step * zoom > target * 4) step /= 2;
  return step;
}

export function drawObject(ctx: CanvasRenderingContext2D, object: WhiteboardObject) {
  ctx.save();
  ctx.strokeStyle = object.style.color;
  ctx.lineWidth = object.style.strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (object.style.fill) ctx.fillStyle = object.style.fill;
  switch (object.type) {
    case 'stroke': {
      ctx.beginPath();
      strokePath(ctx, object.points);
      ctx.stroke();
      break;
    }
    case 'line': {
      ctx.beginPath();
      ctx.moveTo(object.x1, object.y1);
      ctx.lineTo(object.x2, object.y2);
      ctx.stroke();
      break;
    }
    case 'arrow': {
      drawArrow(ctx, object.x1, object.y1, object.x2, object.y2, object.style.strokeWidth);
      break;
    }
    case 'rectangle': {
      ctx.beginPath();
      ctx.rect(object.x, object.y, object.width, object.height);
      if (object.style.fill) ctx.fill();
      ctx.stroke();
      break;
    }
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse(object.x + object.width / 2, object.y + object.height / 2, Math.abs(object.width) / 2, Math.abs(object.height) / 2, 0, 0, Math.PI * 2);
      if (object.style.fill) ctx.fill();
      ctx.stroke();
      break;
    }
    case 'text': {
      ctx.fillStyle = object.style.color;
      ctx.font = `${object.fontSize}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      const lines = object.text.split('\n');
      lines.forEach((line, i) => ctx.fillText(line, object.x, object.y + i * object.fontSize * 1.3));
      break;
    }
  }
  ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, width: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.max(10, width * 3);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 7), y2 - headLen * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 7), y2 - headLen * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle as string;
  ctx.fill();
}

export function drawSelectionBox(ctx: CanvasRenderingContext2D, objects: WhiteboardObject[], accent: string) {
  objects.forEach(object => {
    const b = boundsOf(object);
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5 / (ctx.getTransform().a || 1);
    ctx.setLineDash([6 / (ctx.getTransform().a || 1), 4 / (ctx.getTransform().a || 1)]);
    ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    ctx.restore();
  });
}

export function drawMarquee(ctx: CanvasRenderingContext2D, camera: Camera, start: { x: number; y: number }, end: { x: number; y: number }, ratio = 1) {
  ctx.save();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const sx = start.x * camera.zoom + camera.x, sy = start.y * camera.zoom + camera.y;
  const ex = end.x * camera.zoom + camera.x, ey = end.y * camera.zoom + camera.y;
  ctx.fillStyle = 'rgba(59,130,246,0.12)';
  ctx.strokeStyle = 'rgba(59,130,246,0.6)';
  ctx.lineWidth = 1;
  const x = Math.min(sx, ex), y = Math.min(sy, ey);
  ctx.fillRect(x, y, Math.abs(ex - sx), Math.abs(ey - sy));
  ctx.strokeRect(x, y, Math.abs(ex - sx), Math.abs(ey - sy));
  ctx.restore();
}
