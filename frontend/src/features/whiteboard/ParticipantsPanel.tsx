import { useState } from 'react';
import { AlertTriangle, Crown, Loader2, Lock, Mic, MicOff, MoreHorizontal, Users, Wifi, WifiOff } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { SpeakingRing } from '@/features/collaboration/components/SpeakingRing';
import { initials } from '@/features/collaboration/initials';
import type { ParticipantVoice, VoiceChat } from '@/features/collaboration/useVoiceChat';
import { permissionsOf, type ParticipantPermissions } from './permissions';
import type { Presence } from './types';
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

/**
 * One line summarising what someone can currently do with voice. People not in
 * voice get no mic icon, so nothing implies a live microphone.
 */
function VoiceLine({ live, perms }: { live?: ParticipantVoice; perms: ParticipantPermissions }) {
  const base = 'flex items-center gap-1 text-[11px]';
  if (live) {
    if (live.forced) return <span className={`${base} text-destructive`}><Lock size={10} /> Muted by owner</span>;
    if (live.muted) return <span className={`${base} text-muted-foreground`}><MicOff size={11} /> Muted</span>;
    if (live.speaking) return <span className={`${base} text-green-600 dark:text-green-400`}><Mic size={11} /> Speaking</span>;
    return <span className={`${base} text-muted-foreground`}><Mic size={11} /> In voice</span>;
  }
  if (!perms.canJoinVoice) return <span className={`${base} text-muted-foreground`}>Voice off</span>;
  if (!perms.canSpeak) return <span className={`${base} text-muted-foreground`}>Listen only</span>;
  return null;
}

function ParticipantRow({ board, voice, person }: { board: WhiteboardBoard; voice?: VoiceChat; person: Presence }) {
  const session = board.session!;
  const perms = permissionsOf(session, person.userId);
  const live = voice?.byUser.get(person.userId);
  const self = person.userId === board.selfId;
  const pending = board.pending.has(person.userId);
  // Moderation is shown only to the owner, and never against the owner.
  const canModerate = board.isCreator && !perms.isOwner;
  const roleLabel = perms.isOwner ? 'Owner' : perms.role === 'editor' ? 'Editor' : 'Viewer';

  const remove = () => {
    if (confirm(`Remove ${person.name} from this room? They won't be able to rejoin until you allow them back.`)) void board.removeParticipant(person.userId);
  };

  return (
    <div className="flex items-center justify-between gap-2 rounded-md border p-2" aria-busy={pending}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="relative inline-flex size-2 shrink-0 rounded-full bg-green-500" aria-label="online" />
        <SpeakingRing speaking={!!live?.speaking}>
          <Avatar className="size-7">
            <AvatarFallback style={{ background: colorForUser(person.userId), color: '#fff' }} className="text-[10px]">{initials(person.name)}</AvatarFallback>
          </Avatar>
        </SpeakingRing>
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1 truncate text-sm">
            {perms.isOwner && <Crown size={12} className="shrink-0 text-amber-500" aria-label="Room owner" />}
            <span className="truncate">{person.name}{self ? ' (you)' : ''}</span>
          </span>
          <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
            <span>{roleLabel}{!perms.isOwner && perms.role === 'editor' && session.boardLocked ? ' (locked)' : ''}</span>
            <VoiceLine live={live} perms={perms} />
          </span>
        </div>
      </div>

      {canModerate && (
        <div className="flex shrink-0 items-center gap-0.5">
          {pending && <Loader2 size={14} className="animate-spin text-muted-foreground" aria-label="Updating" />}
          {/* The most common classroom action gets a one-click button. */}
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            disabled={pending || !perms.canJoinVoice}
            onClick={() => void board.setParticipantVoice(person.userId, { canSpeak: !perms.canSpeak })}
            aria-label={perms.canSpeak ? `Mute ${person.name}` : `Allow ${person.name} to speak`}
            title={perms.canSpeak ? 'Mute' : 'Allow to speak'}
          >
            {perms.canSpeak ? <MicOff size={14} /> : <Mic size={14} className="text-green-600" />}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" disabled={pending} aria-label={`Manage ${person.name}`}>
                <MoreHorizontal size={14} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="truncate">{person.name}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {perms.role === 'viewer'
                ? <DropdownMenuItem onClick={() => void board.setParticipantRole(person.userId, 'editor')}>Make Editor</DropdownMenuItem>
                : <DropdownMenuItem onClick={() => void board.setParticipantRole(person.userId, 'viewer')}>Make Viewer</DropdownMenuItem>}
              <DropdownMenuSeparator />
              {perms.canSpeak
                ? <DropdownMenuItem disabled={!perms.canJoinVoice} onClick={() => void board.setParticipantVoice(person.userId, { canSpeak: false })}>Mute</DropdownMenuItem>
                : <DropdownMenuItem disabled={!perms.canJoinVoice} onClick={() => void board.setParticipantVoice(person.userId, { canSpeak: true })}>Allow to speak</DropdownMenuItem>}
              {perms.canJoinVoice
                ? <DropdownMenuItem onClick={() => void board.setParticipantVoice(person.userId, { canJoin: false })}>Disable voice</DropdownMenuItem>
                : <DropdownMenuItem disabled={!session.voicePolicy.enabled} onClick={() => void board.setParticipantVoice(person.userId, { canJoin: true })}>Allow voice</DropdownMenuItem>}
              {perms.hasVoiceOverride && (
                <DropdownMenuItem onClick={() => void board.setParticipantVoice(person.userId, { canJoin: null, canSpeak: null })}>Use room voice settings</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={remove}>Remove from room</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

function SettingRow({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <label htmlFor={id} className="min-w-0 cursor-pointer">
        <span className="block text-sm">{label}</span>
        {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/** Owner-only room-wide settings. Every control maps to a rule the server enforces. */
function RoomControls({ board }: { board: WhiteboardBoard }) {
  const session = board.session!;
  const policy = session.voicePolicy;
  const removed = session.removed ?? [];
  const setPolicy = (patch: Partial<typeof policy>) => void board.setRoomSettings({ voicePolicy: patch });
  // Owner mutes are stored per participant, so they persist until lifted here
  // or individually — changing the policy switches above does not lift them.
  const mutedByOwner = session.participants.filter(p => p.userId !== session.createdBy && p.voice?.canSpeak === false).length;

  return (
    <div className="flex flex-col gap-4 border-t px-4 py-3">
      <section aria-labelledby="wb-board-controls">
        <h3 id="wb-board-controls" className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Whiteboard</h3>
        <SettingRow
          id="wb-lock"
          label="Lock whiteboard"
          hint="Only you can draw. Everyone keeps their role for when you unlock."
          checked={session.boardLocked}
          onChange={value => void board.setRoomSettings({ boardLocked: value }, value ? 'Whiteboard locked' : 'Whiteboard unlocked')}
        />
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="text-sm">New participants join as</span>
          <div className="flex gap-1">
            <Button size="sm" className="h-7" variant={session.defaultRole === 'editor' ? 'default' : 'outline'} onClick={() => void board.setDefaultRole('editor')}>Editor</Button>
            <Button size="sm" className="h-7" variant={session.defaultRole === 'viewer' ? 'default' : 'outline'} onClick={() => void board.setDefaultRole('viewer')}>Viewer</Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="wb-voice-controls">
        <h3 id="wb-voice-controls" className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Voice</h3>
        <SettingRow
          id="wb-voice-enabled"
          label="Allow participants to use voice"
          hint={policy.enabled ? undefined : 'Only you can use voice right now.'}
          checked={policy.enabled}
          onChange={value => setPolicy({ enabled: value })}
        />
        <SettingRow
          id="wb-voice-join-muted"
          label="Participants join muted"
          hint="They can unmute themselves if they're allowed to speak."
          checked={policy.joinMuted}
          onChange={value => setPolicy({ joinMuted: value })}
        />
        <SettingRow
          id="wb-voice-ask"
          label="Only speak when allowed"
          hint="Participants stay muted until you let them speak."
          checked={!policy.speakByDefault}
          onChange={value => setPolicy({ speakByDefault: !value })}
        />
        {/* A one-off action with a visible undo, deliberately separate from the standing policy above. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {mutedByOwner > 0 ? (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void board.unmuteEveryone()}>
              <Mic size={14} /> Unmute everyone
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void board.muteEveryone()}>
              <MicOff size={14} /> Mute everyone now
            </Button>
          )}
          {mutedByOwner > 0 && (
            <span role="status" className="text-[11px] text-muted-foreground">
              {mutedByOwner === 1 ? '1 person is' : `${mutedByOwner} people are`} muted by you and can't unmute themselves.
            </span>
          )}
        </div>
      </section>

      {removed.length > 0 && (
        <section aria-labelledby="wb-removed">
          <h3 id="wb-removed" className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Removed ({removed.length})</h3>
          <div className="flex flex-col gap-1">
            {removed.map(r => (
              <div key={r.userId} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-muted-foreground">{r.name || 'Participant'}</span>
                <Button size="sm" variant="ghost" className="h-7" disabled={board.pending.has(r.userId)} onClick={() => void board.readmitParticipant(r.userId)}>Allow back</Button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The single participant surface for the room: presence, roles and voice
 * state for everyone, plus moderation and room controls for the owner only.
 */
export function ParticipantsPanel({ board, voice }: { board: WhiteboardBoard; voice?: VoiceChat }) {
  const [open, setOpen] = useState(false);
  if (!board.session) return null;
  const ownerId = board.session.createdBy;
  // Owner first, then everyone else in arrival order.
  const people = [...board.participants].sort((a, b) => Number(b.userId === ownerId) - Number(a.userId === ownerId));

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" aria-label={board.isCreator ? 'Participants and room controls' : 'Participants'}>
          <Users size={14} /> {board.participants.length}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Participants ({board.participants.length})</SheetTitle>
          {board.isCreator && <SheetDescription>Manage what each person can do. Changes apply instantly.</SheetDescription>}
        </SheetHeader>
        <div className="flex flex-col gap-2 px-4 pb-4">
          {people.map(person => <ParticipantRow key={person.userId} board={board} voice={voice} person={person} />)}
          {people.length <= 1 && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><AlertTriangle size={12} /> No one else is here yet.</p>}
        </div>
        {board.isCreator && <RoomControls board={board} />}
      </SheetContent>
    </Sheet>
  );
}
