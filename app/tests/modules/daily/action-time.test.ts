import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionTimeError, actualRange, assertRecordedRange, dayRange, elapsedMinutes, freeRanges, intersectRanges, plannedRange, resolveLocal, splitRangeForDay, unionRanges } from '../../../src/daily/schedule/time.ts';
import { range } from '../../fixtures/action/seed.ts';

function fails(code: string, fn: () => unknown) { assert.throws(fn, e => e instanceof ActionTimeError && e.code === code); }
const ny = 'America/New_York';
test('C13: missing local minute is rejected; repeated minute returns both explicit offsets', () => {
  fails('NONEXISTENT_LOCAL_TIME', () => resolveLocal({ date: '2026-03-08', time: '02:30', zone: ny }));
  try { resolveLocal({ date: '2026-11-01', time: '01:30', zone: ny }); assert.fail('expected ambiguity'); }
  catch (error) {
    assert.ok(error instanceof ActionTimeError); assert.equal(error.code, 'AMBIGUOUS_LOCAL_TIME');
    assert.deepEqual(error.choices.map(c => [c.input.offset, c.instant]), [['-04:00', '2026-11-01T05:30:00Z'], ['-05:00', '2026-11-01T06:30:00Z']]);
  }
  assert.equal(resolveLocal({ date: '2026-11-01', time: '01:30', zone: ny, offset: '-05:00' }).instant, '2026-11-01T06:30:00Z');
  fails('INVALID_INPUT', () => resolveLocal({ date: '2026-11-01', time: '01:30', zone: ny, offset: '+08:00' }));
});
test('local input rejects calendar overflow, seconds, invalid zones and bogus offsets', () => {
  for (const input of [
    { date: '2026-02-30', time: '09:00', zone: 'UTC' }, { date: '2026-09-26', time: '24:00', zone: 'UTC' },
    { date: '2026-09-26', time: '09:00:30', zone: 'UTC' }, { date: '2026-09-26', time: '09:00', zone: 'Invalid/Zone' },
    { date: '2026-09-26', time: '09:00', zone: '+08:00' }, { date: '2026-09-26', time: '09:00', zone: 'UTC', offset: '-04:00' }
  ]) fails('INVALID_INPUT', () => resolveLocal(input));
});
test('C24: elapsed addition keeps full length through fall-back and yields two distinct 01:30s', () => {
  const start = { date: '2026-10-31', time: '23:00', zone: ny };
  const a = plannedRange(start, 150), b = plannedRange(start, 210);
  assert.equal(a.localEnd, '2026-11-01T01:30'); assert.equal(b.localEnd, a.localEnd);
  assert.equal(a.endOffset, '-04:00'); assert.equal(b.endOffset, '-05:00');
  assert.equal(elapsedMinutes(a), 150); assert.equal(elapsedMinutes(b), 210);
  assert.equal(plannedRange({ date: '2026-03-08', time: '01:30', zone: ny }, 60).localEnd, '2026-03-08T03:30');
});
test('actual endpoints disambiguate independently and compare real instants, not clock labels', () => {
  const start = { date: '2026-11-01', time: '01:45', zone: ny, offset: '-04:00' };
  const end = { date: '2026-11-01', time: '01:15', zone: ny };
  fails('AMBIGUOUS_LOCAL_TIME', () => actualRange(start, end));
  assert.equal(elapsedMinutes(actualRange(start, { ...end, offset: '-05:00' })), 30);
  fails('INVALID_INPUT', () => actualRange({ ...start, offset: '-05:00' }, { ...end, offset: '-04:00' }));
});
test('C11: plans require full grid duration; actual records preserve minute precision', () => {
  const start = { date: '2026-09-26', time: '09:02', zone: 'Asia/Shanghai' };
  fails('INVALID_GRID', () => plannedRange(start, 15));
  fails('INVALID_GRID', () => plannedRange({ ...start, time: '09:00' }, 7));
  fails('DURATION_REQUIRED', () => plannedRange({ ...start, time: '09:00' }, null));
  assert.equal(elapsedMinutes(actualRange(start, { ...start, time: '09:19' })), 17);
});
test('C35/C44: day bounds handle 23/25-hour days, missing midnight and a missing date', () => {
  assert.equal(elapsedMinutes(dayRange('2026-03-08', ny)), 23 * 60);
  assert.equal(elapsedMinutes(dayRange('2026-11-01', ny)), 25 * 60);
  const midnightJump = dayRange('2018-11-04', 'America/Sao_Paulo');
  assert.deepEqual(midnightJump, { startAt: '2018-11-04T03:00:00Z', endAt: '2018-11-05T02:00:00Z', zone: 'America/Sao_Paulo' });
  fails('NONEXISTENT_LOCAL_TIME', () => dayRange('2011-12-30', 'Pacific/Apia'));
  assert.equal(elapsedMinutes(dayRange('2011-12-29', 'Pacific/Apia')), 1440);
});
test('C04: half-open touching ranges do not conflict; overlap, union and free ranges share instants', () => {
  assert.equal(intersectRanges(range('09:00', 15), range('09:15', 15)), null);
  assert.equal(elapsedMinutes(intersectRanges(range('09:00', 15), range('09:10', 15))!), 5);
  const query = range('09:00', 60), blocks = [range('09:10', 20), range('09:20', 20), range('09:40', 5)];
  assert.equal(unionRanges(blocks, 'Asia/Shanghai').length, 1);
  assert.deepEqual(freeRanges(query, blocks).map(elapsedMinutes), [10, 15]);
  assert.equal(elapsedMinutes(unionRanges(blocks, 'UTC')[0]), 35);
});
test('C10/C44: cross-day, noon, offset and mixed-zone display slices conserve duration', () => {
  const source = range('23:50', 25);
  const first = splitRangeForDay(source, '2026-09-26', 'Asia/Shanghai');
  const second = splitRangeForDay(source, '2026-09-27', 'Asia/Shanghai');
  assert.equal(first.length, 1); assert.equal(first[0].continuesAfter, true); assert.equal(second[0].continuesBefore, true);
  assert.equal([...first, ...second].reduce((n, s) => n + elapsedMinutes(s.range), 0), 25);
  const noon = splitRangeForDay(range('11:50', 20), '2026-09-26', 'Asia/Shanghai');
  assert.deepEqual(noon.map(s => s.half), [0, 1]); assert.ok(noon.every(s => !s.continuesBefore && !s.continuesAfter));
  const repeated = plannedRange({ date: '2026-11-01', time: '00:30', zone: ny }, 180);
  const pieces = splitRangeForDay(repeated, '2026-11-01', ny);
  assert.deepEqual(pieces.map(s => s.offset), ['-04:00', '-05:00']);
  assert.equal(pieces.reduce((n, s) => n + elapsedMinutes(s.range), 0), 180);
  const original = structuredClone(source);
  const utc = splitRangeForDay(source, '2026-09-26', 'UTC');
  assert.equal(utc.reduce((n, s) => n + elapsedMinutes(s.range), 0), 25); assert.deepEqual(source, original);
});
test('recorded local snapshots are checked without rewriting stored values', () => {
  const value = range(); const copy = structuredClone(value); assertRecordedRange(value); assert.deepEqual(value, copy);
  fails('INVALID_INPUT', () => assertRecordedRange({ ...value, endOffset: '-05:00' }));
});
test('union/complement conservation across all small synthetic overlap placements', () => {
  const query = range('09:00', 60);
  for (let a = 0; a <= 45; a += 5) for (let b = 0; b <= 45; b += 5) {
    const time = (minute: number) => `09:${String(minute).padStart(2, '0')}`;
    const occupied = [range(time(a), 15), range(time(b), 15)];
    const used = unionRanges(occupied, query.zone).reduce((n, r) => n + elapsedMinutes(r), 0);
    const free = freeRanges(query, occupied).reduce((n, r) => n + elapsedMinutes(r), 0);
    assert.equal(used + free, 60);
  }
});
