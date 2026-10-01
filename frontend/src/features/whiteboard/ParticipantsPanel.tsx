import { useState } from 'react';
import { AlertTriangle, Users, Wifi, WifiOff } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { colorForUser } from './useWhiteboardBoard';
import type { WhiteboardBoard } from './useWhiteboardBoard';

export function ConnectionStatusBadge({ board }: { board: WhiteboardBoard }) {
  if (!board.connected || board.reconnecting) {
    return (
      <Badge variant="outline" className="gap-1.5 text-amber-600 dark:text-amber-400">
        <WifiOff size={12} /> {board.reconnecting ? 'Reconnecting…' : 'Connecting…'}
      </Badge>
    );
  }
  if (!board.joined) return <Badge variant="outline" className="gap-1.5"><Wifi size={12} /> Joining…</Badge>;
  return <Badge variant="outline" className="gap-1.5 text-green-600 dark:text-green-400"><Wifi size={12} /> Connected</Badge>;
}

export function SaveStatus({ board }: { board: WhiteboardBoard }) {
  if (!board.isEditor) return null;
  const label = board.saveState === 'saving' ? 'Saving…' : board.saveState === 'pending' ? 'Changes pending' : '✓ Saved';
  return <span className="text-xs text-muted-foreground">{label}</span>;
}

export function ParticipantsPanel({ board }: { board: WhiteboardBoard }) {
  const [open, setOpen] = useState(false);
  const initials = (name: string) => name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Users size={14} /> {board.participants.length}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-80">
        <SheetHeader>
          <SheetTitle>Participants ({board.participants.length})</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-2 overflow-y-auto px-4 pb-4">
          {board.participants.map(person => {
            const sessionRole = board.session?.participants.find(p => p.userId === person.userId)?.role ?? 'viewer';
            const creator = board.session?.createdBy === person.userId;
            return (
              <div key={person.userId} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="relative flex size-2 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex size-2 rounded-full bg-green-500" />
                  </span>
                  <Avatar className="size-7">
                    <AvatarFallback style={{ background: colorForUser(person.userId), color: '#fff' }} className="text-[10px]">{initials(person.name)}</AvatarFallback>
                  </Avatar>
                  <span className="truncate text-sm">{person.name}{person.userId === board.selfId ? ' (you)' : ''}</span>
                </div>
                {board.isCreator && !creator ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs capitalize">{sessionRole}</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => board.setParticipantRole(person.userId, 'editor')}>Editor</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => board.setParticipantRole(person.userId, 'viewer')}>Viewer</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <Badge variant="secondary" className="text-[10px] capitalize">{creator ? 'Creator' : sessionRole}</Badge>
                )}
              </div>
            );
          })}
          {!board.participants.length && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><AlertTriangle size={12} /> No one else is here yet.</p>}
        </div>
        {board.isCreator && (
          <div className="border-t px-4 py-3">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">New participants join as</p>
            <div className="flex gap-2">
              <Button size="sm" variant={board.session?.defaultRole === 'editor' ? 'default' : 'outline'} onClick={() => board.setDefaultRole('editor')}>Editor</Button>
              <Button size="sm" variant={board.session?.defaultRole === 'viewer' ? 'default' : 'outline'} onClick={() => board.setDefaultRole('viewer')}>Viewer</Button>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
