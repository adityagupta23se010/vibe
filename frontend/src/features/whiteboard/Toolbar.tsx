import { ArrowRight, Circle, Eraser, Hand, Minus, MousePointer2, Pen, Redo2, Square, Type, Undo2 } from 'lucide-react';
import { cn } from '@/utils/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Tool } from './types';
import type { WhiteboardBoard } from './useWhiteboardBoard';

const TOOLS: { tool: Tool; icon: typeof Pen; label: string; shortcut: string }[] = [
  { tool: 'select', icon: MousePointer2, label: 'Select', shortcut: 'V' },
  { tool: 'hand', icon: Hand, label: 'Pan', shortcut: 'H' },
  { tool: 'pen', icon: Pen, label: 'Pen', shortcut: 'P' },
  { tool: 'eraser', icon: Eraser, label: 'Eraser', shortcut: 'E' },
  { tool: 'line', icon: Minus, label: 'Line', shortcut: 'L' },
  { tool: 'arrow', icon: ArrowRight, label: 'Arrow', shortcut: 'A' },
  { tool: 'rectangle', icon: Square, label: 'Rectangle', shortcut: 'R' },
  { tool: 'ellipse', icon: Circle, label: 'Ellipse', shortcut: 'O' },
  { tool: 'text', icon: Type, label: 'Text', shortcut: 'T' },
];
const COLORS = ['#111827', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ffffff'];
const WIDTHS = [2, 4, 8, 16];

export function Toolbar({ board }: { board: WhiteboardBoard }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-card p-1.5 shadow-sm">
      <div className="flex items-center gap-0.5">
        {TOOLS.map(({ tool, icon: Icon, label, shortcut }) => (
          <Tooltip key={tool}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={label}
                aria-pressed={board.tool === tool}
                disabled={!board.isEditor && tool !== 'select' && tool !== 'hand'}
                onClick={() => board.setTool(tool)}
                className={cn(
                  'flex size-8 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                  board.tool === tool ? 'bg-primary text-primary-foreground' : 'hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon size={16} />
              </button>
            </TooltipTrigger>
            <TooltipContent>{label} ({shortcut})</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="mx-1 h-6 w-px bg-border" />
      <div className="flex items-center gap-1">
        {COLORS.map(value => (
          <button
            key={value}
            type="button"
            aria-label={`Color ${value}`}
            aria-pressed={board.color === value}
            onClick={() => board.setColor(value)}
            className="size-5 rounded-full border-2"
            style={{ background: value, borderColor: board.color === value ? 'var(--primary)' : 'var(--border)' }}
          />
        ))}
      </div>
      <div className="mx-1 h-6 w-px bg-border" />
      <div className="flex items-center gap-1">
        {WIDTHS.map(value => (
          <button
            key={value}
            type="button"
            aria-label={`Stroke width ${value}`}
            aria-pressed={board.strokeWidth === value}
            onClick={() => board.setStrokeWidth(value)}
            className={cn('rounded-md px-2 py-1 text-xs', board.strokeWidth === value ? 'bg-accent font-medium' : 'hover:bg-accent/60')}
          >
            {value}
          </button>
        ))}
      </div>
      <div className="mx-1 h-6 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label="Undo" disabled={!board.canUndo} onClick={board.undo} className="flex size-8 items-center justify-center rounded-md hover:bg-accent disabled:opacity-40">
            <Undo2 size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent>Undo (Ctrl+Z)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label="Redo" disabled={!board.canRedo} onClick={board.redo} className="flex size-8 items-center justify-center rounded-md hover:bg-accent disabled:opacity-40">
            <Redo2 size={16} />
          </button>
        </TooltipTrigger>
        <TooltipContent>Redo (Ctrl+Shift+Z)</TooltipContent>
      </Tooltip>
    </div>
  );
}
