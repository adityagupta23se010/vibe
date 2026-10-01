import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from '@tanstack/react-router';
import { ArrowLeft, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { EmptyState } from '@/components/ui/EmptyState';
import { whiteboardApi } from './api';
import { drawGrid, drawObject } from './render';
import { boundsOf, unionBBox } from './geometry';
import type { ActivityEntry, Camera, WhiteboardObject } from './types';

const STEP_MS = 400;

/**
 * Read-only mode that replays the session's activity log in order. It never
 * touches live collaboration state — it loads its own snapshot and renders to
 * a scratch canvas, independent of the live board.
 */
export default function ReplayView() {
  const { roomCode } = useParams({ strict: false }) as { roomCode: string };
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => { whiteboardApi.activity(roomCode).then(data => { setEntries(data); setStep(0); }).catch(() => setError(true)); }, [roomCode]);

  useEffect(() => {
    if (!playing || !entries) return;
    if (step >= entries.length) { setPlaying(false); return; }
    const timer = setTimeout(() => setStep(s => s + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, step, entries]);

  const objectsAtStep = useMemo(() => {
    const map = new Map<string, WhiteboardObject>();
    if (!entries) return map;
    for (let i = 0; i < step; i++) {
      const entry = entries[i];
      if (entry.op === 'delete') { if (entry.objectId === '*') map.clear(); else map.delete(entry.objectId); }
      else if (entry.snapshot) map.set(entry.objectId, entry.snapshot);
    }
    return map;
  }, [entries, step]);

  // Fit once to everything that ever appeared across the whole history (not
  // just the current step) so the camera stays put through playback instead
  // of jumping around as objects come and go.
  const camera: Camera | null = useMemo(() => {
    const container = containerRef.current;
    if (!entries?.length || !container) return null;
    const boxes = entries.filter(e => e.snapshot).map(e => boundsOf(e.snapshot!));
    const bbox = unionBBox(boxes);
    if (!bbox) return null;
    const rect = container.getBoundingClientRect();
    const padding = 80;
    const contentWidth = Math.max(1, bbox.maxX - bbox.minX);
    const contentHeight = Math.max(1, bbox.maxY - bbox.minY);
    const zoom = Math.min(2, Math.max(0.05, Math.min((rect.width - padding * 2) / contentWidth, (rect.height - padding * 2) / contentHeight)));
    const cx = (bbox.minX + bbox.maxX) / 2, cy = (bbox.minY + bbox.maxY) / 2;
    return { zoom, x: rect.width / 2 - cx * zoom, y: rect.height / 2 - cy * zoom };
  }, [entries]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !camera) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawGrid(ctx, camera, rect.width, rect.height, ratio);
    ctx.setTransform(camera.zoom * ratio, 0, 0, camera.zoom * ratio, camera.x * ratio, camera.y * ratio);
    objectsAtStep.forEach(object => drawObject(ctx, object));
  }, [objectsAtStep, camera]);

  const play = () => { if (!entries) return; if (step >= entries.length) setStep(0); setPlaying(true); };

  if (error) return <main className="flex min-h-[70vh] items-center justify-center p-6"><EmptyState variant="error" title="Replay unavailable" description="We couldn't load this board's history." /></main>;

  return (
    <main className="flex h-[calc(100vh-1.5rem)] flex-col gap-2 p-2 sm:p-3">
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="icon" className="size-8" onClick={() => router.history.back()}><ArrowLeft size={16} /></Button>
        <h1 className="font-semibold">Replay</h1>
        <span className="text-xs text-muted-foreground">Read-only — does not affect the live board</span>
      </header>
      <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-card shadow-sm">
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>
      <div className="flex items-center gap-3 rounded-lg border bg-card p-2 shadow-sm">
        <Button variant="outline" size="icon" className="size-8" aria-label={playing ? 'Pause' : 'Play'} onClick={() => (playing ? setPlaying(false) : play())} disabled={!entries?.length}>
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </Button>
        <Slider value={[step]} max={entries?.length ?? 0} step={1} onValueChange={([v]) => { setPlaying(false); setStep(v); }} className="flex-1" />
        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{step}/{entries?.length ?? 0}</span>
      </div>
    </main>
  );
}
