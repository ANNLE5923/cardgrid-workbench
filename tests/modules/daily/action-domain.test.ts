import test from 'node:test';
import assert from 'node:assert/strict';
import type { DataV2 } from '../../../src/workspace/contracts.ts';
import { ActionDomainError, applyAction, assertActionState, assertActionTransition, occupancy, overlaps, type ActionOperation } from '../../../src/daily/model/domain.ts';
import { ActionTimeError, actualRange, elapsedMinutes } from '../../../src/daily/schedule/time.ts';
import { content, context, empty, range } from '../../fixtures/action/seed.ts';

const ref = (id: string, version = 1) => ({ id, version });
function run(data: DataV2, operation: ActionOperation, id: string): DataV2 { return applyAction(data, operation, context(id)).data; }
function create(data = empty(), id = 'i1', minutes: number | null = 15): DataV2 {
  return run(data, { type: 'CreateManualInstance', instanceId: id, content: content(minutes), targetDate: null }, `create-${id}`);
}
function place(data: DataV2, instanceId = 'i1', planId = 'p1', value = range()): DataV2 {
  return run(data, { type: 'PlaceInstance', instance: ref(instanceId), planId, range: value }, `place-${planId}`);
}
function confirm(data: DataV2, value = range(), expectedPlan: { id: string; version: number } | null = ref('p1')): DataV2 {
  return run(data, { type: 'ConfirmActual', instance: ref('i1'), expectedPlan, factId: 'f1', range: value }, 'confirm');
}
function fails(code: string, fn: () => unknown): void {
  assert.throws(fn, e => (e instanceof ActionDomainError || e instanceof ActionTimeError) && e.code === code);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
  return value;
}
function fixedData(): DataV2 {
  const data = empty();
  return { ...data, planner: { ...data.planner, fixed: [{ id: 'fixed1', version: 1, title: '固定安排', range: range('09:10', 30), cancelled: false,
    ownerDate: '2026-09-26', template: ref('template1'), templateEntryId: 'entry1', manuallyOverridden: false, source: { kind: 'manual' } }],
    templates: [{ id: 'template1', version: 1, name: '合成模板', weekdays: [6], source: { kind: 'manual' }, entries: [{ id: 'entry1', title: '固定安排', start: '09:10', elapsedMinutes: 30, definitionId: null }] }],
    days: [{ date: '2026-09-26', zone: 'Asia/Shanghai', version: 1, name: '合成日', template: ref('template1'), minimum: false, top3: [], overrides: [] }] } };
}
test('C01: accepting a definition creates one unscheduled instance and preserves creation content', () => {
  let data = run(empty(), { type: 'SaveDefinition', id: 'd1', expectedVersion: null, content: content(), enabled: true, parentDefinitionId: null }, 'def1');
  data = run(data, { type: 'AcceptDefinition', definition: ref('d1'), instanceId: 'i1', targetDate: '2026-09-26' }, 'accept');
  assert.deepEqual(data.planner.handOrder, ['i1']); assert.equal(occupancy(data).length, 0);
  assert.equal(data.planner.instances[0].source.kind, 'definition');
  const oldInstance = structuredClone(data.planner.instances[0]);
  data = run(data, { type: 'SaveDefinition', id: 'd1', expectedVersion: 1, content: { ...content(30), title: '新定义' }, enabled: false, parentDefinitionId: null }, 'def2');
  assert.deepEqual(data.planner.instances[0], oldInstance);
  fails('DEFINITION_STALE', () => run(data, { type: 'AcceptDefinition', definition: ref('d1'), instanceId: 'i2', targetDate: null }, 'stale'));
  fails('DEFINITION_DISABLED', () => run(data, { type: 'AcceptDefinition', definition: ref('d1', 2), instanceId: 'i2', targetDate: null }, 'disabled'));
});
test('pure transitions are deterministic and leave deeply frozen input intact on success and failure', () => {
  const data = freeze(create()); const before = structuredClone(data);
  const operation: ActionOperation = { type: 'PlaceInstance', instance: ref('i1'), planId: 'p1', range: range() };
  assert.deepEqual(applyAction(data, operation, context('one')), applyAction(data, operation, context('one')));
  fails('INVALID_INPUT', () => run(data, { ...operation, range: range('09:00', 10) }, 'shortened'));
  assert.deepEqual(data, before);
});
test('C02/C04: complete duration and all overlaps are preserved after explicit acknowledgement', () => {
  const data = freeze(create(fixedData(), 'i1', 25)); const original = structuredClone(data);
  const value = range('09:00', 25);
  fails('OVERLAP_CONFIRMATION_REQUIRED', () => run(data, { type: 'PlaceInstance', instance: ref('i1'), planId: 'p1', range: value }, 'no-ack'));
  const conflicts = overlaps(data, value);
  assert.equal(conflicts.length, 1); assert.equal(elapsedMinutes(conflicts[0].overlap), 15);
  const next = run(data, { type: 'PlaceInstance', instance: ref('i1'), planId: 'p1', range: value, acknowledgedOverlaps: conflicts }, 'ack');
  assert.equal(elapsedMinutes(next.planner.plans[0].range), 25); assert.deepEqual(next.planner.fixed, original.planner.fixed);
  assert.deepEqual(data, original);
  fails('PREVIEW_STALE', () => run(data, { type: 'PlaceInstance', instance: ref('i1'), planId: 'p2', range: range('09:05', 25), acknowledgedOverlaps: conflicts }, 'stale-overlap'));
});
test('C05/C30: retract preserves the old plan; re-place keeps instance ID and appends at hand end', () => {
  let data = create(create(), 'i2'); data = place(data);
  const snapshot = structuredClone(data.planner.instances[0].creationSnapshot);
  data = run(data, { type: 'RetractPlan', plan: ref('p1') }, 'retract');
  assert.deepEqual(data.planner.handOrder, ['i2', 'i1']); assert.equal(data.planner.plans[0].status, 'retracted');
  const oldPlan = structuredClone(data.planner.plans[0]);
  data = run(data, { type: 'UpdateInstance', instance: ref('i1'), content: content(30), targetDate: null }, 'edit');
  data = run(data, { type: 'PlaceInstance', instance: ref('i1', 2), planId: 'p2', range: range('10:00', 30) }, 'replace');
  assert.deepEqual(data.planner.plans[0], oldPlan); assert.equal(data.planner.instances.length, 2);
  assert.equal(data.planner.plans[1].instanceId, 'i1'); assert.equal(elapsedMinutes(data.planner.plans[1].range), 30);
  assert.deepEqual(data.planner.instances[0].creationSnapshot, snapshot);
});
test('active duration edits must update the full range atomically and leave old content snapshot intact', () => {
  const data = place(create()); const old = structuredClone(data);
  fails('INVALID_INPUT', () => run(data, { type: 'UpdateInstance', instance: ref('i1'), content: content(30), targetDate: null }, 'missing-range'));
  const next = run(data, { type: 'UpdateInstance', instance: ref('i1'), content: content(30), targetDate: null, replacementRange: range('09:00', 30) }, 'duration');
  assert.equal(next.planner.instances[0].version, 2); assert.equal(next.planner.plans[0].version, 2);
  assert.equal(elapsedMinutes(next.planner.plans[0].range), 30);
  assert.deepEqual(next.planner.plans[0].contentSnapshot, old.planner.plans[0].contentSnapshot); assert.deepEqual(data, old);
});
test('C06/C31: future actual end is allowed and locks immediately, with plan and confirmation time distinct', () => {
  const data = place(create(empty(), 'i1', 30), 'i1', 'p1', range('09:00', 30));
  const next = confirm(data, range('09:20', 30)); const fact = next.planner.facts[0];
  assert.equal(fact.confirmedAt, '2026-09-26T01:30:00Z'); assert.equal(fact.actualRange.localEnd, '2026-09-26T09:50');
  assert.equal(fact.plannedSnapshot?.range.localStart, '2026-09-26T09:00');
  assert.equal(next.planner.plans[0].status, 'confirmed'); assert.deepEqual(next.planner.handOrder, []);
  assert.deepEqual(occupancy(next).map(item => item.kind), ['fact']);
  fails('FACT_LOCKED', () => run(next, { type: 'UpdateInstance', instance: ref('i1'), content: content(), targetDate: null }, 'locked'));
  fails('ALREADY_CONFIRMED', () => run(next, { type: 'ConfirmActual', instance: ref('i1'), expectedPlan: null, factId: 'f2', range: range() }, 'duplicate'));
});
test('C06: actual confirmation excludes its own plan and requires acknowledgement of every other object', () => {
  let data = create(fixedData(), 'i1', 15);
  data = place(data, 'i1', 'p1', range('08:00', 15));
  const value = range('09:00', 30); const before = structuredClone(data);
  fails('OVERLAP_CONFIRMATION_REQUIRED', () => confirm(data, value));
  const next = run(data, { type: 'ConfirmActual', instance: ref('i1'), expectedPlan: ref('p1'), factId: 'f1', range: value,
    acknowledgedOverlaps: overlaps(data, value, { kind: 'plan', id: 'p1' }) }, 'confirm-ack');
  assert.deepEqual(next.planner.fixed, before.planner.fixed); assert.deepEqual(data, before);
  fails('PREVIEW_STALE', () => run(data, { type: 'ConfirmActual', instance: ref('i1'), expectedPlan: null, factId: 'f1', range: value }, 'wrong-plan'));
});
test('C09/C22: facts and annotation order are append-only, including direct transition checks', () => {
  let data = confirm(place(create()));
  data = run(data, { type: 'AppendAnnotation', factId: 'f1', annotationId: 'a1', text: '原录入说明' }, 'a1');
  const original = structuredClone(data);
  data = run(data, { type: 'AppendAnnotation', factId: 'f1', annotationId: 'a2', text: '后续纠正说明' }, 'a2');
  assert.deepEqual(data.planner.facts, original.planner.facts); assert.deepEqual(data.planner.annotations[0], original.planner.annotations[0]);
  const fact = data.planner.facts[0], a = data.planner.annotations;
  for (const altered of [
    { ...data, planner: { ...data.planner, facts: [] } },
    { ...data, planner: { ...data.planner, facts: [{ ...fact, confirmedAt: '2026-09-26T02:00:00Z' }] } },
    { ...data, planner: { ...data.planner, annotations: [a[1], a[0]] } },
    { ...data, planner: { ...data.planner, annotations: [{ ...a[0], text: '篡改' }, a[1]] } }
  ]) fails('FACT_LOCKED', () => assertActionTransition(data, altered));
});
test('one active plan and one fact per instance are checked as invariants', () => {
  const planned = place(create());
  fails('ALREADY_PLANNED', () => place(planned, 'i1', 'p2'));
  fails('INVALID_INPUT', () => assertActionState({ ...planned, planner: { ...planned.planner, plans: [...planned.planner.plans, { ...planned.planner.plans[0], id: 'p2' }] } }));
  const done = confirm(planned);
  fails('INVALID_INPUT', () => assertActionState({ ...done, planner: { ...done.planner, facts: [...done.planner.facts, { ...done.planner.facts[0], id: 'f2' }] } }));
});
test('no-duration hand items can record actual minute intervals without inventing a plan', () => {
  const data = create(empty(), 'i1', null);
  fails('DURATION_REQUIRED', () => place(data));
  const value = actualRange({ date: '2026-09-26', time: '09:02', zone: 'Asia/Shanghai' }, { date: '2026-09-26', time: '09:19', zone: 'Asia/Shanghai' });
  const done = confirm(data, value, null);
  assert.equal(done.planner.facts[0].plannedSnapshot, null); assert.equal(done.planner.plans.length, 0); assert.equal(elapsedMinutes(done.planner.facts[0].actualRange), 17);
});
test('C20: hand sorting must be a complete permutation; withdrawal and return keep identity', () => {
  const data = create(create(), 'i2');
  fails('INVALID_INPUT', () => run(data, { type: 'ReorderHand', instanceIds: ['i1'] }, 'omit'));
  fails('INVALID_INPUT', () => run(data, { type: 'ReorderHand', instanceIds: ['i1', 'i1'] }, 'duplicate'));
  let next = run(data, { type: 'ReorderHand', instanceIds: ['i2', 'i1'] }, 'sort');
  next = run(next, { type: 'WithdrawInstance', instance: ref('i1') }, 'withdraw');
  assert.deepEqual(next.planner.handOrder, ['i2']); assert.equal(next.planner.instances[0].state, 'withdrawn');
  next = run(next, { type: 'ReturnToHand', instance: ref('i1', 2) }, 'return');
  assert.deepEqual(next.planner.handOrder, ['i2', 'i1']); assert.equal(next.planner.instances.length, 2);
});
test('unchanged and empty hand orders produce no fictitious day or history', () => {
  const blank = empty();
  const noCards = applyAction(blank, { type: 'ReorderHand', instanceIds: [] }, context('empty-sort'));
  assert.equal(noCards.changed, false); assert.equal(noCards.data, blank);
  const data = create();
  assert.equal(applyAction(data, { type: 'ReorderHand', instanceIds: ['i1'] }, context('same-sort')).data, data);
  const sorted = run(create(data, 'i2'), { type: 'ReorderHand', instanceIds: ['i2', 'i1'] }, 'real-sort');
  assert.deepEqual(sorted.planner.history.at(-1)!.entity, { kind: 'instance', id: 'i2' });
  assert.equal(sorted.planner.days.length, 0);
});
test('creation snapshots and sealed plans cannot be changed through a direct state replacement', () => {
  const data = create();
  fails('FACT_LOCKED', () => assertActionTransition(data, { ...data, planner: { ...data.planner,
    instances: [{ ...data.planner.instances[0], creationSnapshot: content(30) }] } }));
  const sealed = run(place(data), { type: 'RetractPlan', plan: ref('p1') }, 'seal');
  fails('FACT_LOCKED', () => assertActionTransition(sealed, { ...sealed, planner: { ...sealed.planner,
    plans: [{ ...sealed.planner.plans[0], range: range('10:00', 15) }] } }));
});
test('C42: fixed unlock and overlap acknowledgement are independent; day overrides are retained', () => {
  let data = fixedData(); data = place(create(data), 'i1', 'p1', range('10:00', 15));
  const original = structuredClone(data);
  const operation = { type: 'MoveFixed' as const, fixed: ref('fixed1'), unlock: null, range: range('10:00', 30) };
  fails('FIXED_LOCKED', () => run(data, operation, 'locked-fixed'));
  fails('FIXED_LOCKED', () => run(data, { ...operation, unlock: ref('other') }, 'wrong-unlock'));
  fails('OVERLAP_CONFIRMATION_REQUIRED', () => run(data, { ...operation, unlock: ref('fixed1') }, 'overlap-fixed'));
  let next = run(data, { ...operation, unlock: ref('fixed1'), acknowledgedOverlaps: overlaps(data, operation.range, { kind: 'fixed', id: 'fixed1' }) }, 'move-fixed');
  assert.deepEqual(next.planner.plans, original.planner.plans); assert.equal(next.planner.fixed[0].manuallyOverridden, true);
  assert.equal(next.planner.days[0].overrides[0].kind, 'edited');
  next = run(next, { type: 'CancelFixed', fixed: ref('fixed1', 2), unlock: ref('fixed1', 2) }, 'cancel-fixed');
  assert.equal(next.planner.days[0].overrides[0].kind, 'cancelled'); assert.equal(next.planner.fixed[0].cancelled, true); assert.deepEqual(data, original);
});
test('C43: past ordinary plans can move; past routine results require one separate makeup instance', () => {
  let ordinary = place(create(), 'i1', 'p1', range('09:00', 15, '2026-09-25'));
  ordinary = run(ordinary, { type: 'MovePlan', plan: ref('p1'), range: range('10:00', 15, '2026-09-25') }, 'move-past');
  assert.equal(ordinary.planner.plans[0].id, 'p1'); assert.equal(ordinary.planner.plans[0].version, 2);
  const seed = create();
  const routine: DataV2 = { ...seed, planner: { ...seed.planner,
    instances: [{ ...seed.planner.instances[0], occurrenceId: 'o1', source: { kind: 'occurrence', id: 'o1' } }],
    rules: [{ id: 'r1', version: 1, name: '合成例行', definitionId: 'd1', weekdays: [5], startDate: '2026-09-01', zone: 'Asia/Shanghai', status: 'active', source: { kind: 'manual' } }],
    definitions: [{ id: 'd1', version: 1, content: content(), enabled: true, parentDefinitionId: null, source: { kind: 'manual' } }],
    occurrences: [{ id: 'o1', ruleId: 'r1', date: '2026-09-25', instanceId: 'i1', disposition: 'generated' }] } };
  fails('PAST_OCCURRENCE_LOCKED', () => confirm(routine, range(), null));
  const made = run(routine, { type: 'CreateMakeup', occurrenceId: 'o1', instanceId: 'i2', targetDate: '2026-09-26' }, 'makeup');
  assert.deepEqual(made.planner.occurrences, routine.planner.occurrences); assert.deepEqual(made.planner.instances[0], routine.planner.instances[0]);
  const repeated = applyAction(made, { type: 'CreateMakeup', occurrenceId: 'o1', instanceId: 'i3', targetDate: '2026-09-26' }, context('repeat'));
  assert.equal(repeated.data, made); assert.equal(repeated.changed, false); assert.deepEqual(repeated.resultRefs, [{ kind: 'instance', id: 'i2' }]);
});
test('capture conversion retains original text and can only create one instance', () => {
  const base = empty();
  const data: DataV2 = { ...base, planner: { ...base.planner, captures: [{ id: 'c1', version: 1, text: '  原始输入  ', createdAt: context('c').at, source: 'quick', status: 'unprocessed', target: null }] } };
  const next = run(data, { type: 'ResolveCapture', capture: ref('c1'), instanceId: 'i1', content: content(), targetDate: null }, 'capture');
  assert.equal(next.planner.captures[0].text, '  原始输入  '); assert.equal(next.planner.days.length, 0); assert.equal(next.planner.plans.length, 0);
  fails('CAPTURE_ALREADY_RESOLVED', () => run(next, { type: 'ResolveCapture', capture: ref('c1', 2), instanceId: 'i2', content: content(), targetDate: null }, 'again'));
});
test('unresolved legacy occupancy is never silently treated as free time', () => {
  const data = create();
  const legacy: DataV2 = { ...data, legacySources: [{ id: 'legacy1', format: 'legacy-archive', fingerprint: 'test-only', importedAt: context('l').at, raw: {} }] };
  fails('MIGRATION_BLOCKED', () => occupancy(legacy));
  fails('MIGRATION_BLOCKED', () => applyAction(legacy, { type: 'PlaceInstance', instance: ref('i1'), planId: 'p1', range: range() }, { ...context('blocked'), compatibility: { unknown: true, items: [] } }));
});
