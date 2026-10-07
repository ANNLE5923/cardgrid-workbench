/** A7/B9 seam: authoritative projection, independent notes, drained named saves. */
import type { V06Host, Token } from '../workspace/index.ts';
import type { V06Command } from '../workspace/v06.ts';
import type { JournalProjection } from './timeline.ts';
type Target = Readonly<{ kind: 'note' | 'legacy'; id: string; version: number }> | null;
export type V06JournalState = Readonly<{
  date: string;
  zone: string;
  token: Token | null;
  projection: JournalProjection | null;
  target: Target;
  text: string;
  status: 'loading' | 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
  error: string | null;
}>;
export function createV06JournalSession(
  host: Pick<V06Host, 'load' | 'loadV5' | 'readJournalProjection' | 'submit' | 'subscribe'>,
  options: { date: string; zone: string; id?: () => string; debounceMs?: number },
) {
  const id = options.id ?? (() => crypto.randomUUID());
  let state: V06JournalState = {
    date: options.date,
    zone: options.zone,
    token: null,
    projection: null,
    target: null,
    text: '',
    status: 'loading',
    error: null,
  };
  let baseline = '',
    pending: Extract<V06Command, { type: 'SaveJournalNote' | 'SaveLegacyJournalBlock' }> | null =
      null,
    drain: Promise<boolean> | null = null,
    timer: ReturnType<typeof setTimeout> | undefined,
    off: (() => void) | undefined,
    closed = false,
    sequence = 0;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<V06JournalState>) => {
    state = Object.freeze({ ...state, ...patch });
    for (const fn of listeners) fn();
  };
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  async function refresh() {
    const seq = ++sequence,
      s = await host.loadV5();
    if (closed || seq !== sequence) return false;
    if (!s.ok) {
      if (s.code === 'UNSUPPORTED_VERSION' || s.code === 'WORKSPACE_REPLACED') {
        const raw = await host.load();
        if (raw.ok && state.token && raw.value.token.epoch !== state.token.epoch) {
          clear();
          pending = null;
          baseline = '';
          publish({
            token: raw.value.token,
            projection: null,
            target: null,
            text: '',
            status: 'idle',
            error: '工作区已替换，旧草稿已清除',
          });
          return false;
        }
      }
      publish({ status: 'error', error: s.message });
      return false;
    }
    if (state.token && state.token.epoch !== s.value.token.epoch) {
      clear();
      pending = null;
      baseline = '';
      publish({
        token: s.value.token,
        projection: null,
        target: null,
        text: '',
        status: 'idle',
        error: '工作区已替换，旧草稿已清除',
      });
    }
    const p = await host.readJournalProjection({
      date: state.date,
      zone: state.zone,
      token: s.value.token,
    });
    if (closed || seq !== sequence) return false;
    if (!p.ok) {
      publish({ error: p.message });
      return false;
    }
    publish({ token: p.value.token, projection: p.value });
    return true;
  }
  async function save() {
    for (;;) {
      if (closed) return false;
      const text = state.text;
      if (!pending && text === baseline) {
        publish({ status: baseline ? 'saved' : 'idle', error: null });
        return true;
      }
      const s = await host.loadV5({ epoch: state.token?.epoch });
      if (!s.ok) {
        publish({ status: 'error', error: s.message });
        return false;
      }
      if (state.token?.epoch !== s.value.token.epoch) {
        await refresh();
        return false;
      }
      if (!pending) {
        const target = state.target;
        if (target) {
          const existing =
            target.kind === 'note'
              ? s.value.data.journalNotes.find((n) => n.id === target.id)
              : s.value.data.journalEntries.find((n) => n.id === target.id);
          if (!existing || existing.version !== target.version) {
            publish({
              status: 'error',
              error: '该条记录已被其他操作修改；草稿保留，请核对最新内容',
            });
            return false;
          }
        }
        pending =
          target?.kind === 'legacy'
            ? {
                contractVersion: 'v06-p0-1',
                commandId: id(),
                expected: s.value.token,
                type: 'SaveLegacyJournalBlock',
                payload: { entry: { id: target.id, version: target.version }, text },
              }
            : {
                contractVersion: 'v06-p0-1',
                commandId: id(),
                expected: s.value.token,
                type: 'SaveJournalNote',
                payload: {
                  id: target?.id ?? null,
                  expectedVersion: target?.version ?? null,
                  date: state.date,
                  zone: state.zone,
                  text,
                },
              };
      }
      const command = pending;
      publish({ status: 'saving', error: null });
      const r = await host.submit(command);
      if (!r.ok) {
        if (r.retry !== 'same-command') pending = null;
        if (r.code === 'WORKSPACE_REPLACED') await refresh();
        else publish({ status: 'error', error: r.message });
        return false;
      }
      const fresh = await host.loadV5();
      if (!fresh.ok) {
        publish({ status: 'error', error: fresh.message });
        return false;
      }
      if (fresh.value.token.epoch !== command.expected.epoch) {
        pending = null;
        await refresh();
        return false;
      }
      const kind = command.type === 'SaveLegacyJournalBlock' ? 'legacy' : 'note',
        ref = r.value.resultRefs.find(
          (x) => x.kind === (kind === 'legacy' ? 'journal-entry' : 'journal-note'),
        );
      const saved =
        kind === 'note'
          ? fresh.value.data.journalNotes.find((n) => n.id === (ref?.id ?? state.target?.id))
          : fresh.value.data.journalEntries.find((n) => n.id === (ref?.id ?? state.target?.id));
      baseline = command.payload.text;
      pending = null;
      publish({
        token: fresh.value.token,
        target: saved ? { kind, id: saved.id, version: saved.version } : null,
      });
      await refresh();
      if (state.text === baseline) {
        publish({ status: 'saved', error: null });
        return true;
      }
    }
  }
  function flush() {
    clear();
    if (drain) return drain;
    drain = save()
      .catch((e) => {
        publish({ status: 'error', error: e instanceof Error ? e.message : '保存失败，草稿保留' });
        return false;
      })
      .finally(() => {
        drain = null;
      });
    return drain;
  }
  const api = {
    getSnapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    async start() {
      off ??= host.subscribe(() => void refresh());
      return refresh();
    },
    refresh,
    flush,
    edit(text: string) {
      if (closed) return;
      publish({ text, status: text === baseline ? 'saved' : 'dirty', error: null });
      clear();
      timer = setTimeout(() => void flush(), options.debounceMs ?? 1200);
    },
    async select(target: Target) {
      if (!(await flush())) return false;
      await refresh();
      const record =
        target?.kind === 'note'
          ? state.projection?.timeline.notes.find((n) => n.id === target.id)
          : target?.kind === 'legacy'
            ? state.projection?.timeline.legacyBlocks.find((n) => n.id === target.id)
            : null;
      if (target && !record) return false;
      baseline = record?.text ?? '';
      pending = null;
      publish({
        target: record && target ? { ...target, version: record.version } : null,
        text: baseline,
        status: 'idle',
        error: null,
      });
      return true;
    },
    async changeDay(date: string, zone = state.zone) {
      if (!(await flush())) return false;
      ++sequence;
      baseline = '';
      pending = null;
      publish({
        date,
        zone,
        target: null,
        text: '',
        projection: null,
        status: 'loading',
        error: null,
      });
      return refresh();
    },
    discardDraft() {
      clear();
      pending = null;
      publish({ text: baseline, status: 'idle', error: null });
    },
    get dirty() {
      return state.text !== baseline || pending !== null;
    },
    async close() {
      clear();
      const saved = await flush();
      off?.();
      closed = true;
      ++sequence;
      listeners.clear();
      return saved;
    },
  };
  return api;
}
export type V06JournalSession = ReturnType<typeof createV06JournalSession>;
