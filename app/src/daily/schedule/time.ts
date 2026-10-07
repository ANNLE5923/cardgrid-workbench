import { Temporal } from '@js-temporal/polyfill';
import type { ErrorCode, LocalInput, Range, RecordedRange } from '../../workspace/index.ts';

export type LocalChoice = Readonly<{ input: LocalInput; instant: string }>;
export class ActionTimeError extends Error {
  readonly code: ErrorCode;
  readonly field: string;
  readonly choices: readonly LocalChoice[];
  constructor(
    code: ErrorCode,
    field: string,
    message: string,
    choices: readonly LocalChoice[] = [],
  ) {
    super(message);
    this.name = 'ActionTimeError';
    this.code = code;
    this.field = field;
    this.choices = choices;
  }
}
function invalid(field: string, message: string): never {
  throw new ActionTimeError('INVALID_INPUT', field, message);
}
export function assertDate(value: string): void {
  try {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Temporal.PlainDate.from(value).toString() !== value)
      invalid('date', '日期无效');
  } catch {
    invalid('date', '日期必须是有效的 YYYY-MM-DD');
  }
}
export function assertZone(zone: string): void {
  try {
    if (typeof zone !== 'string' || !zone || /^[+\-\u2212]/.test(zone))
      invalid('zone', '需要 IANA 时区');
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(zone);
  } catch {
    invalid('zone', '时区无效');
  }
}
function instant(value: string): Temporal.Instant {
  try {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z$/.test(value)
    )
      invalid('instant', '需要明确的 UTC 时间点');
    return Temporal.Instant.from(value);
  } catch {
    return invalid('instant', '时间点无效');
  }
}
export function assertInstant(value: string): void {
  instant(value);
}
/** Legacy validation only; callers preserve the original text instead of storing this conversion. */
export function legacyInstant(value: string): string {
  try {
    if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value))
      invalid('instant', '旧时间点缺少偏移');
    return Temporal.Instant.from(value).toString();
  } catch {
    return invalid('instant', '旧时间点无效');
  }
}
export function nextDate(date: string, days = 1): string {
  assertDate(date);
  return Temporal.PlainDate.from(date).add({ days }).toString();
}
export function weekday(date: string): number {
  assertDate(date);
  return Temporal.PlainDate.from(date).dayOfWeek % 7;
}
export function compareInstants(a: string, b: string): number {
  return Temporal.Instant.compare(instant(a), instant(b));
}
export function dateAt(value: string, zone: string): string {
  assertZone(zone);
  return instant(value).toZonedDateTimeISO(zone).toPlainDate().toString();
}
/** Compare resolved instants; an unresolved repeated minute warns if either choice is future. */
export function localMinuteIsFuture(input: LocalInput, at: string): boolean {
  try {
    const now = instant(at);
    if (input.offset !== undefined)
      return Temporal.Instant.compare(instant(resolveLocal(input).instant), now) > 0;
    return candidates(plain(input), input.zone).some(
      (option) => Temporal.Instant.compare(option.toInstant(), now) > 0,
    );
  } catch {
    return false;
  } // Partial, invalid and nonexistent input is rejected by the preview.
}

function plain(input: LocalInput): Temporal.PlainDateTime {
  assertDate(input.date);
  assertZone(input.zone);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time))
    invalid('time', '时间必须精确到分钟（HH:mm）');
  return Temporal.PlainDateTime.from(`${input.date}T${input.time}`);
}
function candidates(value: Temporal.PlainDateTime, zone: string): Temporal.ZonedDateTime[] {
  const options = (['earlier', 'later'] as const).map((disambiguation) =>
    value.toZonedDateTime(zone, { disambiguation }),
  );
  return options.filter(
    (option, index) =>
      option.toPlainDateTime().equals(value) &&
      options.findIndex((other) => other.epochNanoseconds === option.epochNanoseconds) === index,
  );
}
/** No implicit DST choice: the caller receives both offsets when a local minute repeats. */
export function resolveLocal(input: LocalInput): Readonly<{ instant: string; offset: string }> {
  const options = candidates(plain(input), input.zone);
  if (!options.length)
    throw new ActionTimeError('NONEXISTENT_LOCAL_TIME', 'time', '该当地时间不存在');
  if (input.offset !== undefined) {
    const selected = options.find((option) => option.offset === input.offset);
    if (!selected) invalid('offset', '所选偏移不属于该当地时间');
    return { instant: selected.toInstant().toString(), offset: selected.offset };
  }
  if (options.length > 1)
    throw new ActionTimeError(
      'AMBIGUOUS_LOCAL_TIME',
      'offset',
      '请选择明确的时区偏移',
      options.map((option) => ({
        input: { ...input, offset: option.offset },
        instant: option.toInstant().toString(),
      })),
    );
  return { instant: options[0].toInstant().toString(), offset: options[0].offset };
}
export function assertRange(range: Range): void {
  assertZone(range.zone);
  if (compareInstants(range.startAt, range.endAt) >= 0) invalid('range', '结束时间必须晚于开始');
}
function localMinute(value: Temporal.ZonedDateTime): string {
  if (value.second || value.millisecond || value.microsecond || value.nanosecond)
    invalid('range', '起止必须精确到当地分钟');
  return value.toPlainDateTime().toString({ smallestUnit: 'minute' });
}
export function recordRange(range: Range): RecordedRange {
  assertRange(range);
  const start = instant(range.startAt).toZonedDateTimeISO(range.zone);
  const end = instant(range.endAt).toZonedDateTimeISO(range.zone);
  return {
    startAt: start.toInstant().toString(),
    endAt: end.toInstant().toString(),
    zone: range.zone,
    localStart: localMinute(start),
    localEnd: localMinute(end),
    startOffset: start.offset,
    endOffset: end.offset,
  };
}
/** Validate stored snapshots without normalizing or replacing them. */
export function assertRecordedRange(range: RecordedRange): void {
  const expected = recordRange(range);
  for (const key of ['localStart', 'localEnd', 'startOffset', 'endOffset'] as const)
    if (range[key] !== expected[key]) invalid(`range.${key}`, '当地时间快照与时间点不一致');
}
export function actualRange(start: LocalInput, end: LocalInput): RecordedRange {
  if (start.zone !== end.zone) invalid('zone', '一次记录的起止须使用同一记录时区');
  return recordRange({
    startAt: resolveLocal(start).instant,
    endAt: resolveLocal(end).instant,
    zone: start.zone,
  });
}
export function assertPresetMinutes(minutes: number | null): void {
  if (minutes === null) return;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440 || minutes % 5 !== 0)
    throw new ActionTimeError(
      'INVALID_GRID',
      'presetMinutes',
      '预设时长须为 5—1440 分钟且是 5 的倍数',
    );
}
export function plannedRange(start: LocalInput, minutes: number | null): RecordedRange {
  assertPresetMinutes(minutes);
  if (minutes === null)
    throw new ActionTimeError('DURATION_REQUIRED', 'presetMinutes', '安排前请补齐时长');
  const local = plain(start);
  if (local.minute % 5) throw new ActionTimeError('INVALID_GRID', 'time', '起点须落在 5 分钟网格');
  const startAt = resolveLocal(start).instant;
  return recordRange({
    startAt,
    endAt: instant(startAt).add({ minutes }).toString(),
    zone: start.zone,
  });
}
export function assertPlannedRange(range: RecordedRange, minutes: number | null): void {
  assertRecordedRange(range);
  const expected = plannedRange(
    {
      date: range.localStart.slice(0, 10),
      time: range.localStart.slice(11),
      zone: range.zone,
      offset: range.startOffset,
    },
    minutes,
  );
  if (compareInstants(expected.endAt, range.endAt) !== 0)
    invalid('range', '安排必须保留完整预设时长');
}
export function elapsedMinutes(range: Range): number {
  assertRange(range);
  return (
    Number(instant(range.endAt).epochNanoseconds - instant(range.startAt).epochNanoseconds) / 60e9
  );
}
/** Midnight can be skipped; an entirely missing date is rejected, not shown as an empty day. */
export function dayRange(date: string, zone: string): Range {
  assertDate(date);
  assertZone(zone);
  const day = Temporal.PlainDate.from(date);
  const start = day.toZonedDateTime(zone);
  if (start.toPlainDate().toString() !== date)
    throw new ActionTimeError('NONEXISTENT_LOCAL_TIME', 'date', '该时区不存在这一天');
  return {
    startAt: start.toInstant().toString(),
    endAt: day.add({ days: 1 }).toZonedDateTime(zone).toInstant().toString(),
    zone,
  };
}
export function intersectRanges(a: Range, b: Range): Range | null {
  assertRange(a);
  assertRange(b);
  const startAt = compareInstants(a.startAt, b.startAt) >= 0 ? a.startAt : b.startAt;
  const endAt = compareInstants(a.endAt, b.endAt) <= 0 ? a.endAt : b.endAt;
  return compareInstants(startAt, endAt) < 0 ? { startAt, endAt, zone: a.zone } : null;
}
export function unionRanges(ranges: readonly Range[], zone: string): readonly Range[] {
  assertZone(zone);
  ranges.forEach(assertRange);
  const sorted = [...ranges].sort((a, b) => compareInstants(a.startAt, b.startAt));
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && compareInstants(range.startAt, last.endAt) <= 0) {
      if (compareInstants(range.endAt, last.endAt) > 0)
        merged[merged.length - 1] = { ...last, endAt: range.endAt };
    } else merged.push({ startAt: range.startAt, endAt: range.endAt, zone });
  }
  return merged;
}
export function freeRanges(query: Range, occupied: readonly Range[]): readonly Range[] {
  assertRange(query);
  const merged = unionRanges(
    occupied.flatMap((range) => {
      const overlap = intersectRanges(query, range);
      return overlap ? [overlap] : [];
    }),
    query.zone,
  );
  const free: Range[] = [];
  let cursor = query.startAt;
  for (const range of merged) {
    if (compareInstants(cursor, range.startAt) < 0)
      free.push({ startAt: cursor, endAt: range.startAt, zone: query.zone });
    cursor = range.endAt;
  }
  if (compareInstants(cursor, query.endAt) < 0)
    free.push({ startAt: cursor, endAt: query.endAt, zone: query.zone });
  return free;
}
export type DaySlice = Readonly<{
  range: Range;
  half: 0 | 1;
  offset: string;
  continuesBefore: boolean;
  continuesAfter: boolean;
}>;
export function displayInstant(
  value: string,
  zone: string,
): Readonly<{ date: string; time: string; minute: number; offset: string }> {
  assertZone(zone);
  const local = instant(value).toZonedDateTimeISO(zone);
  return {
    date: local.toPlainDate().toString(),
    time: `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`,
    minute: local.hour * 60 + local.minute,
    offset: local.offset,
  };
}
/** Display pieces only: callers retain the source ID. Split at noon and offset changes. */
export function splitRangeForDay(source: Range, date: string, zone: string): readonly DaySlice[] {
  const day = dayRange(date, zone);
  const clipped = intersectRanges(day, source);
  if (!clipped) return [];
  const boundaries = [clipped.startAt, clipped.endAt];
  for (const noon of candidates(Temporal.PlainDateTime.from(`${date}T12:00`), zone))
    boundaries.push(noon.toInstant().toString());
  let transition = instant(clipped.startAt).toZonedDateTimeISO(zone).getTimeZoneTransition('next');
  while (transition && compareInstants(transition.toInstant().toString(), clipped.endAt) < 0) {
    boundaries.push(transition.toInstant().toString());
    transition = transition.getTimeZoneTransition('next');
  }
  const points = [...new Set(boundaries.map((value) => instant(value).toString()))]
    .filter(
      (value) =>
        compareInstants(value, clipped.startAt) >= 0 && compareInstants(value, clipped.endAt) <= 0,
    )
    .sort(compareInstants);
  return points.slice(0, -1).map((startAt, i) => {
    const local = instant(startAt).toZonedDateTimeISO(zone);
    const endAt = points[i + 1];
    return {
      range: { startAt, endAt, zone },
      half: local.hour < 12 ? 0 : 1,
      offset: local.offset,
      continuesBefore:
        compareInstants(startAt, day.startAt) === 0 &&
        compareInstants(source.startAt, day.startAt) < 0,
      continuesAfter:
        compareInstants(endAt, day.endAt) === 0 && compareInstants(source.endAt, day.endAt) > 0,
    };
  });
}
