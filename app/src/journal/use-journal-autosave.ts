import {useCallback, useEffect, useRef, useState} from 'react';

export type JournalSaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

type Options = Readonly<{
  initialText: string;
  entryKey: string;
  save: (text: string) => Promise<boolean>;
  debounceMs?: number;
}>;

/**
 * Debounced autosave for the day journal.
 *
 * Drain rules:
 *  - `baseline` is the text already confirmed saved (or the loaded entry). flush() skips when
 *    the text equals baseline, so browsing an entry without editing never writes.
 *  - flush() returns a promise that resolves only after the queue is drained to the newest
 *    text (true), or the last save failed (false). Edits made during a save set `rerun`, so
 *    the loop saves the newest text before resolving; date switches and unmount never lose words.
 *  - The drain keeps running after unmount (only setState is gated by `mounted`). The caller's
 *    save() must reject writes whose workspace identity (epoch) is stale — see JournalWorkbench.
 */
export function useJournalAutosave({initialText, entryKey, save, debounceMs = 1200}: Options) {
  const [text, setTextState] = useState(initialText);
  const [status, setStatus] = useState<JournalSaveStatus>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(initialText);
  const baseline = useRef(initialText);
  const mounted = useRef(true);
  const saveRef = useRef(save);
  saveRef.current = save;

  // Shared drain: while active, every flush() caller awaits this same promise.
  const drain = useRef<null | {promise: Promise<boolean>; resolve: (ok: boolean) => void; rerun: boolean}>(null);

  const clearTimer = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const flush = useCallback((): Promise<boolean> => {
    clearTimer();
    const active = drain.current;
    if (active) { active.rerun = true; return active.promise; }
    let resolveDrain!: (ok: boolean) => void;
    const promise = new Promise<boolean>(resolve => { resolveDrain = resolve; });
    const state = {promise, resolve: resolveDrain, rerun: false};
    drain.current = state;

    void (async () => {
      let result = true, didSave = false;
      for (;;) {
        state.rerun = false;
        const value = latest.current;
        if (value === baseline.current) { result = true; break; } // nothing unsaved
        if (mounted.current) setStatus('saving');
        let ok = false;
        try { ok = await saveRef.current(value); } catch { ok = false; }
        if (!ok) { result = false; if (mounted.current) setStatus('error'); break; }
        baseline.current = value;
        didSave = true;
        if (state.rerun || latest.current !== value) continue; // newer edits arrived
        result = true;
        break;
      }
      // A second flush may request a rerun with no new text. Finalize after the loop,
      // including its baseline/no-op exit, so a successful drain never stays "saving".
      if (result && mounted.current) {
        if (didSave) setSavedAt(new Date().toISOString());
        setStatus(didSave || baseline.current ? 'saved' : 'idle');
      }
      drain.current = null;
      state.resolve(result);
    })();
    return promise;
  }, [clearTimer]);

  // Adopt the loaded target whenever its identity changes (date switch, or the entry finishing
  // loading). Identity — not text — is the trigger, so switching between two blank dates still
  // resets the editor instead of keeping the previous day's words.
  useEffect(() => {
    mounted.current = true;
    latest.current = initialText;
    baseline.current = initialText;
    setTextState(initialText);
    setStatus(initialText ? 'saved' : 'idle');
    setSavedAt(null);
    // entryKey is the deliberate trigger; initialText belongs to this same render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryKey]);

  const setText = useCallback((next: string) => {
    latest.current = next;
    setTextState(next);
    clearTimer();
    if (drain.current) { drain.current.rerun = true; if (mounted.current) setStatus('saving'); }
    else { if (mounted.current) setStatus('dirty'); timer.current = setTimeout(() => { void flush(); }, debounceMs); }
  }, [clearTimer, flush, debounceMs]);

  const retry = useCallback(() => { void flush(); }, [flush]);

  // Keep draining pending words on unmount; do not abort the loop. Workspace replacement is
  // rejected inside save() via the epoch check.
  useEffect(() => () => {
    mounted.current = false;
    clearTimer();
    void flush();
  }, [clearTimer, flush]);

  return {text, setText, status, savedAt, flush, retry};
}
