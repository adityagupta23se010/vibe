import { useCallback, useRef, useState } from 'react';

type HistoryEntry = { undo: () => void; redo: () => void };

/**
 * Per-user, client-side undo/redo. Each entry's undo/redo closures re-run the
 * normal create/update/delete path (so inverses are validated, persisted and
 * broadcast like any other edit) — there is no server-side global undo stack,
 * which keeps concurrent multi-user edits simple: a user can only ever undo
 * their own operations, never someone else's.
 */
export function useUndoRedo() {
  const undoStack = useRef<HistoryEntry[]>([]);
  const redoStack = useRef<HistoryEntry[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const sync = () => { setCanUndo(undoStack.current.length > 0); setCanRedo(redoStack.current.length > 0); };

  const push = useCallback((entry: HistoryEntry) => { undoStack.current.push(entry); redoStack.current = []; sync(); }, []);
  const undo = useCallback(() => { const entry = undoStack.current.pop(); if (!entry) return; entry.undo(); redoStack.current.push(entry); sync(); }, []);
  const redo = useCallback(() => { const entry = redoStack.current.pop(); if (!entry) return; entry.redo(); undoStack.current.push(entry); sync(); }, []);
  const reset = useCallback(() => { undoStack.current = []; redoStack.current = []; sync(); }, []);

  return { push, undo, redo, reset, canUndo, canRedo };
}
