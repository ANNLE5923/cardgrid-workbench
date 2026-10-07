import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, Id, PlacementPreview, PlacementSubject } from '../../../workspace/index.ts';
import { displayInstant } from '../time.ts';
import type { TodayClient } from '../../../workspace/index.ts';

export type SessionStatus = 'idle' | 'preparing' | 'preview' | 'committing' | 'committed' | 'error';
export type PlacementSessionState = Readonly<{
  status: SessionStatus;
  subject: PlacementSubject | null;
  date: string;
  zone: string;
  preview: PlacementPreview | null;
  chosen: Id | null;
  unresolved: readonly string[];
  error: string | null;
  busy: boolean;
}>;
const initialState: PlacementSessionState = {
  status: 'idle',
  subject: null,
  date: '',
  zone: '',
  preview: null,
  chosen: null,
  unresolved: [],
  error: null,
  busy: false,
};
type Intent = Readonly<{
  subject: PlacementSubject;
  date: string;
  zone: string;
  focusMinute: number;
  generation: number;
}>;

/** One owner; requests are serialized and intermediate moves coalesce to the latest landing. */
export function usePlacementSession(client: TodayClient) {
  const [state, setState] = useState<PlacementSessionState>(initialState);
  const generation = useRef(0);
  const pending = useRef<Intent | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const intentRef = useRef<Intent | null>(null);
  const previewRef = useRef<PlacementPreview | null>(null);
  const chosenRef = useRef<Id | null>(null);
  const busyRef = useRef(false);
  const commandRef = useRef<Command | null>(null);
  const committing = useRef(false);
  const alive = useRef(true);
  const initialUnlock = useRef<PlacementSubject | null>(null);

  const cancel = useCallback(
    (preview: PlacementPreview | null) => {
      if (preview) client.cancelPreview(preview.previewId);
    },
    [client],
  );
  const discardUnlock = useCallback(
    async (subject: PlacementSubject) => {
      if (subject.kind !== 'fixed') return;
      const load = await client.load();
      if (!load.ok) return;
      const fixed = load.value.data?.planner.fixed.find((f) => f.id === subject.commitmentId);
      if (!fixed) return;
      // Bind a loose unlock at its existing valid range, then cancel only that grant.
      const start = displayInstant(fixed.range.startAt, fixed.range.zone);
      const result = await client.previewPlacement({
        token: load.value.token,
        subject,
        date: start.date,
        zone: fixed.range.zone,
        focusMinuteOfDay: start.minute,
      });
      if (result.ok) cancel(result.value);
    },
    [client, cancel],
  );
  const reset = useCallback(() => {
    generation.current++;
    if (initialUnlock.current) void discardUnlock(initialUnlock.current);
    initialUnlock.current = null;
    pending.current = null;
    intentRef.current = null;
    busyRef.current = false;
    commandRef.current = null;
    chosenRef.current = null;
    cancel(previewRef.current);
    previewRef.current = null;
    setState(initialState);
  }, [cancel, discardUnlock]);

  const drain = useCallback((): Promise<void> => {
    if (running.current) return running.current;
    // Install the promise before the first asynchronous Host call can finish.
    running.current = (async () => {
      while (pending.current) {
        const intent = pending.current;
        pending.current = null;
        const stale = () => !alive.current || intent.generation !== generation.current;
        const load = await client.load();
        if (stale()) continue;
        if (!load.ok) {
          busyRef.current = false;
          setState((s) => ({ ...s, status: 'error', busy: false, error: load.message }));
          continue;
        }
        let subject = intent.subject;
        const old = previewRef.current;
        if (subject.kind === 'fixed') {
          const first = initialUnlock.current;
          initialUnlock.current = null;
          const unlock =
            first?.kind === 'fixed' && first.unlockId === subject.unlockId
              ? { ok: true as const, value: first.unlockId }
              : await client.unlockFixed({
                  token: load.value.token,
                  commitmentId: subject.commitmentId,
                  version: subject.version,
                });
          if (!unlock.ok) {
            if (!stale()) {
              cancel(old);
              previewRef.current = null;
              busyRef.current = false;
              setState((s) => ({ ...s, status: 'error', busy: false, error: unlock.message }));
            }
            continue;
          }
          subject = { ...subject, unlockId: unlock.value };
          // Fresh unlock FIRST. The old preview owns only its previous unlock.
          cancel(old);
          previewRef.current = null;
          // Even a superseded unlock is bound to a preview below, then cancelled;
          // this releases that specific capability without invalidating other owners.
        }
        const result = await client.previewPlacement({
          token: load.value.token,
          subject,
          date: intent.date,
          zone: intent.zone,
          focusMinuteOfDay: intent.focusMinute,
        });
        if (subject.kind !== 'fixed') {
          cancel(old);
          previewRef.current = null;
        }
        if (stale()) {
          if (result.ok) cancel(result.value);
          else await discardUnlock(subject);
          continue;
        }
        busyRef.current = false;
        if (!result.ok) {
          await discardUnlock(subject);
          if (stale()) continue;
          setState((s) => ({
            ...s,
            status: 'error',
            preview: null,
            chosen: null,
            busy: false,
            error: result.message,
          }));
          continue;
        }
        previewRef.current = result.value;
        const only = result.value.candidates.length === 1 ? result.value.candidates[0] : null;
        chosenRef.current = only?.id ?? null;
        setState({
          status: 'preview',
          subject: intent.subject,
          date: intent.date,
          zone: intent.zone,
          preview: result.value,
          chosen: only?.id ?? null,
          unresolved: result.value.unresolved.map((u) => u.message),
          error: null,
          busy: false,
        });
      }
    })().finally(() => {
      running.current = null;
    });
    return running.current;
  }, [client, cancel, discardUnlock]);

  const enqueue = useCallback(
    (params: Omit<Intent, 'generation'>) => {
      if (committing.current) return Promise.resolve();
      const next = { ...params, generation: ++generation.current };
      intentRef.current = next;
      pending.current = next;
      busyRef.current = true;
      chosenRef.current = null;
      commandRef.current = null;
      // Immediately hide the old candidates/acknowledgement while another request is pending.
      setState({
        ...initialState,
        status: 'preparing',
        subject: params.subject,
        date: params.date,
        zone: params.zone,
        busy: true,
      });
      return drain();
    },
    [drain],
  );

  const start = useCallback(
    (params: Omit<Intent, 'generation'>) => {
      if (committing.current) return Promise.resolve();
      cancel(previewRef.current);
      previewRef.current = null;
      if (initialUnlock.current) void discardUnlock(initialUnlock.current);
      initialUnlock.current = params.subject.kind === 'fixed' ? params.subject : null;
      return enqueue(params);
    },
    [enqueue, cancel, discardUnlock],
  );

  const moveTo = useCallback(
    (date: string, focusMinute: number) => {
      const intent = intentRef.current;
      if (!intent || (intent.date === date && intent.focusMinute === focusMinute))
        return Promise.resolve();
      return enqueue({ subject: intent.subject, date, zone: intent.zone, focusMinute });
    },
    [enqueue],
  );

  const selectCandidate = useCallback((id: Id) => {
    if (busyRef.current || !previewRef.current?.candidates.some((c) => c.id === id)) return;
    if (chosenRef.current !== id) commandRef.current = null;
    chosenRef.current = id;
    setState((s) => ({ ...s, chosen: id }));
  }, []);

  const commit = useCallback(
    async (acknowledged: boolean) => {
      if (busyRef.current || committing.current) return false;
      const preview = previewRef.current;
      const candidate = preview?.candidates.find((c) => c.id === chosenRef.current);
      if (!preview || !candidate) return false;
      if (candidate.state === 'conflict' && !acknowledged) {
        setState((s) => ({ ...s, error: '请先勾选确认本次重叠' }));
        return false;
      }
      // Keep the COMPLETE command across same-command retries, including its acknowledgement.
      const command: Command = commandRef.current ?? {
        commandId: crypto.randomUUID(),
        expected: preview.token,
        type: 'CommitPlacement',
        payload: {
          previewId: preview.previewId,
          candidateId: candidate.id,
          acknowledgedOverlap: candidate.state === 'conflict' ? candidate.acknowledgementId : null,
        },
      };
      commandRef.current = command;
      const gen = generation.current;
      committing.current = true;
      busyRef.current = true;
      setState((s) => ({ ...s, status: 'committing', busy: true, error: null }));
      const result = await client.submit(command);
      committing.current = false;
      if (!alive.current || gen !== generation.current) return false;
      busyRef.current = false;
      if (!result.ok) {
        if (result.retry === 'same-command') {
          setState((s) => ({ ...s, status: 'preview', busy: false, error: result.message }));
        } else {
          cancel(previewRef.current);
          previewRef.current = null;
          chosenRef.current = null;
          commandRef.current = null;
          setState((s) => ({
            ...s,
            status: 'error',
            preview: null,
            chosen: null,
            busy: false,
            error: result.message,
          }));
        }
        return false;
      }
      previewRef.current = null;
      chosenRef.current = null;
      commandRef.current = null;
      generation.current++;
      setState((s) => ({ ...s, status: 'committed', preview: null, chosen: null, busy: false }));
      return result.value;
    },
    [client, cancel],
  );

  // External changes invalidate synchronously, before a late request can reopen its dialog.
  useEffect(
    () =>
      client.subscribe((external) => {
        if (external) reset();
      }),
    [client, reset],
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      generation.current++;
      pending.current = null;
      cancel(previewRef.current);
      if (initialUnlock.current) void discardUnlock(initialUnlock.current);
      initialUnlock.current = null;
    };
  }, [cancel, discardUnlock]);
  return { state, start, moveTo, selectCandidate, commit, release: reset, reclaim: reset };
}
export type PlacementSession = ReturnType<typeof usePlacementSession>;
