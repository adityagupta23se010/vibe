import { Headphones, Loader2, Lock, Mic, MicOff, PhoneOff, RotateCw } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/utils/utils';
import type { VoiceChat } from '../useVoiceChat';
import type { VoiceStatus } from '../voice/types';
import { initials } from '../initials';
import { SpeakingRing } from './SpeakingRing';

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: 'Not in voice',
  connecting: 'Connecting…',
  connected: 'Voice connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
};

function VoiceStatusText({ voice }: { voice: VoiceChat }) {
  const tone =
    voice.status === 'connected' ? 'text-green-600 dark:text-green-400'
      : voice.status === 'reconnecting' || voice.status === 'connecting' ? 'text-amber-600 dark:text-amber-400'
        : voice.status === 'disconnected' ? 'text-destructive' : 'text-muted-foreground';
  return (
    <span role="status" aria-live="polite" className={cn('flex items-center gap-1.5 whitespace-nowrap text-xs', tone)}>
      {(voice.status === 'connecting' || voice.status === 'reconnecting') && <Loader2 size={12} className="animate-spin" />}
      <span className="hidden sm:inline">{STATUS_LABEL[voice.status]}</span>
      <span className="sm:hidden">{voice.status === 'idle' ? '' : STATUS_LABEL[voice.status]}</span>
    </span>
  );
}

/**
 * Compact voice bar docked below the canvas: never overlays the board, and
 * keeps mic state visible at all times while in voice. The right padding
 * keeps the controls clear of the app-wide floating support-chat button.
 */
export function VoiceControls({ voice, colorFor }: { voice: VoiceChat; colorFor: (userId: string) => string }) {
  const inCall = voice.participants;
  const busy = voice.status === 'connecting';
  const forced = !voice.canSpeak;
  // A revoked user already sees the reason as an error; otherwise explain the disabled button.
  const blockedReason = !voice.canJoin && !voice.error ? 'The room owner has not allowed you to use voice.' : undefined;

  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-lg border bg-card py-1.5 pl-2 pr-[4.5rem] shadow-sm sm:pl-3" aria-label="Voice chat">
      <div className="flex min-w-0 items-center gap-2">
        <Headphones size={16} className="shrink-0 text-muted-foreground" aria-hidden />
        <VoiceStatusText voice={voice} />
        {inCall.length > 0 && (
          <div className="flex items-center -space-x-1.5" aria-label={`${inCall.length} in voice`}>
            {inCall.slice(0, 6).map(p => {
              const state = voice.byUser.get(p.userId);
              return (
                <Tooltip key={p.socketId}>
                  <TooltipTrigger asChild>
                    <span className="relative">
                      <SpeakingRing speaking={!!state?.speaking}>
                        <Avatar className="size-6 border-2 border-card">
                          <AvatarFallback style={{ background: colorFor(p.userId), color: '#fff' }} className="text-[9px]">{initials(p.name)}</AvatarFallback>
                        </Avatar>
                      </SpeakingRing>
                      {state?.muted && <MicOff size={10} className="absolute -bottom-0.5 -right-0.5 rounded-full bg-card p-px text-destructive" aria-label="muted" />}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{p.name}{state?.forced ? ' (muted by owner)' : state?.muted ? ' (muted)' : state?.speaking ? ' (speaking)' : ''}</TooltipContent>
                </Tooltip>
              );
            })}
            {inCall.length > 6 && <span className="pl-2.5 text-xs text-muted-foreground">+{inCall.length - 6}</span>}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        {voice.error ? (
          <span role="alert" className="max-w-[18rem] truncate text-xs text-destructive" title={voice.error.message}>{voice.error.message}</span>
        ) : (voice.notice || blockedReason) && (
          <span role="status" className="max-w-[20rem] truncate text-xs text-muted-foreground" title={voice.notice || blockedReason}>{voice.notice || blockedReason}</span>
        )}
        {voice.inVoice ? (
          <>
            {forced ? (
              // Owner-imposed: the button stays visible (mic state is always shown) but cannot lift the mute.
              <Button size="sm" variant="destructive" className="gap-1.5" disabled aria-label="Muted by the room owner">
                <Lock size={14} />
                <span className="hidden sm:inline">Muted by owner</span>
              </Button>
            ) : (
              <Button
                size="sm"
                variant={voice.muted ? 'destructive' : 'outline'}
                className="gap-1.5"
                onClick={voice.toggleMute}
                disabled={busy}
                aria-pressed={voice.muted}
                aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
              >
                {voice.muted ? <MicOff size={14} /> : <Mic size={14} />}
                <span className="hidden sm:inline">{voice.muted ? 'Unmute' : 'Mute'}</span>
              </Button>
            )}
            <Button size="sm" variant="outline" className="gap-1.5" onClick={voice.leave} aria-label="Leave voice">
              <PhoneOff size={14} />
              <span className="hidden sm:inline">Leave</span>
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            className="gap-1.5"
            onClick={voice.join}
            disabled={!voice.supported || !voice.canJoin}
            title={!voice.supported ? 'Voice is not supported in this browser' : !voice.canJoin ? 'Voice is not available to you in this room' : undefined}
          >
            {!voice.canJoin ? <Lock size={14} /> : voice.error ? <RotateCw size={14} /> : <Mic size={14} />}
            {voice.error && voice.canJoin ? 'Try again' : 'Join voice'}
          </Button>
        )}
      </div>
    </div>
  );
}
