import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ActionCard, GenerationRule, Id,
} from '../../../src/workspace/contracts-v3.ts';
import {
  runDailyGeneration, runManualGeneration, type GenerationInput,
} from '../../../src/drawing/model.ts';
import { content } from '../../fixtures/action/independent.ts';
import { weekday } from '../../../src/daily/time.ts';

let counter = 0;
const newId = (): Id => `new-${++counter}`;
const AT = '2026-10-01T02:00:00Z'; // Asia/Shanghai -> 2026-10-01

const actionCard = (over: Partial<ActionCard> = {}): ActionCard => ({
  id: 'card-1', version: 1, kind: 'action',
  content: content(), slots: [],
  status: 'active', parentId: null, source: { kind: 'manual' },
  ...over,
});
const dailyRule = (over: Partial<GenerationRule> = {}): GenerationRule => ({
  id: 'rule-1', version: 1, name: '每日阅读', actionCardId: 'card-1',
  schedule: { mode: 'daily' }, startDate: '2026-09-01', zone: 'Asia/Shanghai',
  status: 'active', source: { kind: 'manual' },
  ...over,
});
const baseInput = (over: Partial<GenerationInput> = {}): GenerationInput => ({
  rules: [dailyRule()], actionCards: [actionCard()], ledger: [], at: AT, newId, ...over,
});

test('active daily rule generates exactly one current-day copy with snapshots', () => {
  const result = runDailyGeneration(baseInput());
  assert.equal(result.copies.length, 1);
  assert.equal(result.ledgerEntries.length, 1);
  const copy = result.copies[0];
  assert.equal(copy.sourceDate, '2026-10-01');
  assert.equal(copy.status, 'active');
  assert.equal(copy.ruleId, 'rule-1');
  assert.deepEqual(copy.actionCard, { id: 'card-1', version: 1 });
  assert.deepEqual(copy.contentSnapshot, content());
  assert.deepEqual(copy.slotSpecSnapshot, []);
  assert.deepEqual(copy.acceptedInstanceIds, []);
  assert.equal(result.ledgerEntries[0].copyId, copy.id);
});

test('repeated startup is idempotent via the ledger', () => {
  const first = runDailyGeneration(baseInput());
  const again = runDailyGeneration(baseInput({ ledger: first.ledgerEntries }));
  assert.equal(again.copies.length, 0);
  assert.equal(again.skipped[0]?.reason, 'already-generated');
});

test('advancing several days generates only the new current day, no back-fill', () => {
  const day0 = runDailyGeneration(baseInput());
  const jumped = runDailyGeneration(baseInput({ ledger: day0.ledgerEntries, at: '2026-10-04T02:00:00Z' }));
  assert.deepEqual(jumped.copies.map(c => c.sourceDate), ['2026-10-04']);
});

test('paused rules and weekday schedule misses produce no copies; a matching weekday does', () => {
  const paused = runDailyGeneration(baseInput({ rules: [dailyRule({ status: 'paused' })] }));
  assert.equal(paused.copies.length, 0);
  assert.equal(paused.skipped[0].reason, 'rule-inactive');

  const otherWeekdays = [0, 1, 2, 3, 4, 5, 6].filter(d => d !== weekday('2026-10-01'));
  const miss = runDailyGeneration(baseInput({
    rules: [dailyRule({ schedule: { mode: 'weekdays', weekdays: otherWeekdays } })],
  }));
  assert.equal(miss.copies.length, 0);
  assert.equal(miss.skipped[0].reason, 'schedule-miss');

  const hit = runDailyGeneration(baseInput({
    rules: [dailyRule({ schedule: { mode: 'weekdays', weekdays: [weekday('2026-10-01')] } })],
  }));
  assert.equal(hit.copies.length, 1);
});

test('rule before its start date does not generate', () => {
  const r = runDailyGeneration(baseInput({ rules: [dailyRule({ startDate: '2026-11-01' })] }));
  assert.equal(r.copies.length, 0);
  assert.equal(r.skipped[0].reason, 'schedule-miss');
});

test('missing referenced action card is reported, not generated', () => {
  const r = runDailyGeneration(baseInput({ actionCards: [] }));
  assert.equal(r.copies.length, 0);
  assert.equal(r.skipped[0].reason, 'action-card-missing');
});

test('manual back-fill inside the retention window generates one copy', () => {
  const r = runManualGeneration(baseInput(), { ruleId: 'rule-1', date: '2026-09-28' });
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.value.copies.map(c => c.sourceDate), ['2026-09-28']);
});

test('manual back-fill older than the window is rejected without generating', () => {
  const r = runManualGeneration(baseInput(), { ruleId: 'rule-1', date: '2026-09-20' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'DATE_OUTSIDE_RETENTION');
});

test('manual future date is rejected', () => {
  const r = runManualGeneration(baseInput(), { ruleId: 'rule-1', date: '2026-10-05' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'FUTURE_DATE');
});

test('a ledger entry blocks regeneration even after the copy is gone', () => {
  const ledger = [{ ruleId: 'rule-1', sourceDate: '2026-09-28', copyId: 'archived-copy', at: AT }];
  const r = runManualGeneration(baseInput({ ledger }), { ruleId: 'rule-1', date: '2026-09-28' });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.value.copies.length, 0);
    assert.equal(r.value.skipped[0].reason, 'already-generated');
  }
});

test('manual generation rejects unknown or inactive rules', () => {
  assert.equal(runManualGeneration(baseInput(), { ruleId: 'nope', date: '2026-09-28' }).ok, false);
  const paused = runManualGeneration(
    baseInput({ rules: [dailyRule({ status: 'paused' })] }),
    { ruleId: 'rule-1', date: '2026-09-28' },
  );
  assert.equal(paused.ok, false);
});

test('the same instant resolves to different source dates by rule zone', () => {
  // 2026-10-01T16:30Z -> UTC 10-01 16:30 ; Shanghai 10-02 00:30
  const r = runDailyGeneration({
    rules: [dailyRule({ id: 'r-utc', zone: 'UTC' }), dailyRule({ id: 'r-sh', zone: 'Asia/Shanghai' })],
    actionCards: [actionCard()], ledger: [], at: '2026-10-01T16:30:00Z', newId,
  });
  const byRule = Object.fromEntries(r.copies.map(c => [c.ruleId, c.sourceDate]));
  assert.equal(byRule['r-utc'], '2026-10-01');
  assert.equal(byRule['r-sh'], '2026-10-02');
});
