import type { Command, EntityRef, History, ErrorCode } from './contracts.ts';
import type { DataV4, JournalEntry } from './contracts-v4.ts';
import type { DataV3 } from './contracts-v3.ts';
import { applyV3Command, type V3Command } from './v3-operations.ts';
import {
  ActionDomainError,
  assertActionTransition,
  type TransitionContext,
} from '../daily/model.ts';
import { assertDate, assertInstant, assertZone, dateAt } from '../daily/time.ts';

type V4Type = 'SaveJournalEntry';
export type V4Command = Extract<Command, { type: V4Type }>;
const types: readonly string[] = ['SaveJournalEntry'];
export const isV4Command = (command: Command): command is V4Command => types.includes(command.type);

function need(condition: unknown, code: ErrorCode, message: string): asserts condition {
  if (!condition) throw new ActionDomainError(code, message);
}

type Change = Readonly<{ data: DataV4; resultRefs: readonly EntityRef[]; changed: boolean }>;
function history(
  context: TransitionContext,
  type: string,
  entity: EntityRef,
  before: unknown,
  after: unknown,
  suffix: string,
): History {
  return {
    id: `${context.historyId}:${suffix}`,
    commandId: context.commandId,
    at: context.at,
    date: context.date,
    type,
    entity,
    before: structuredClone(before) as History['before'],
    after: structuredClone(after) as History['after'],
  };
}

/** v4 post-state invariants. Runs after strict shapes and v3 invariants; no writes or lifecycle side effects. */
export function assertV4State(data: DataV4): void {
  const ids = new Set<string>(),
    keys = new Set<string>();
  for (const entry of data.journalEntries) {
    if (ids.has(entry.id)) throw new Error('日记标识重复');
    ids.add(entry.id);
    const key = JSON.stringify([entry.date, entry.zone]);
    if (keys.has(key)) throw new Error('同一天同一时区只能有一篇日记');
    keys.add(key);
  }
}

/**
 * SaveJournalEntry — upsert a day-keyed diary entry.
 *  - No record & blank text → nothing (lazy creation; browsing never creates data).
 *  - No record & non-blank text → create at version 1.
 *  - Existing record → update text (blank allowed, record kept), version + 1.
 *  - Future dates are rejected.
 */
export function applyV4Command(
  data: DataV4,
  command: V4Command,
  context: TransitionContext,
  newId: () => string,
): Change {
  assertInstant(context.at);
  assertDate(context.date);
  const { date, zone, text } = command.payload;
  assertDate(date);
  assertZone(zone);
  need(typeof text === 'string', 'INVALID_INPUT', '日记需要文本');
  // Future-date protection follows the current workspace zone, not the entry's own zone:
  // a payload carrying a different zone must not bypass the workspace's today.
  const guardZone = data.settings.zone ?? zone;
  const today = dateAt(context.at, guardZone);
  need(date <= today, 'FUTURE_DATE', '不能写未来的日记');

  const previous = data.journalEntries.find((e) => e.date === date && e.zone === zone);
  let result: Change;
  if (!previous) {
    if (text.trim().length === 0) return { data, resultRefs: [], changed: false };
    const entry: JournalEntry = {
      id: newId(),
      version: 1,
      date,
      zone,
      text,
      createdAt: context.at,
      updatedAt: context.at,
    };
    const log = history(
      context,
      'SaveJournalEntry',
      { kind: 'journal-entry', id: entry.id },
      null,
      entry,
      'journal',
    );
    result = {
      data: {
        ...data,
        journalEntries: [...data.journalEntries, entry],
        planner: { ...data.planner, history: [...data.planner.history, log] },
      },
      resultRefs: [{ kind: 'journal-entry', id: entry.id }],
      changed: true,
    };
  } else {
    const entry: JournalEntry = {
      ...previous,
      text,
      version: previous.version + 1,
      updatedAt: context.at,
    };
    const log = history(
      context,
      'SaveJournalEntry',
      { kind: 'journal-entry', id: entry.id },
      previous,
      entry,
      'journal',
    );
    result = {
      data: {
        ...data,
        journalEntries: data.journalEntries.map((e) => (e.id === entry.id ? entry : e)),
        planner: { ...data.planner, history: [...data.planner.history, log] },
      },
      resultRefs: [{ kind: 'journal-entry', id: entry.id }],
      changed: true,
    };
  }
  assertActionTransition(data, result.data);
  return result;
}

/**
 * Run a v3 workshop command on v4 data: execute against the v3 collections, then reattach
 * the journal so it is preserved. v3 logic never touches journalEntries.
 */
export function applyV3CommandOnV4(
  data: DataV4,
  command: V3Command,
  context: TransitionContext,
  newId: () => string,
): Change {
  const journalEntries = data.journalEntries;
  const v3Input = { ...data, version: 3 } as unknown as DataV3;
  const result = applyV3Command(v3Input, command, context, newId);
  const nextData: DataV4 = { ...result.data, version: 4, journalEntries };
  return { data: nextData, resultRefs: result.resultRefs, changed: result.changed };
}
