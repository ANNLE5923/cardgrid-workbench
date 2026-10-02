import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrototype } from './host.ts';
import { at, dayRange, offsetLabel, resolveLocal } from './time.ts';

function day(h, date = h.scenario.date) {
  const result = h.host.readDay({ date, zone: h.scenario.zone });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  return result.value;
}
function preview(h, instanceId, focus, date = h.scenario.date) {
  const result = h.host.previewPlacement({ token: day(h, date).token,
    subject: { kind: 'hand', instanceId, version: 1 }, date, zone: h.scenario.zone,
    focusMinuteOfDay: focus });
  assert.equal(result.ok, true, result.ok ? '' : result.message);
  return result.value;
}

test('S01 单一绝对时间落点，查看和预览不写工作区', () => {
  const h = createPrototype('S01'), before = day(h);
  const p15 = preview(h, 'i-15', 540), p25 = preview(h, 'i-25', 540);
  assert.deepEqual(p15.candidates.map(x => [x.half, x.state, x.units]), [[0, 'valid', 3]]);
  assert.deepEqual(p25.candidates.map(x => [x.half, x.state, x.units]), [[0, 'valid', 5]]);
  assert.deepEqual(preview(h, 'i-15', 1260).candidates.map(x => x.half), [1]);
  assert.equal(day(h).token.revision, before.token.revision);
  assert.equal(day(h).hand.length, 2);
});

test('S02 拥挤日完整显示冲突；明确确认后允许重叠，固定移动仍需解锁', async () => {
  const h = createPrototype('S02');
  const p = preview(h, 'i-45', 540);
  assert.deepEqual(p.candidates.map(x => x.state), ['conflict']);
  assert.ok(p.candidates.every(x => x.units === 9 && x.state === 'conflict' && x.blockers.length));
  const c = p.candidates[0];
  const command = { commandId: 'overlap-plan', expected: p.token, type: 'CommitPlacement', payload: { previewId: p.previewId, candidateId: c.id, acknowledgedOverlap: null } };
  const denied = await h.host.submit(command);
  assert.equal(denied.ok, false); assert.equal(denied.code, 'OVERLAP_CONFIRMATION_REQUIRED');
  assert.equal(day(h).hand.some(x => x.instanceId === 'i-45'), true);
  const accepted = await h.host.submit({ ...command, payload: { ...command.payload, acknowledgedOverlap: c.acknowledgementId } });
  assert.equal(accepted.ok, true); assert.equal(day(h).hand.some(x => x.instanceId === 'i-45'), false);
  assert.equal(day(h).segments.some(x => x.kind === 'plan' && x.sourceId === accepted.value.resultRefs[0]), true);
  const b = h.scenario.fixed.find(x => x.id === 'b-1');
  assert.ok(b);
  const unlocked = h.host.unlockFixed({ token: day(h).token, commitmentId: b.id, version: b.version });
  assert.equal(unlocked.ok, true);
  const q = h.host.previewPlacement({ token: day(h).token,
    subject: { kind: 'fixed', commitmentId: b.id, version: b.version, unlockId: unlocked.value },
    date: h.scenario.date, zone: h.scenario.zone, focusMinuteOfDay: 540 });
  assert.equal(q.ok, true);
  assert.ok(q.value.candidates.some(x => x.state === 'conflict'));
});

test('S03 跨午夜同一源对象分片，次日重叠列入冲突预览', () => {
  const h = createPrototype('S03');
  const first = day(h), next = day(h, '2026-09-25');
  assert.equal(first.segments.filter(x => x.sourceId === 'p-night' && x.kind === 'plan').length, 1);
  assert.equal(next.segments.filter(x => x.sourceId === 'p-night' && x.kind === 'plan').length, 1);
  assert.equal(next.segments.find(x => x.sourceId === 'p-night').label.includes('开始于 2026-09-24'), true);
  assert.equal(first.segments.find(x => x.sourceId === 'p-night').continuesAfter, true);
  assert.equal(first.segments.find(x => x.sourceId === 'p-night').label.includes('续次日'), true);
  assert.equal(next.segments.find(x => x.sourceId === 'p-night').continuesBefore, true);
  assert.equal(first.segments.find(x => x.sourceId === 'p-noon').continuesAfter, false);
  assert.deepEqual(first.plans.find(x => x.planId === 'p-night'), { planId: 'p-night', version: 1, instanceId: 'i-night', instanceVersion: 1, range: h.scenario.plans.find(x => x.id === 'p-night').range });
  const evening = preview(h, 'i-cross', 1430).candidates.find(x => x.half === 1);
  assert.equal(evening.state, 'conflict');
  assert.ok(evening.blockers.some(x => x.id === 'b-next'));
});

test('S04 自动红色仅按实际占时，并随模拟时钟跨日变化', () => {
  const h = createPrototype('S04');
  let current = day(h);
  const ghost = current.segments.find(x => x.kind === 'plan-reference' && x.sourceId === 'f-actual');
  assert.ok(ghost);
  assert.ok(current.segments.some(x => x.kind === 'empty'));
  assert.ok(current.freeRanges.some(x => x.startAt <= at('2026-09-24', '09:00') && x.endAt >= at('2026-09-24', '09:20')));
  const totalFree = current.freeRanges.reduce((n, x) => n + (Date.parse(x.endAt) - Date.parse(x.startAt)) / 60000, 0);
  assert.equal(totalFree, 1440 - 50); // 两个事实 09:20–09:50 + 09:40–10:10 的并集
  const rev = current.token.revision;
  h.setNow(at('2026-09-24', '23:59'));
  assert.equal(day(h).segments.some(x => x.kind === 'empty'), false);
  h.setNow(at('2026-09-25', '00:00'));
  current = day(h);
  assert.ok(current.segments.some(x => x.kind === 'empty'));
  assert.equal(current.token.revision, rev);
});

test('D016 提前确认未来结束，D015 重叠二次确认，原事实锁定', async () => {
  const h = createPrototype('S04');
  h.setNow(at('2026-09-24', '09:30'));
  const token = day(h).token;
  const draft = { mode: 'unplanned', instanceId: 'i-future', instanceVersion: 1,
    start: { date: '2026-09-24', time: '09:20', zone: 'Asia/Shanghai' },
    end: { date: '2026-09-24', time: '09:50', zone: 'Asia/Shanghai' } };
  const p = h.host.previewActual({ token, draft });
  assert.equal(p.ok, true);
  assert.equal(p.value.conflicts.length, 2);
  const command = { commandId: 'complete-once', expected: token, type: 'ConfirmActual',
    payload: { previewId: p.value.previewId, acknowledgedOverlap: null } };
  const missingAck = await h.host.submit(command);
  assert.equal(missingAck.ok, false); assert.equal(missingAck.code, 'OVERLAP_CONFIRMATION_REQUIRED');
  assert.equal(day(h).facts.length, 2);
  const saved = await h.host.submit({ ...command, payload: { ...command.payload, acknowledgedOverlap: p.value.acknowledgementId } });
  assert.equal(saved.ok, true);
  const created = day(h).facts.find(x => x.instanceId === 'i-future');
  assert.equal(created.confirmedAt, at('2026-09-24', '09:30'));
  assert.ok(Date.parse(created.actualRange.endAt) > Date.parse(created.confirmedAt));
  h.setNow(at('2026-09-24', '09:50'));
  assert.equal(day(h).facts.length, 3);
  assert.equal(day(h).token.revision, 1);
});

test('S05 失败不移动手牌；相同命令重试和旧修订冲突', async () => {
  const h = createPrototype('S05');
  const p = preview(h, 'i-retry', 540), c = p.candidates.find(x => x.state === 'valid');
  assert.ok(c);
  const command = { commandId: 'placement-once', expected: p.token, type: 'CommitPlacement', payload: { previewId: p.previewId, candidateId: c.id, acknowledgedOverlap: null } };
  h.failNextSubmit('STORAGE_FAILED');
  const failed = await h.host.submit(command);
  assert.equal(failed.ok, false); assert.equal(failed.code, 'STORAGE_FAILED');
  assert.equal(day(h).hand.length, 1); assert.equal(day(h).token.revision, 0);
  const saved = await h.host.submit(command);
  assert.equal(saved.ok, true); assert.equal(day(h).hand.length, 0);
  const replay = await h.host.submit(command);
  assert.equal(replay.ok, true); assert.equal(replay.value.replayed, true);
  assert.equal(day(h).segments.filter(x => x.kind === 'plan').length, 1);
  const old = day(h).token;
  h.simulateExternalWrite();
  const rejected = await h.host.submit({ commandId: 'stale', expected: old, type: 'ReorderHand', payload: { instanceIds: [] } });
  assert.equal(rejected.ok, false); assert.equal(rejected.code, 'REVISION_CONFLICT');
});

test('S06 纽约缺失、重复刻度与 25 小时当地日', () => {
  const zone = 'America/New_York';
  assert.deepEqual(resolveLocal({ date: '2026-03-08', time: '02:30', zone }), []);
  const repeated = resolveLocal({ date: '2026-11-01', time: '01:30', zone });
  assert.equal(repeated.length, 2);
  assert.deepEqual(repeated.map(x => offsetLabel(x, zone)), ['-04:00', '-05:00']);
  const bounds = dayRange('2026-11-01', zone);
  assert.equal((Date.parse(bounds.endAt) - Date.parse(bounds.startAt)) / 3600000, 25);
  const h = createPrototype('S06');
  const p = preview(h, 'i-150', 90, '2026-11-01');
  assert.equal(p.candidates.filter(x => x.half === 0).length, 2);
  assert.ok(p.candidates.every(x => x.segments.every(seg => seg.endMinuteOfHalf > seg.startMinuteOfHalf)));
  const start = at('2026-10-31', '23:00', zone);
  assert.deepEqual([150, 210].map(n => new Date(Date.parse(start) + n * 60000).toISOString()), repeated);
});
