import type { ReactNode } from 'react';
import { cn } from '@/utils/utils';

/** Subtle ring around an avatar while that participant is speaking. */
export function SpeakingRing({ speaking, children }: { speaking: boolean; children: ReactNode }) {
  return (
    <span className={cn('inline-flex rounded-full ring-2 ring-offset-1 ring-offset-background transition-shadow duration-150', speaking ? 'ring-green-500' : 'ring-transparent')}>
      {children}
    </span>
  );
}
