/**
 * A6 in-memory test adapter for JournalSessionPort. Synthetic data only; no
 * IndexedDB, no personal data, no real file writes. It keeps the underlying
 * DataV4 dial (so the walkthrough can place/move/retract breakfast), the
 * independent reflections, a migrated legacy block, and a simplified file
 * state. Projection and note edits are computed by the B3 pure rules.
 */
import {projectJournalTimeline, prepareJournalNote} from '../../../src/journal/model.ts';
import type {JournalProjectionInput} from '../../../src/journal/model.ts';
import type {JournalEntry, JournalNote, V06Command} from '../../../src/workspace/v06.ts';
import {V06ContractError} from '../../../src/workspace/v06.ts';
import {recordRange} from '../../../src/daily/time.ts';
import {AT, TOKEN, journal} from './fixtures.ts';
import {data as baseData, projectionInput as baseProjectionInput, ZONE, DATE} from './b3-fixtures.ts';
import type {
  JournalResult, JournalSessionPort, JournalSessionStamp, JournalTimelineView,
  JournalFileState, JournalFileStatus, SaveNoteRequest, SaveNoteValue,
} from '../../../src/journal/ui/journal-session.ts';

const LEGACY: JournalEntry = {
  id: 'legacy-1', version: 1, date: DATE, zone: ZONE,
  text: '这是从 v0.5 迁移的旧整篇正文（旧正文块，不拆段）。',
  createdAt: '2026-10-05T22:10:00Z', updatedAt: '2026-10-05T22:10:00Z',
};
const ARCHIVE_DATE = '2026-09-30';

export type JournalTestSession = JournalSessionPort & Readonly<{
  // Test-only dial / fault controls; the real UI never calls these.
  moveBreakfastTo10: () => void;
  retractBreakfast: () => void;
  restoreBreakfast: () => void;
  setFileStatus: (status: JournalFileStatus) => JournalFileState;
  reauthorizeFile: () => void;
  setNow: (at: string) => void;
}>;

export function createJournalTestSession(): JournalTestSession {
  let value = structuredClone(baseData());
  let notes: readonly JournalNote[] = structuredClone(journal.notes);
  const legacyEntries: JournalEntry[] = [structuredClone(LEGACY)];
  const archiveDates = [ARCHIVE_DATE];
  let now = AT;
  let seq = 0;
  const newId = () => `test-note-${++seq}`;
  const fileKey = (date: string, zone: string) => `${date}|${zone}`;
  const files = new Map<string, JournalFileState>([
    [fileKey(DATE, ZONE), {
      status: 'synced', lastSuccessAt: AT,
      message: '文本文件已同步（测试适配器模拟）',
    }],
  ]);
  const setFile = (date: string, zone: string, patch: JournalFileState) =>
    files.set(fileKey(date, zone), patch);
  const markPending = (date: string, zone: string) =>
    setFile(date, zone, {
      status: 'pending', lastSuccessAt: files.get(fileKey(date, zone))?.lastSuccessAt ?? null,
      message: '主数据已保存，当日文本排队待写入（测试适配器模拟）',
    });

  const buildInput = (date: string, zone: string): JournalProjectionInput => {
    const input = baseProjectionInput(value, date, zone);
    return {...input, notes, legacyEntries};
  };

  const port: JournalSessionPort = {
    stamp: {contractVersion: 'v06-p0-1', backend: 'test-adapter', release: 'draft'},

    async readTimeline({date, zone}): Promise<JournalResult<JournalTimelineView>> {
      try {
        const projection = projectJournalTimeline(buildInput(date, zone));
        const archived = archiveDates.includes(date);
        const view: JournalTimelineView = archived
          ? {access: 'archive', editable: false, date, zone, projection}
          : {access: 'live', editable: true, date, zone, projection};
        return {ok: true, value: view};
      } catch (e) {
        return {ok: false, code: errorCode(e), message: errorMessage(e)};
      }
    },

    async saveNote(req: SaveNoteRequest): Promise<JournalResult<SaveNoteValue>> {
      try {
        const archived = archiveDates.includes(req.date);
        const command: Extract<V06Command, {type: 'SaveJournalNote'}> = {
          contractVersion: 'v06-p0-1', commandId: `test-cmd-${++seq}`,
          expected: TOKEN, type: 'SaveJournalNote',
          payload: {
            id: req.id, date: req.date, zone: req.zone,
            text: req.text, expectedVersion: req.expectedVersion,
          },
        };
        const draft = prepareJournalNote({
          command, notes,
          context: {
            at: now, workspaceZone: ZONE,
            access: archived ? 'archive' : 'live', archiveDates,
          },
          newId,
        });
        if (draft.changed && draft.after) {
          notes = draft.before
            ? notes.map(n => (n.id === draft.after!.id ? draft.after! : n))
            : [...notes, draft.after];
          markPending(req.date, req.zone);
        }
        const note = draft.after ?? draft.before;
        if (!note) return {ok: false, code: 'INVALID_INPUT', message: '空白内容不建档'};
        return {
          ok: true,
          value: {note, token: TOKEN, operation: draft.operation},
        };
      } catch (e) {
        return {ok: false, code: errorCode(e), message: errorMessage(e)};
      }
    },

    async readFileState({date, zone}): Promise<JournalResult<JournalFileState>> {
      return {ok: true, value: files.get(fileKey(date, zone)) ?? {
        status: 'synced', lastSuccessAt: AT, message: '文本文件已同步（测试适配器模拟）'}};
    },

    async writeFileNow({date, zone}): Promise<JournalResult<JournalFileState>> {
      const current = files.get(fileKey(date, zone));
      if (current?.status === 'permission-required')
        return {ok: false, code: 'PERMISSION_REQUIRED', message: '目录授权已失效，请先重新授权'};
      const next: JournalFileState = {
        status: 'synced', lastSuccessAt: now,
        message: `文本文件已写入（测试适配器模拟）：${date} ${zone}`,
      };
      setFile(date, zone, next);
      return {ok: true, value: next};
    },

    async retryFile({date, zone}): Promise<JournalResult<JournalFileState>> {
      const next: JournalFileState = {
        status: 'synced', lastSuccessAt: now,
        message: '重试写入成功（测试适配器模拟）',
      };
      setFile(date, zone, next);
      return {ok: true, value: next};
    },

    async reauthorizeFile({date, zone}): Promise<JournalResult<JournalFileState>> {
      markPending(date, zone);
      return {ok: true, value: files.get(fileKey(date, zone))!};
    },
  };

  // --- Test-only controls ---
  const updateBreakfastPlan = (rangeStart: string, rangeEnd: string) => {
    value = {
      ...value,
      planner: {
        ...value.planner,
        plans: value.planner.plans.map(p => p.id === 'plan-breakfast'
          ? {...p, range: recordRange({startAt: rangeStart, endAt: rangeEnd, zone: ZONE}), changedAt: now}
          : p),
      },
    };
    markPending(DATE, ZONE);
  };
  const extras: Omit<JournalTestSession, keyof JournalSessionPort> = {
    moveBreakfastTo10: () => updateBreakfastPlan('2026-10-06T02:00:00Z', '2026-10-06T02:30:00Z'),
    retractBreakfast: () => {
      value = {
        ...value,
        planner: {...value.planner, plans: value.planner.plans.filter(p => p.id !== 'plan-breakfast')},
      };
      markPending(DATE, ZONE);
    },
    restoreBreakfast: () => {
      const original = structuredClone(baseData()).planner.plans
        .find(p => p.id === 'plan-breakfast')!;
      value = {
        ...value,
        planner: {
          ...value.planner,
          plans: value.planner.plans.some(p => p.id === 'plan-breakfast')
            ? value.planner.plans.map(p => p.id === 'plan-breakfast'
              ? {...original, changedAt: now} : p)
            : [...value.planner.plans, {...original, changedAt: now}],
        },
      };
      markPending(DATE, ZONE);
    },
    setFileStatus: status => {
      setFile(DATE, ZONE, {
        status, lastSuccessAt: files.get(fileKey(DATE, ZONE))?.lastSuccessAt ?? AT,
        message:
          status === 'error' ? '文件写入失败：主数据与随记仍保留，可重试（测试适配器模拟）'
          : status === 'permission-required' ? '目录授权已失效：主数据与随记仍保留，请重新授权（测试适配器模拟）'
          : status === 'pending' ? '主数据已保存，当日文本排队待写入（测试适配器模拟）'
          : '文本文件已同步（测试适配器模拟）',
      });
      return files.get(fileKey(DATE, ZONE))!;
    },
    setNow: at => {now = at;},
  };
  return Object.assign(port, extras);
}

const errorCode = (e: unknown): string =>
  e instanceof V06ContractError ? e.code : 'INVALID_INPUT';
const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
