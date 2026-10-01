import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from '@tanstack/react-router';
import { ArrowLeft, History, Share2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/ui/EmptyState';
import { CanvasStage } from './CanvasStage';
import { Minimap, ZoomControls } from './ZoomControls';
import { ConnectionStatusBadge, ParticipantsPanel, SaveStatus } from './ParticipantsPanel';
import { Toolbar } from './Toolbar';
import { useWhiteboardBoard } from './useWhiteboardBoard';

export default function WhiteboardPage() {
  const { roomCode } = useParams({ strict: false }) as { roomCode: string };
  const { pathname } = useLocation();
  const base = pathname.startsWith('/teacher') ? '/teacher/whiteboard' : '/student/whiteboard';
  const board = useWhiteboardBoard(roomCode);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  useEffect(() => { if (board.session) setNameDraft(board.session.name); }, [board.session?.name]);

  if (board.loadError) {
    return (
      <main className="flex min-h-[70vh] items-center justify-center p-6">
        <EmptyState variant="error" title="Unable to load this whiteboard" description={board.loadError} actionText="Back to whiteboards" onAction={() => window.location.assign(base)} />
      </main>
    );
  }
  if (board.loading) {
    return <main className="flex h-[calc(100vh-2rem)] items-center justify-center"><p className="text-sm text-muted-foreground">Loading whiteboard…</p></main>;
  }

  return (
    <main className="flex h-[calc(100vh-1.5rem)] flex-col gap-2 p-2 sm:p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Link to={base}><Button variant="ghost" size="icon" className="size-8"><ArrowLeft size={16} /></Button></Link>
          {renaming && board.isCreator ? (
            <Input
              autoFocus
              value={nameDraft}
              onChange={e => setNameDraft(e.target.value)}
              onBlur={() => { setRenaming(false); if (nameDraft.trim() && nameDraft !== board.session?.name) void board.renameBoard(nameDraft.trim()); }}
              onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              className="h-8 w-48"
            />
          ) : (
            <button type="button" onClick={() => board.isCreator && setRenaming(true)} className="truncate font-semibold hover:underline" disabled={!board.isCreator}>
              {board.session?.name}
            </button>
          )}
          <ConnectionStatusBadge board={board} />
        </div>
        <div className="flex items-center gap-2">
          <SaveStatus board={board} />
          <ParticipantsPanel board={board} />
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigator.clipboard.writeText(window.location.href)}><Share2 size={14} /> Share</Button>
          <Link to={`${base}/$roomCode/replay`} params={{ roomCode }}>
            <Button variant="outline" size="sm" className="gap-1.5"><History size={14} /> Replay</Button>
          </Link>
          {board.isCreator && (
            <Button variant="outline" size="sm" className="gap-1.5 text-destructive hover:text-destructive" onClick={() => { if (confirm('Clear the entire board? This cannot be undone.')) void board.clearBoard(); }}>
              <Trash2 size={14} /> Clear
            </Button>
          )}
        </div>
      </header>

      {!board.isEditor && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          You have view-only access to this board.
        </div>
      )}

      <Toolbar board={board} />

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-card shadow-sm">
        <CanvasStage board={board} />
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex items-end justify-between px-2">
          <div className="pointer-events-auto"><Minimap board={board} /></div>
          <div className="pointer-events-auto"><ZoomControls board={board} /></div>
        </div>
      </div>
    </main>
  );
}
