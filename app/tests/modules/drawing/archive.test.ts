import test from 'node:test';
import assert from 'node:assert/strict';
import type { DailyCopy, GenerationRule, Id } from '../../../src/workspace/contracts-v3.ts';
import { planArchive, type ArchiveInput } from '../../../src/drawing/model.ts';
import { content } from '../../fixtures/action/independent.ts';

let counter = 0;
const newId = (): Id => `log-${++counter}`;
const AT = '2026-10-01T02:00:00Z'; // Asia/Shanghai today -> 2026-10-01

const rule = (): GenerationRule => ({
  id: 'rule-1', version: 1, name: 'r', actionCardId: 'card-1',
  schedule: { mode: 'daily' }, startDate: '2026-09-01', zone: 'Asia/Shanghai',
  status: 'active', source: { kind: 'manual' },
});
const copy = (over: Partial<DailyCopy> = {}): DailyCopy => ({
  id: 'copy-1', version: 1, ruleId: 'rule-1', ruleVersion: 1,
  actionCard: { id: 'card-1', version: 1 },
  sourceDate: '2026-09-24', generatedAt: AT,
  contentSnapshot: content(), slotSpecSnapshot: [],
  status: 'active', acceptedInstanceIds: [],
  ...over,
});
const base = (over: Partial<ArchiveInput> = {}): ArchiveInput => ({
  copies: [copy()], rules: [rule()], asOf: AT, newId, ...over,
});

test('source date today-6 (D+6) is retained', () => {
  const p = planArchive(base({ copies: [copy({ id: 'c6', sourceDate: '2026-09-25' })] }));
  assert.deepEqual(p.logs, []);
  assert.deepEqual(p.dueCopyIds, []);
});

test('source date today-7 (D+7) is archived, writing the log for the copy', () => {
  const p = planArchive(base());
  assert.equal(p.logs.length, 1);
  assert.deepEqual(p.dueCopyIds, ['copy-1']);
  const log = p.logs[0];
  assert.equal(log.copyId, 'copy-1');
  assert.equal(log.sourceDate, '2026-09-24');
  assert.equal(log.disposition, 'none-accepted');
});

test('due copy with accepted instances releases them and marks accepted', () => {
  const p = planArchive(base({ copies: [copy({ acceptedInstanceIds: ['i-1', 'i-2'] })] }));
  assert.equal(p.logs[0].disposition, 'accepted');
  assert.deepEqual(p.instanceIdsToRelease, ['i-1', 'i-2']);
});

test('one copy per day keeps at most seven active; adding the oldest due day rolls it out', () => {
  const windowDates = ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01'];
  const seven = windowDates.map(d => copy({ id: `c-${d}`, sourceDate: d }));
  assert.equal(planArchive(base({ copies: seven })).logs.length, 0);

  const eight = [copy({ id: 'c-2026-09-24', sourceDate: '2026-09-24' }), ...seven];
  const p = planArchive(base({ copies: eight }));
  assert.deepEqual(p.dueCopyIds, ['c-2026-09-24']);
});

test('already archived copies are ignored', () => {
  const p = planArchive(base({ copies: [copy({ status: 'archived' })] }));
  assert.deepEqual(p.logs, []);
});

test('after B3 deletes the due copy, re-planning logs nothing (idempotent by copyId)', () => {
  assert.equal(planArchive(base()).logs.length, 1);
  const second = planArchive(base({ copies: [] }));
  assert.deepEqual(second.logs, []);
  assert.deepEqual(second.dueCopyIds, []);
});
