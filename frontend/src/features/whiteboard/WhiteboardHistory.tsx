import { useEffect, useState } from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import { PanelTop, Plus, Share2 } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { whiteboardApi } from './api';
import type { BoardSession } from './types';

export default function WhiteboardHistory() {
  const { pathname } = useLocation();
  const base = pathname.startsWith('/teacher') ? '/teacher/whiteboard' : '/student/whiteboard';
  const [boards, setBoards] = useState<BoardSession[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(false);

  const load = () => whiteboardApi.mine().then(setBoards).catch(() => setError(true));
  useEffect(() => { load(); }, []);

  const create = async () => {
    setCreating(true);
    try {
      const board = await whiteboardApi.create();
      window.location.assign(`${base}/${board.roomCode}`);
    } catch { setCreating(false); setError(true); }
  };

  return (
    <main className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Whiteboard"
        description="Collaborate in real time on an infinite canvas — draw, sketch, and brainstorm together."
        actions={<Button onClick={create} disabled={creating} className="gap-1.5"><Plus size={15} /> New whiteboard</Button>}
      />
      {error && <EmptyState title="Something went wrong" description="We couldn't load your whiteboards. Please try again." variant="error" actionText="Retry" onAction={load} />}
      {!error && boards === null && <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-16 w-full" />)}</div>}
      {!error && boards?.length === 0 && (
        <EmptyState icon={<PanelTop className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />} title="No whiteboards yet" description="Create your first whiteboard to start collaborating." actionText="Create whiteboard" onAction={create} />
      )}
      {!error && boards && boards.length > 0 && (
        <div className="space-y-2">
          {boards.map(board => (
            <Link key={board._id} to={`${base}/$roomCode`} params={{ roomCode: board.roomCode }}>
              <Card className="transition-colors hover:bg-accent/40">
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{board.name}</p>
                    <p className="text-xs text-muted-foreground">{board.participants.length} participant{board.participants.length === 1 ? '' : 's'} · updated {new Date(board.updatedAt).toLocaleString()}</p>
                  </div>
                  <Share2 size={15} className="shrink-0 text-muted-foreground" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
