/** Separate IDB partitions. Log failure never rolls back a business receipt. */
import type { WorkspaceStore } from './store.ts';
import type { MaintenanceEvent, V06Result } from './contracts-v06.ts';
import { appendMaintenanceEvents } from '../maintenance/model.ts';
import { assertDate, assertZone } from '../daily/time.ts';
import { commandFailure } from './commands.ts';
import { canonicalJson } from './format.ts';
type Day = { events: readonly MaintenanceEvent[]; dayRevision: number; hasGaps: boolean };
export function createV06Maintenance(store: WorkspaceStore) {
  const pending = new Map<string, MaintenanceEvent>();
  let queue = Promise.resolve(),
    closed = false;
  const listeners = new Set<() => void>();
  const key = (e: { epoch: string; date: string; zone: string }) =>
    JSON.stringify([e.epoch, e.date, e.zone]);
  const empty = (): Day => ({ events: [], dayRevision: 0, hasGaps: false });
  function parse(raw: unknown): Day {
    if (raw === undefined) return empty();
    const d = raw as Day;
    if (
      !d ||
      Object.keys(d).sort().join(',') !== 'dayRevision,events,hasGaps' ||
      !Number.isSafeInteger(d.dayRevision) ||
      d.dayRevision < 0 ||
      typeof d.hasGaps !== 'boolean'
    )
      throw Error('维护分区格式无效');
    appendMaintenanceEvents(d.events, []);
    return d;
  }
  async function write(
    event: MaintenanceEvent,
  ): Promise<V06Result<{ eventId: string; replayed: boolean; dayRevision: number }>> {
    try {
      if (closed || !store.atomicMaintenance) throw Error('维护存储连接不可用');
      const result = await store.atomicMaintenance(key(event), (raw) => {
        const before = parse(raw),
          p = appendMaintenanceEvents(before.events, [event]);
        if (!p.addedIds.length)
          return {
            result: { eventId: event.eventId, replayed: true, dayRevision: before.dayRevision },
          };
        const after = {
          events: p.events,
          dayRevision: before.dayRevision + 1,
          hasGaps: before.hasGaps,
        };
        return {
          write: after,
          result: { eventId: event.eventId, replayed: false, dayRevision: after.dayRevision },
        };
      });
      pending.delete(event.eventId);
      return { ok: true, value: result };
    } catch (e) {
      return commandFailure(e);
    }
  }
  const api = {
    async record(event: MaintenanceEvent) {
      try {
        appendMaintenanceEvents([], [event]);
        const old = pending.get(event.eventId);
        if (old && canonicalJson(old) !== canonicalJson(event))
          return {
            ok: false as const,
            code: 'INVALID_INPUT' as const,
            message: '事件 ID 与待补写内容冲突',
            retry: 'edit' as const,
          };
      } catch (e) {
        return {
          ok: false as const,
          code: 'INVALID_INPUT' as const,
          message: e instanceof Error ? e.message : '无效事件',
          retry: 'edit' as const,
        };
      }
      const frozen = structuredClone(event);
      pending.set(event.eventId, frozen);
      let result!: Awaited<ReturnType<typeof write>>;
      queue = queue.then(async () => {
        result = await write(frozen);
      });
      await queue;
      for (const fn of listeners)
        try {
          fn();
        } catch {}
      return result;
    },
    async retry() {
      await queue;
      for (const event of [...pending.values()]) await api.record(event);
      return { pendingCount: pending.size };
    },
    async read(input: { epoch: string; date: string; zone: string }): Promise<V06Result<Day>> {
      try {
        assertDate(input.date);
        assertZone(input.zone);
        if (!input.epoch.trim()) throw Error('工作区标识为空');
        await queue;
        if (!store.readMaintenance) throw Error('维护存储连接不可用');
        const d = parse(await store.readMaintenance(key(input)));
        return {
          ok: true,
          value: {
            ...structuredClone(d),
            hasGaps: d.hasGaps || [...pending.values()].some((e) => key(e) === key(input)),
          },
        };
      } catch (e) {
        return commandFailure(e);
      }
    },
    get pendingCount() {
      return pending.size;
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    async dates(epoch: string) {
      await queue;
      const keys = (await store.listMaintenanceKeys?.()) ?? [];
      const dates = new Map<string, { kind: 'maintenance'; date: string; zone: string }>();
      for (const k of [...keys, ...[...pending.values()].map(key)]) {
        const p = JSON.parse(k);
        if (Array.isArray(p) && p.length === 3 && p[0] === epoch) {
          assertDate(p[1]);
          assertZone(p[2]);
          dates.set(k, { kind: 'maintenance', date: p[1], zone: p[2] });
        }
      }
      return [...dates.values()];
    },
    close() {
      closed = true;
      listeners.clear();
    },
  };
  return api;
}
