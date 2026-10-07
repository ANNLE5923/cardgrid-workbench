import type { JournalEntry } from '../workspace/index.ts';
import type { JournalNote, LegacyJournalBlock, V06Command } from '../workspace/v06.ts';
import { validateV06Dto, validateV06CommandInput, V06ContractError } from '../workspace/v06.ts';
import { assertDate, assertInstant, assertZone, compareInstants, dateAt } from '../daily/time.ts';

export type JournalEditContext = Readonly<{
  at: string;
  workspaceZone: string | null;
  access: 'live' | 'archive';
  archiveDates?: readonly string[];
}>;
export type JournalEditDraft<T> = Readonly<{
  changed: boolean;
  before: T | null;
  after: T | null;
  operation: 'create' | 'update' | 'clear' | 'unchanged';
}>;
function fail(
  code: ConstructorParameters<typeof V06ContractError>[0],
  field: string,
  message: string,
): never {
  throw new V06ContractError(code, field, message);
}
function guard(date: string, zone: string, context: JournalEditContext): void {
  if (context.access !== 'live') fail('ARCHIVE_READ_ONLY', 'access', '历史归档只读');
  assertDate(date);
  assertZone(zone);
  assertInstant(context.at);
  if (context.workspaceZone !== null) assertZone(context.workspaceZone);
  if (date > dateAt(context.at, context.workspaceZone ?? zone))
    fail('FUTURE_DATE', 'date', '不能写未来感想或正文');
  if (context.archiveDates?.includes(date))
    fail('ARCHIVE_READ_ONLY', 'date', '已归档日期只读，请在当前日期记录新的感想');
}
function validateNote(note: JournalNote): void {
  validateV06Dto('note', note);
  if (
    compareInstants(note.recordedAt, note.createdAt) !== 0 ||
    compareInstants(note.updatedAt, note.createdAt) < 0
  )
    fail('INVALID_INPUT', 'note', '原记录时间须等于创建时刻，修改时间不能更早');
}
function advance(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1 || version === Number.MAX_SAFE_INTEGER)
    fail('INVALID_INPUT', 'version', '版本无效或无法递增');
  return version + 1;
}
export function toLegacyJournalBlock(entry: JournalEntry): LegacyJournalBlock {
  validateNote({ ...entry, kind: 'reflection', recordedAt: entry.createdAt });
  return { ...structuredClone(entry), kind: 'legacy-block' };
}
export function prepareJournalNote(
  input: Readonly<{
    command: Extract<V06Command, { type: 'SaveJournalNote' }>;
    notes: readonly JournalNote[];
    context: JournalEditContext;
    newId: () => string;
  }>,
): JournalEditDraft<JournalNote> {
  validateV06CommandInput(input.command);
  const request = input.command.payload;
  guard(request.date, request.zone, input.context);
  const matches = request.id === null ? [] : input.notes.filter((n) => n.id === request.id);
  if (request.id !== null && matches.length !== 1)
    fail('INVALID_INPUT', 'id', '感想 ID 不存在或不唯一');
  const before = matches[0] ?? null;
  if (before) {
    validateNote(before);
    if (before.version !== request.expectedVersion)
      fail('ENTRY_STALE', 'expectedVersion', '感想已变化');
    if (before.date !== request.date || before.zone !== request.zone)
      fail('INVALID_INPUT', 'date', '修改不能移动感想的原归属日或时区');
    if (compareInstants(input.context.at, before.updatedAt) < 0)
      fail('INVALID_INPUT', 'at', '修改时间不能倒退');
    if (before.text === request.text)
      return {
        changed: false,
        before: structuredClone(before),
        after: structuredClone(before),
        operation: 'unchanged',
      };
  } else if (!request.text.trim())
    return { changed: false, before: null, after: null, operation: 'unchanged' };
  const after: JournalNote = before
    ? {
        ...structuredClone(before),
        version: advance(before.version),
        text: request.text,
        updatedAt: input.context.at,
      }
    : {
        id: input.newId(),
        version: 1,
        kind: 'reflection',
        date: request.date,
        zone: request.zone,
        text: request.text,
        recordedAt: input.context.at,
        createdAt: input.context.at,
        updatedAt: input.context.at,
      };
  validateNote(after);
  if (!before && input.notes.some((n) => n.id === after.id))
    fail('INVALID_INPUT', 'id', '新感想 ID 已占用');
  return {
    changed: true,
    before: before ? structuredClone(before) : null,
    after,
    operation: before ? (request.text.trim() ? 'update' : 'clear') : 'create',
  };
}
export function prepareLegacyJournalEdit(
  input: Readonly<{
    command: Extract<V06Command, { type: 'SaveLegacyJournalBlock' }>;
    entries: readonly JournalEntry[];
    context: JournalEditContext;
  }>,
): JournalEditDraft<JournalEntry> {
  validateV06CommandInput(input.command);
  const request = input.command.payload;
  const matches = input.entries.filter((e) => e.id === request.entry.id);
  if (matches.length !== 1) fail('INVALID_INPUT', 'entry', '旧正文不存在或 ID 不唯一');
  const before = matches[0];
  toLegacyJournalBlock(before);
  guard(before.date, before.zone, input.context);
  if (before.version !== request.entry.version)
    fail('ENTRY_STALE', 'entry.version', '旧正文已变化');
  if (compareInstants(input.context.at, before.updatedAt) < 0)
    fail('INVALID_INPUT', 'at', '修改时间不能倒退');
  if (before.text === request.text)
    return {
      changed: false,
      before: structuredClone(before),
      after: structuredClone(before),
      operation: 'unchanged',
    };
  return {
    changed: true,
    before: structuredClone(before),
    after: {
      ...structuredClone(before),
      version: advance(before.version),
      text: request.text,
      updatedAt: input.context.at,
    },
    operation: request.text.trim() ? 'update' : 'clear',
  };
}
