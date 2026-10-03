import type { Instant, LocalDate, LocalInput, Range } from '../../../../产品设计/1C-prototype-contract.ts';

const localFormats = new Map<string, Intl.DateTimeFormat>();
const offsetFormats = new Map<string, Intl.DateTimeFormat>();
function fmt(zone: string, offset = false): Intl.DateTimeFormat {
  const cache = offset ? offsetFormats : localFormats;
  let value = cache.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(offset ? { timeZoneName: 'shortOffset' } : {}) });
    cache.set(zone, value);
  }
  return value;
}
export function localParts(instant: string | number, zone: string) {
  const p = Object.fromEntries(fmt(zone).formatToParts(new Date(instant)).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}
export function offsetMinutes(instant: string | number, zone: string): number {
  const raw = fmt(zone, true).formatToParts(new Date(instant)).find(x => x.type === 'timeZoneName')?.value ?? '';
  if (raw === 'GMT' || raw === 'UTC') return 0;
  const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(raw);
  if (!m) throw Error(`不支持的时区偏移 ${raw}`);
  return (m[1] === '+' ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}
export function offsetLabel(instant: string | number, zone: string): string {
  const n = offsetMinutes(instant, zone);
  return `${n >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(n) / 60)).padStart(2, '0')}:${String(Math.abs(n) % 60).padStart(2, '0')}`;
}
export function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === date;
}
export function addDate(date: LocalDate, days: number): LocalDate {
  if (!validDate(date)) throw Error(`无效日期 ${date}`);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
export function resolveLocal(input: LocalInput): Instant[] {
  if (!validDate(input.date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw Error('无效的本地日期或时间');
  const [year, month, day] = input.date.split('-').map(Number);
  const [hour, minute] = input.time.split(':').map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) offsets.add(offsetMinutes(naive + delta * 3600000, input.zone));
  const matches: Instant[] = [];
  for (const offset of offsets) {
    const ts = naive - offset * 60000;
    const local = localParts(ts, input.zone);
    const label = offsetLabel(ts, input.zone);
    if (local.date === input.date && local.hour === hour && local.minute === minute && (!input.offset || input.offset === label)) matches.push(new Date(ts).toISOString());
  }
  return matches.sort();
}
export function oneLocal(input: LocalInput): Instant {
  const found = resolveLocal(input);
  if (found.length !== 1) throw Error(found.length ? '重复本地时间需选择偏移' : '本地时间不存在');
  return found[0];
}
export function at(date: string, time: string, zone = 'Asia/Shanghai', offset?: string): Instant { return oneLocal({ date, time, zone, offset }); }
export function range(startAt: Instant, endAt: Instant, zone: string): Range {
  if (!(Date.parse(startAt) < Date.parse(endAt))) throw Error('时间区间必须向前');
  return { startAt, endAt, zone };
}
export function dayRange(date: LocalDate, zone: string): Range { return range(at(date, '00:00', zone), at(addDate(date, 1), '00:00', zone), zone); }
export function labelAt(instant: Instant, zone: string, withDate = false): string {
  const p = localParts(instant, zone);
  return `${withDate ? `${p.date} ` : ''}${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}
export function overlap(a: Range, b: Range): Range | null {
  const start = Math.max(Date.parse(a.startAt), Date.parse(b.startAt));
  const end = Math.min(Date.parse(a.endAt), Date.parse(b.endAt));
  return start < end ? range(new Date(start).toISOString(), new Date(end).toISOString(), a.zone) : null;
}
export function freeRanges(scope: Range, occupied: readonly Range[]): Range[] {
  const ordered = occupied.map(x => overlap(scope, x)).filter((x): x is Range => !!x).sort((a, b) => a.startAt.localeCompare(b.startAt));
  const free: Range[] = []; let cursor = Date.parse(scope.startAt);
  for (const item of ordered) {
    const start = Date.parse(item.startAt), end = Date.parse(item.endAt);
    if (start > cursor) free.push(range(new Date(cursor).toISOString(), item.startAt, scope.zone));
    cursor = Math.max(cursor, end);
  }
  if (cursor < Date.parse(scope.endAt)) free.push(range(new Date(cursor).toISOString(), scope.endAt, scope.zone));
  return free;
}
export function offsetTransition(start: number, end: number, zone: string): number | null {
  const first = offsetMinutes(start, zone);
  for (let probe = start + 3600000; probe <= end + 3600000; probe += 3600000) {
    const atProbe = Math.min(probe, end);
    if (offsetMinutes(atProbe, zone) !== first) {
      let low = Math.max(start, probe - 3600000), high = atProbe;
      while (high - low > 60000) {
        const middle = Math.floor((low + high) / 120000) * 60000;
        if (offsetMinutes(middle, zone) === first) low = middle; else high = middle;
      }
      return high;
    }
    if (atProbe === end) break;
  }
  return null;
}
