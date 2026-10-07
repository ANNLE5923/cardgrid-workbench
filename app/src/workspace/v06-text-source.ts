import type { Token } from './contracts.ts';
import type { DataV5, MaintenanceEvent, V06Result } from './contracts-v06.ts';
import type { WorkspaceStore } from './store.ts';
import type { createV06Maintenance } from './v06-maintenance.ts';
import { projectJournalTimeline, prepareJournalText } from '../journal/model.ts';
import { prepareMaintenanceText, createOperationEvent } from '../maintenance/model.ts';
import { TextFileError, type TextSourceProvider, type OutputDate } from '../text-output/index.ts';
import {
  dateAt,
  nextDate,
  dayRange,
  compareInstants,
  assertDate,
  assertZone,
} from '../daily/time.ts';
import { todayView } from './v5-today.ts';

/** Outputs are derived from strictly validated sources; discovery retains historical touched days. */
type SourceHost = {
  loadV5(): Promise<V06Result<{ token: Token; data: DataV5 }>>;
  readMaintenanceDay(input: {
    epoch: string;
    date: string;
    zone: string;
  }): Promise<
    V06Result<{ events: readonly MaintenanceEvent[]; dayRevision: number; hasGaps: boolean }>
  >;
};
export function createV06TextSource(input: {
  store: WorkspaceStore;
  host: SourceHost;
  maintenance: ReturnType<typeof createV06Maintenance>;
  now: () => string;
  id: () => string;
  archives?: Pick<ReturnType<typeof import('./v06-archives.ts').createV06Archives>, 'fullJournal'>;
}): TextSourceProvider {
  const { store, host, maintenance, now, id } = input;
  const data = async () => {
    const r = await host.loadV5();
    if (!r.ok)
      throw new TextFileError(
        r.code === 'WORKSPACE_REPLACED' || r.code === 'UNSUPPORTED_VERSION'
          ? 'WORKSPACE_REPLACED'
          : 'IO_FAILED',
        r.message,
      );
    return r.value;
  };
  return {
    async context() {
      const raw = (await store.read()) as {
        epoch?: string;
        revision?: number;
        data?: { version?: number; settings?: { zone?: string | null } };
      };
      return {
        epoch: raw?.epoch ?? 'uninitialized',
        revision: raw?.revision ?? 0,
        zone: raw?.data?.settings?.zone ?? 'UTC',
        v5: raw?.data?.version === 5,
      };
    },
    async dates() {
      const s = await data(),
        zone = s.data.settings.zone ?? 'UTC',
        dates = new Map<string, OutputDate>();
      const add = (date: string, z = zone) => {
        assertDate(date);
        assertZone(z);
        const d = { kind: 'journal' as const, date, zone: z };
        dates.set(JSON.stringify(d), d);
      };
      add(dateAt(now(), zone));
      for (const note of [...s.data.journalNotes, ...s.data.journalEntries]) {
        add(note.date, note.zone);
        add(note.date);
      }
      const ranges = [
        ...s.data.planner.plans.map((p) => p.range),
        ...s.data.planner.facts.map((p) => p.actualRange),
        ...s.data.planner.fixed.map((p) => p.range),
      ];
      for (const h of s.data.planner.history)
        if (['plan', 'fact', 'fixed'].includes(h.entity.kind))
          for (const item of [h.before, h.after]) {
            const old = item as {
              range?: (typeof ranges)[number];
              actualRange?: (typeof ranges)[number];
            } | null;
            const range = old?.range ?? old?.actualRange;
            if (range) ranges.push(range);
          }
      for (const range of ranges)
        for (const z of new Set([zone, range.zone])) {
          const end = dateAt(range.endAt, z);
          for (let date = dateAt(range.startAt, z); date <= end; date = nextDate(date)) {
            if (compareInstants(dayRange(date, z).startAt, range.endAt) < 0) add(date, z);
          }
        }
      for (const day of s.data.planner.days) add(day.date);
      for (const r of s.data.referencePlacements)
        if (r.mode === 'point') {
          add(dateAt(r.point.at, zone));
          add(dateAt(r.point.at, r.point.zone), r.point.zone);
        }
      for (const index of s.data.archiveIndex)
        for (const date of index.coveredDates) {
          add(date, index.zone);
          add(date);
        }
      const maintenanceDates = await maintenance.dates(s.token.epoch);
      for (const d of maintenanceDates) dates.set(JSON.stringify(d), d);
      return [...dates.values()];
    },
    async render(key) {
      assertDate(key.date);
      assertZone(key.zone);
      const s = await data();
      if (key.epoch !== s.token.epoch)
        throw new TextFileError('WORKSPACE_REPLACED', '工作区已替换，旧任务不能生成新文件');
      if (key.kind === 'journal' && s.data.archiveIndex.length) {
        if (!input.archives) throw new TextFileError('IO_FAILED', '归档覆盖不可用，未覆盖历史文件');
        try {
          return await input.archives.fullJournal(s.token, key.date, key.zone);
        } catch (e) {
          const code = (e as { code?: string })?.code;
          // A revision race is retryable by the queued source notification;
          // missing/corrupt history needs a visible failure and explicit repair.
          throw new TextFileError(
            code === 'WORKSPACE_REPLACED'
              ? 'WORKSPACE_REPLACED'
              : code === 'REVISION_CONFLICT'
                ? 'SOURCE_STALE'
                : 'IO_FAILED',
            e instanceof Error ? e.message : '历史归档缺失，未覆盖旧日文件',
          );
        }
      }
      if (key.kind === 'journal') {
        const day = todayView(s.data, s.token, key, now()),
          projection = projectJournalTimeline({
            day,
            templates: s.data.planner.templates,
            notes: s.data.journalNotes,
            legacyEntries: s.data.journalEntries,
            materials: s.data.handCards,
            references: s.data.referencePlacements,
            factReferences: s.data.factReferenceSnapshots,
          });
        return prepareJournalText(projection);
      }
      if (key.kind !== 'maintenance') throw new TextFileError('SOURCE_STALE', '未知文本种类');
      const r = await host.readMaintenanceDay({ epoch: key.epoch, date: key.date, zone: key.zone });
      if (!r.ok) throw new TextFileError('IO_FAILED', r.message);
      if (r.value.hasGaps)
        throw new TextFileError(
          'IO_FAILED',
          '维护日志仍有未落库事件，请先补写日志再同步文件；原成功文件保留',
        );
      return prepareMaintenanceText({
        epoch: key.epoch,
        date: key.date,
        zone: key.zone,
        ...r.value,
      });
    },
    subscribe(fn) {
      const off = store.subscribe(() => fn()),
        logOff = maintenance.subscribe(fn);
      return () => {
        off();
        logOff();
      };
    },
    async event(e) {
      const c = (await store.read()) as { data?: { settings?: { zone?: string | null } } };
      await maintenance.record(
        createOperationEvent({
          eventId: id(),
          epoch: e.epoch,
          at: now(),
          zone: c?.data?.settings?.zone ?? 'UTC',
          category: 'file',
          operation: e.operation,
          stage: e.stage,
          commandId: null,
          entityRefs: [],
          errorCode: e.errorCode ?? null,
          details: {
            bindingId: e.bindingId,
            connectionVersion: e.connectionVersion,
            ...(e.key ? { outputKind: e.key.kind } : {}),
          },
        }),
      );
    },
  };
}
