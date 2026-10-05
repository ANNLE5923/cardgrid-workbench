import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyActionData, exportWorkspace, fingerprint, parseRestore, validateActionData, validateSourceFingerprints } from '../../../src/workspace/format.ts';
import { prepareMigration, legacyProjection, legacyMakeup } from '../../../src/workspace/migration.ts';
import { calendarOperation, inspectSnapshot } from '../../../src/workspace/commands.ts';
import { applyAction } from '../../../src/daily/model/domain.ts';
import { projectDay } from '../../../src/daily/projection.ts';
import { elapsedMinutes } from '../../../src/daily/schedule/time.ts';
import { content, context, range } from '../../fixtures/action/seed.ts';
import type { DataV2, Json } from '../../../src/workspace/contracts.ts';
import { emptyPlanner } from '../../../src/workspace/legacy/planner.ts';

const at = '2026-09-27T01:30:00Z';
function oldData() {
  return { config: { preferences: { theme: 'paper' as const, density: 'comfortable' as const, startHour: 8, endHour: 23, defaultMinutes: 15 }, categories: [], cards: [], schedules: [] }, legacyArchives: [], planner: emptyPlanner() };
}
function oldTask(id: string, status = 'planned') { return { id, title: id, date: '2026-09-27', status, criteria: '验收', minimum: true, projects: [], goals: [], source: 'manual', occurrence: '', makeupOf: '' } as ReturnType<typeof oldData>['planner']['tasks'][number]; }
function envelope(data: DataV2) { return { schemaVersion: 4, epoch: 'test', revision: 1, mode: 'current', dataFormat: 'action-v2', lifecycleReceipt: null, data }; }
test('strict schemas reject nested unknown fields, non-grid content and changed source digests without normalization', async () => {
  const data = emptyActionData(); validateActionData(data);
  assert.throws(() => validateActionData({ ...data, settings: { ...data.settings, invented: true } }));
  const withDefinition = applyAction(data, { type: 'SaveDefinition', id: 'd', expectedVersion: null, content: content(), enabled: true, parentDefinitionId: null }, context('def')).data;
  assert.throws(() => validateActionData({ ...withDefinition, planner: { ...withDefinition.planner, definitions: [{ ...withDefinition.planner.definitions[0], content: content(7) }] } }));
  const raw = oldData(), migrated = await prepareMigration(data, { format: 'cardgrid-v1-p1a', raw: raw as unknown as Json }, { zone: 'Asia/Shanghai' }, at, 'migration');
  assert.deepEqual(migrated.report.issues, []); validateActionData(migrated.data); await validateSourceFingerprints(migrated.data);
  const damaged = structuredClone(migrated.data) as any; damaged.legacySources[0].raw.config.preferences.theme = 'night';
  await assert.rejects(() => validateSourceFingerprints(damaged));
});
test('exact restore/export preserves missing old optional fields and new history/order over repeated reads', async () => {
  const raw = { config: oldData().config, legacyArchives: [] }, pack = { format: 'cardgrid', version: 1, kind: 'backup', data: raw };
  const target = parseRestore(JSON.stringify(pack)); assert.equal(target.mode, 'legacy-readonly');
  const local = { schemaVersion: 4, epoch: 'restored', revision: 1, lifecycleReceipt: null, ...target };
  for (let i = 0; i < 3; i++) { await inspectSnapshot(local); assert.deepEqual(exportWorkspace(local), pack); }
  assert.equal(Object.hasOwn(target.data, 'planner'), false);
  const original = emptyActionData(), before = JSON.stringify(original); const restored = parseRestore(JSON.stringify(exportWorkspace(envelope(original))));
  assert.deepEqual(restored.data, original); assert.equal(JSON.stringify(original), before);
});
test('migration converts unique legal plans, preserves old done as source, readonly occupancy and repeated source mapping', async () => {
  const raw = oldData(); raw.planner.tasks.push(oldTask('open'), oldTask('done', 'done'));
  raw.planner.days.push({ date: '2026-09-27', name: '旧日', template: '', minimum: true, top3: ['open', 'done'], overrides: [], blocks: [
    { id: 'b', title: 'open', task: 'open', kind: 'flexible', start: 540, end: 555, cancelled: false },
    { id: 'fixed-seven', title: '七分钟', task: '', kind: 'fixed', start: 600, end: 607, cancelled: false }
  ] });
  const original = structuredClone(raw), source = { format: 'cardgrid-v1-p1a' as const, raw: raw as unknown as Json };
  const migrated = await prepareMigration(emptyActionData(), source, { zone: 'Asia/Shanghai' }, at, 'migration');
  assert.deepEqual(migrated.report.issues.filter(i => i.blocking), []); assert.deepEqual(raw, original);
  validateActionData(migrated.data); assert.equal(migrated.data.planner.instances.length, 1); assert.equal(migrated.data.planner.plans.length, 1); assert.equal(migrated.data.planner.facts.length, 0);
  assert.equal(migrated.data.planner.days[0].top3[1].kind, 'legacy'); assert.equal(migrated.data.planner.days[0].minimum, true);
  const compatible = legacyProjection(migrated.data); assert.equal(compatible.occupancy.unknown, false); assert.equal(compatible.occupancy.items.length, 1); assert.equal(elapsedMinutes(compatible.occupancy.items[0].range), 7);
  const repeated = await prepareMigration(migrated.data, source, { zone: 'Asia/Shanghai' }, at, 'again'); assert.deepEqual(repeated.data, migrated.data); assert.deepEqual(repeated.report.bindings, migrated.report.bindings);
});
test('missing zone, multiple blocks, bad references and non-grid schedules cannot silently activate', async () => {
  const raw = oldData(); raw.planner.tasks.push(oldTask('open'));
  raw.planner.days.push({ date: '2026-09-27', name: '', template: '', minimum: false, top3: [], overrides: [], blocks: [
    { id: 'a', title: 'a', task: 'open', kind: 'flexible', start: 540, end: 547, cancelled: false },
    { id: 'b', title: 'b', task: 'open', kind: 'flexible', start: 600, end: 615, cancelled: false }
  ] });
  const source = { format: 'cardgrid-v1-p1a' as const, raw: raw as unknown as Json };
  const blocked = await prepareMigration(emptyActionData(), source, { zone: null }, at, 'missing'); assert.ok(blocked.report.issues.some(i => i.blocking)); assert.equal(blocked.data.planner.instances.length, 0);
  const chosen = await prepareMigration(emptyActionData(), source, { zone: 'Asia/Shanghai', readonlyPaths: ['/planner/tasks/@open'] }, at, 'readonly');
  assert.deepEqual(chosen.report.issues.filter(i => i.blocking), []); assert.equal(chosen.data.planner.instances.length, 0); assert.equal(legacyProjection(chosen.data).occupancy.items.length, 2);
  raw.planner.days[0].blocks[0].task = 'missing'; await assert.rejects(() => prepareMigration(emptyActionData(), source, { zone: 'Asia/Shanghai' }, at, 'bad'));
});
test('PrepareDay is explicit and idempotent; time passage does not roll routines over or rewrite history', async () => {
  let data = applyAction(emptyActionData(), { type: 'SaveDefinition', id: 'd', expectedVersion: null, content: content(), enabled: true, parentDefinitionId: null }, context('def')).data;
  data = applyAction(data, { type: 'SaveRule', expectedVersion: null, rule: { id: 'r', version: 1, name: '每日', definitionId: 'd', weekdays: [0, 1, 2, 3, 4, 5, 6], startDate: '2026-09-26', zone: 'Asia/Shanghai', status: 'active', source: { kind: 'manual' } } }, context('rule')).data;
  const before = structuredClone(data); const snapshot = await inspectSnapshot(envelope(data));
  projectDay(snapshot, { date: '2026-09-27', zone: 'Asia/Shanghai' }, at); projectDay(snapshot, { date: '2026-09-28', zone: 'Asia/Shanghai' }, at); assert.deepEqual(data, before);
  const operation = calendarOperation(data, { date: '2026-09-27', zone: 'Asia/Shanghai', templateId: null }, false, at, 'prepare');
  const prepared = applyAction(data, operation, { ...context('prepare'), at }).data; validateActionData(prepared);
  const again = applyAction(prepared, calendarOperation(prepared, { date: '2026-09-27', zone: 'Asia/Shanghai', templateId: null }, false, at, 'again'), { ...context('again'), at });
  assert.deepEqual(again.data, prepared); assert.equal(prepared.planner.occurrences.length, 1); assert.equal(prepared.planner.instances.length, 1);
});
test('day projection retains cross-midnight source IDs, actual-only free space and automatic day-end recomputation', async () => {
  let data = applyAction(emptyActionData(), { type: 'CreateManualInstance', instanceId: 'i', content: content(25), targetDate: null }, context('instance')).data;
  data = applyAction(data, { type: 'PlaceInstance', instance: { id: 'i', version: 1 }, planId: 'p', range: range('23:50', 25) }, context('plan')).data;
  const first = projectDay(await inspectSnapshot(envelope(data)), { date: '2026-09-26', zone: 'Asia/Shanghai' }, at);
  const second = projectDay(await inspectSnapshot(envelope(data)), { date: '2026-09-27', zone: 'Asia/Shanghai' }, at);
  assert.equal(first.segments.find(s => s.sourceId === 'p')!.continuesAfter, true); assert.equal(second.segments.find(s => s.sourceId === 'p')!.continuesBefore, true);
  assert.equal(first.plans[0].instanceVersion, 1); assert.equal(elapsedMinutes(first.segments.find(s => s.sourceId === 'p')!.clippedRange) + elapsedMinutes(second.segments.find(s => s.sourceId === 'p')!.clippedRange), 25);
  assert.ok(first.segments.some(s => s.kind === 'empty')); assert.ok(!second.segments.some(s => s.kind === 'empty'));
  data = applyAction(data, { type: 'ConfirmActual', instance: { id: 'i', version: 1 }, expectedPlan: { id: 'p', version: 1 }, factId: 'f', range: range('23:55', 5) }, context('fact')).data;
  const ended = projectDay(await inspectSnapshot(envelope(data)), { date: '2026-09-27', zone: 'Asia/Shanghai' }, at);
  assert.equal(ended.freeRanges.reduce((sum, r) => sum + elapsedMinutes(r), 0), 1440); assert.ok(ended.segments.some(s => s.kind === 'plan-reference')); assert.equal(data.planner.facts.length, 1);
});

test('old rules do not regenerate old occurrences and one legacy makeup preserves the original outcome', async () => {
  const raw = oldData(); const task = { ...oldTask('routine'), occurrence: 'old-occurrence', date: '2026-09-26' }; raw.planner.tasks.push(task);
  raw.planner.rules.push({ id: 'rule', name: '旧例行', title: '例行', weekdays: [0, 1, 2, 3, 4, 5, 6], status: 'active', start: '2026-09-26', criteria: '', minimum: false, projects: [], goals: [] });
  raw.planner.occurrences.push({ id: 'old-occurrence', rule: 'rule', date: '2026-09-26', task: 'routine', status: 'missed' });
  const migrated = await prepareMigration(emptyActionData(), { format: 'cardgrid-v1-p1a', raw: raw as unknown as Json }, { zone: 'Asia/Shanghai' }, at, 'm');
  assert.deepEqual(migrated.report.issues.filter(i => i.blocking), []); const source = migrated.data.legacySources[0];
  const ref = { kind: 'legacy' as const, sourceId: source.id, path: '/planner/occurrences/@old-occurrence' };
  const first = applyAction(migrated.data, legacyMakeup(migrated.data, ref, '2026-09-27', at, 'makeup'), { ...context('makeup'), at }).data;
  const again = applyAction(first, legacyMakeup(first, ref, '2026-09-27', at, 'ignored'), { ...context('again'), at });
  assert.deepEqual(again.data, first); validateActionData(first); assert.equal(first.planner.instances.length, 1); assert.deepEqual(first.legacySources[0].raw, raw);
  const operation = calendarOperation(first, { date: '2026-09-26', zone: 'Asia/Shanghai', templateId: null }, false, '2026-09-26T01:30:00Z', 'prepare');
  assert.equal(operation.occurrences.length, 0); assert.equal(operation.instances.length, 0);
});
test('pre-planner migration preserves Top3, Minimum Day and precise old day occupancy', async () => {
  const old = oldData(), raw: any = { config: old.config, legacyArchives: [], projects: [{ id: 'p', name: '项目', status: 'active' }], inbox: [{ id: 'c', text: '来源捕获', createdAt: at, status: 'converted', targetId: 'card' }],
    days: [{ date: '2026-09-27', top3: ['card'], minimumMode: true, scheduleId: 'schedule', overrides: {} }] };
  raw.config.cards.push({ id: 'card', title: '七分钟', kind: 'temporary', minutes: 7, categoryId: null, parentId: null, steps: '', enabled: true });
  raw.config.schedules.push({ id: 'schedule', name: '精确旧模板', entries: [{ cardId: 'card', start: '09:02', minutes: 7 }] });
  const target = await prepareMigration(emptyActionData(), { format: 'cardgrid-v1-pre-planner', raw }, { zone: 'Asia/Shanghai' }, at, 'pre');
  assert.equal(target.report.issues.some(i => i.blocking), false); validateActionData(target.data); assert.equal(target.data.planner.days[0].minimum, true);
  assert.equal(target.data.planner.days[0].top3[0].kind, 'legacy'); assert.equal(target.data.planner.captures[0].target?.kind, 'legacy'); assert.equal(target.data.planner.refs.length, 1);
  const occupied = legacyProjection(target.data); assert.equal(occupied.occupancy.unknown, false); assert.equal(elapsedMinutes(occupied.occupancy.items[0].range), 7); assert.deepEqual(target.data.legacySources[0].raw, raw);
});
test('template DST ambiguity requires an explicit entry offset and preserves full elapsed duration', () => {
  const data = emptyActionData(); const templated: DataV2 = { ...data, planner: { ...data.planner, templates: [{ id: 't', version: 1, name: '重复小时', weekdays: [], source: { kind: 'manual' }, entries: [{ id: 'e', title: '安排', start: '01:30', elapsedMinutes: 30, definitionId: null }] }] } };
  const input = { date: '2026-11-01', zone: 'America/New_York', templateId: 't' };
  assert.throws(() => calendarOperation(templated, input, true, at, 'ambiguous'), /偏移|歧义|重复/);
  const first = calendarOperation(templated, { ...input, entryOffsets: { e: '-04:00' } }, true, at, 'earlier');
  const second = calendarOperation(templated, { ...input, entryOffsets: { e: '-05:00' } }, true, at, 'later');
  assert.notEqual(first.fixed[0].range.startAt, second.fixed[0].range.startAt); assert.equal(elapsedMinutes(first.fixed[0].range), 30); assert.equal(elapsedMinutes(second.fixed[0].range), 30);
});
