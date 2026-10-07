// A6 timeline-journal tests. They drive the in-memory test adapter through the
// JournalSessionPort and assert the guarantees the UI depends on: automatic
// segments interleaved with independent reflections, original vs updated time,
// retract keeping reflections (P16), move updating the same row (P13), sleep
// read from the dial (P18), read-only archives, file-state transitions, and no
// fake success for blank content. Projection/edit internals are B3's tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createJournalTestSession} from '../../support/v06/journal-test-session.ts';
import {DATE, ZONE} from '../../support/v06/b3-fixtures.ts';
import {AT} from '../../support/v06/fixtures.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const valueOf = (r: any): any => {
  assert.equal(r.ok, true, r.ok ? '' : `${r.code}: ${r.message}`);
  return r.value;
};
const read = async (s: ReturnType<typeof createJournalTestSession>, date = DATE) =>
  valueOf(await s.readTimeline({date, zone: ZONE}));

test('A6 initial live timeline interleaves sleep, breakfast and the reflection, with a legacy block', async () => {
  const s = createJournalTestSession();
  const v = await read(s);
  assert.equal(v.access, 'live');
  assert.equal(v.editable, true);
  assert.deepEqual(
    v.projection.rows.map((r: {kind: string; segment?: {title: string}}) =>
      r.kind === 'automatic' ? r.segment!.title : r.kind),
    ['已有夜间安排', '早餐', 'reflection']);
  assert.equal(v.projection.timeline.legacyBlocks.length, 1);
});

test('A6 creating a reflection stamps recorded=created and adds one row', async () => {
  const s = createJournalTestSession();
  s.setNow('2026-10-06T01:00:00Z');
  const r = valueOf(await s.saveNote({
    id: null, date: DATE, zone: ZONE, text: '新的感想', expectedVersion: null,
  }));
  assert.equal(r.operation, 'create');
  assert.equal(r.note.recordedAt, r.note.createdAt);
  const v = await read(s);
  assert.equal(v.projection.timeline.notes.length, 2);
});

test('A6 editing a reflection keeps its original recorded time and bumps updated/version', async () => {
  const s = createJournalTestSession();
  s.setNow('2026-10-06T01:30:00Z');
  const r = valueOf(await s.saveNote({
    id: 'note-1', date: DATE, zone: ZONE, text: '修改后的话', expectedVersion: 1,
  }));
  assert.equal(r.operation, 'update');
  assert.equal(r.note.recordedAt, AT);
  assert.equal(r.note.createdAt, AT);
  assert.equal(r.note.updatedAt, '2026-10-06T01:30:00Z');
  assert.equal(r.note.version, 2);
});

test('A6 retracting breakfast removes only its automatic segment, reflections survive (P16)', async () => {
  const s = createJournalTestSession();
  s.retractBreakfast();
  const v = await read(s);
  assert.equal(v.projection.timeline.automatic.length, 1);
  assert.equal(v.projection.timeline.automatic[0].title, '已有夜间安排');
  assert.equal(v.projection.timeline.notes.length, 1);
  assert.equal(v.projection.timeline.notes[0].text, '今天早餐很好吃。');
});

test('A6 moving breakfast to 10:00 updates the same row (P13)', async () => {
  const s = createJournalTestSession();
  s.moveBreakfastTo10();
  const v = await read(s);
  const breakfast = v.projection.timeline.automatic.find((a: {title: string}) => a.title === '早餐');
  assert.equal(breakfast.clippedRange.localStart, '2026-10-06T10:00');
});

test('A6 sleep is read from the dial, clipped to the viewed day (P18)', async () => {
  const s = createJournalTestSession();
  const v = await read(s);
  const sleep = v.projection.timeline.automatic.find((a: {sourceKind: string}) => a.sourceKind === 'fixed');
  assert.equal(sleep.title, '已有夜间安排');
  assert.equal(sleep.clippedRange.localStart, '2026-10-06T00:00');
  assert.equal(sleep.clippedRange.localEnd, '2026-10-06T06:00');
});

test('A6 a monthly archive is read-only and refuses a save with ARCHIVE_READ_ONLY', async () => {
  const s = createJournalTestSession();
  const v = await read(s, '2026-09-30');
  assert.equal(v.access, 'archive');
  assert.equal(v.editable, false);
  const r = await s.saveNote({
    id: null, date: '2026-09-30', zone: ZONE, text: 'x', expectedVersion: null,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'ARCHIVE_READ_ONLY');
});

test('A6 file state: error retries; permission refuses writes then reauthorizes', async () => {
  const s = createJournalTestSession();
  let f = valueOf(await s.readFileState({date: DATE, zone: ZONE}));
  assert.equal(f.status, 'synced');

  s.setFileStatus('error');
  f = valueOf(await s.retryFile({date: DATE, zone: ZONE}));
  assert.equal(f.status, 'synced');

  s.setFileStatus('permission-required');
  const denied = await s.writeFileNow({date: DATE, zone: ZONE});
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'PERMISSION_REQUIRED');

  f = valueOf(await s.reauthorizeFile({date: DATE, zone: ZONE}));
  assert.equal(f.status, 'pending');
  f = valueOf(await s.writeFileNow({date: DATE, zone: ZONE}));
  assert.equal(f.status, 'synced');
});

test('A6 a changed reflection marks the file pending, then writing syncs it', async () => {
  const s = createJournalTestSession();
  s.setNow('2026-10-06T01:00:00Z');
  valueOf(await s.saveNote({id: null, date: DATE, zone: ZONE, text: '新感想', expectedVersion: null}));
  let f = valueOf(await s.readFileState({date: DATE, zone: ZONE}));
  assert.equal(f.status, 'pending');
  f = valueOf(await s.writeFileNow({date: DATE, zone: ZONE}));
  assert.equal(f.status, 'synced');
});

test('A6 blank content is not filed and shows no fake success', async () => {
  const s = createJournalTestSession();
  const r = await s.saveNote({id: null, date: DATE, zone: ZONE, text: '   ', expectedVersion: null});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_INPUT');
  const v = await read(s);
  assert.equal(v.projection.timeline.notes.length, 1);
});
