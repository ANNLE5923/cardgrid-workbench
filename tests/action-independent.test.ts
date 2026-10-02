import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, assertActionTransition } from '../src/action-domain.ts';
import { inspectSnapshot, assertCommand, calendarOperation } from '../src/action-commands.ts';
import { projectDay } from '../src/action-projection.ts';
import { actualRange, dayRange, elapsedMinutes, plannedRange, resolveLocal, splitRangeForDay } from '../src/action-time.ts';
import { MAX_BACKUP_BYTES, backupBytes, canonicalJson, fingerprint, parseRestore, resolveLegacyPath, sourcePathPart, validateActionData, validateDefinitionConfig, validateSourceFingerprints, validateWorkspace } from '../src/workspace-format.ts';
import { legacyProjection, prepareMigration } from '../src/workspace-migration.ts';
import { AT, blank, confirmed, content, envelope, fixed, hand, old, planned, shanghai } from './fixtures/action/independent.ts';

// Mutation helpers are test-local; never normalize the fixture to make it valid.
type Mutable = any;
const clone = (value: unknown): Mutable => structuredClone(value);
const ctx = (id: string) => ({ at: AT, date: '2026-09-28', commandId: id, historyId: `history:${id}` });
const expectCode = (code: string, action: () => unknown) => assert.throws(action, (e: any) => e.code === code);
const source = (raw: unknown, id?: string): any => ({ format: 'cardgrid-v1-p1a', raw, ...(id ? { id } : {}) });
const migration = (raw: unknown, id?: string, base = blank()) => prepareMigration(base, source(raw, id), { zone: 'Asia/Shanghai' }, AT, 'migration-test');

test('2B fixture sanity: literal hand/planned/confirmed/fixed records all satisfy the frozen schema', () => {
  for (const fixture of [blank(), hand(), planned(), confirmed(), fixed()]) validateActionData(fixture);
});

const invalid: [string, () => Mutable, (d: Mutable) => void][] = [
  ['unknown nested field', hand, d => d.planner.instances[0].currentContent.done = true],
  ['missing snapshot field', hand, d => delete d.planner.instances[0].creationSnapshot.categoryLabel],
  ['unsafe version', hand, d => d.planner.instances[0].version = Number.MAX_SAFE_INTEGER + 1],
  ['fractional version', hand, d => d.planner.instances[0].version = 1.5],
  ['missing hand reference', hand, d => d.planner.handOrder = []],
  ['duplicate hand reference', hand, d => d.planner.handOrder = ['i', 'i']],
  ['dangling plan instance', planned, d => d.planner.plans[0].instanceId = 'missing'],
  ['second active plan', planned, d => d.planner.plans.push({ ...d.planner.plans[0], id: 'p2' })],
  ['bad local offset', planned, d => d.planner.plans[0].range.startOffset = '+09:00'],
  ['shortened full duration', planned, d => d.planner.plans[0].range = shanghai('09:00', 25)],
  ['confirmed plan has no fact', confirmed, d => d.planner.facts = []],
  ['two facts for one instance', confirmed, d => d.planner.facts.push({ ...d.planner.facts[0], id: 'f2' })],
  ['dangling annotation', confirmed, d => d.planner.annotations[0].factId = 'missing'],
  ['wrong planned snapshot version', confirmed, d => d.planner.facts[0].plannedSnapshot.planVersion = 3],
  ['invalid plan range minute', planned, d => d.planner.plans[0].range = shanghai('09:02', 30)],
  ['project WIP above three', blank, d => d.planner.refs = [1, 2, 3, 4].map(i => ({ id: String(i), name: String(i), status: 'active' }))],
  ['Top3 above three', hand, d => { d.planner.instances = [1, 2, 3, 4].map(i => ({ ...d.planner.instances[0], id: String(i) })); d.planner.handOrder = ['1', '2', '3', '4']; d.planner.days = [{ date: '2026-09-28', zone: 'Asia/Shanghai', version: 1, name: '', template: null, minimum: false, overrides: [], top3: d.planner.handOrder.map((id: string) => ({ kind: 'instance', id })) }]; }],
  ['dangling fixed template', fixed, d => d.planner.fixed[0].template = { id: 'missing', version: 1 }],
  ['duplicate successful receipts', blank, d => d.commandReceipts = [1, 2].map(() => ({ commandId: 'same', type: 'ReorderHand', payloadFingerprint: 'sha', resultRefs: [] }))],
  ['missing rule definition', blank, d => d.planner.rules = [{ id: 'r', version: 1, name: 'r', definitionId: 'missing', weekdays: [1], startDate: '2026-09-28', zone: 'Asia/Shanghai', status: 'active', source: { kind: 'manual' } }]]
];
for (const [label, factory, mutate] of invalid) test(`2B C16/C34/C39 strict format: ${label}`, () => {
  const data = clone(factory()); mutate(data); const before = clone(data);
  assert.throws(() => validateActionData(data)); assert.deepEqual(data, before);
});

test('2B C16 unknown/mismatched envelope and backup versions are rejected', () => {
  for (const raw of [{ ...envelope(), schemaVersion: 99 }, { ...envelope(), dataFormat: 'cardgrid-v1-p1a' }, { ...envelope(), revision: -1 }]) assert.throws(() => validateWorkspace(raw));
  assert.throws(() => parseRestore(JSON.stringify({ format: 'cardgrid', kind: 'backup', version: 1, data: blank() })));
});

test('2B C09/C22 confirmed data, annotation order, creation snapshot and sealed plan cannot be replaced', () => {
  const before = confirmed();
  const mutations: ((d: Mutable) => void)[] = [d => d.planner.facts = [], d => d.planner.facts[0].source = { kind: 'capture', id: 'made-up' },
    d => d.planner.facts[0].contentSnapshot.title = 'changed', d => d.planner.facts[0].confirmedAt = '2026-09-28T03:00:00Z',
    d => d.planner.annotations[0].text = 'changed', d => d.planner.annotations = [], d => d.planner.instances[0].creationSnapshot.title = 'changed',
    d => d.planner.plans[0].range = shanghai('10:00', 30)];
  for (const change of mutations) { const after = clone(before); change(after); expectCode('FACT_LOCKED', () => assertActionTransition(before, after)); }
  const next = applyAction(before, { type: 'AppendAnnotation', factId: 'f', annotationId: 'a2', text: '更正前条说明' }, ctx('annotation')).data;
  assert.deepEqual(next.planner.facts, before.planner.facts); assert.deepEqual(next.planner.annotations.slice(0, 1), before.planner.annotations);
});

test('2B C30 retraction and re-placement preserve old identity, snapshots and ordering', () => {
  const before = planned();
  let next = applyAction(before, { type: 'RetractPlan', plan: { id: 'p', version: 4 } }, ctx('retract')).data;
  const sealed = clone(next.planner.plans[0]);
  next = applyAction(next, { type: 'UpdateInstance', instance: { id: 'i', version: 7 }, content: content(60), targetDate: null }, ctx('edit')).data;
  next = applyAction(next, { type: 'PlaceInstance', instance: { id: 'i', version: 8 }, planId: 'new-plan', range: shanghai('11:00', 60) }, ctx('place')).data;
  assert.deepEqual(next.planner.plans[0], sealed); assert.equal(next.planner.instances.length, 1); assert.deepEqual(next.planner.instances[0].creationSnapshot, content(30));
  assert.equal(next.planner.plans[1].instanceId, 'i'); assert.equal(next.planner.plans[1].range.endAt, '2026-09-28T04:00:00Z');
});

test('2B C34 projection carries non-default plan/instance versions from the same snapshot', async () => {
  const snapshot = await inspectSnapshot(envelope(planned())), view = projectDay(snapshot, { date: '2026-09-28', zone: 'Asia/Shanghai' }, AT);
  assert.deepEqual(view.plans[0], { planId: 'p', version: 4, instanceId: 'i', instanceVersion: 7, range: shanghai() });
  assert.deepEqual(view.token, snapshot.token);
});

test('2B C06/C31 facts occupy actual range only and lock before their future end', () => {
  const result = applyAction(planned(), { type: 'ConfirmActual', instance: { id: 'i', version: 7 }, expectedPlan: { id: 'p', version: 4 }, factId: 'new-fact', range: shanghai('09:20', 120) }, ctx('confirm')).data;
  assert.equal(result.planner.facts[0].confirmedAt, AT); assert.equal(result.planner.facts[0].actualRange.endAt, '2026-09-28T03:20:00Z');
  expectCode('FACT_LOCKED', () => applyAction(result, { type: 'UpdateInstance', instance: { id: 'i', version: 7 }, content: content(), targetDate: null }, ctx('illegal-edit')));
});

test('2B C11 actual minute precision is independent of preset and supports an unplanned instance', () => {
  const data = clone(hand()); data.planner.instances[0].currentContent = content(null); data.planner.instances[0].creationSnapshot = content(null);
  const value = actualRange({ date: '2026-09-28', time: '09:02', zone: 'Asia/Shanghai' }, { date: '2026-09-28', time: '09:19', zone: 'Asia/Shanghai' });
  assert.deepEqual(value, shanghai('09:02', 17));
  const next = applyAction(data, { type: 'ConfirmActual', instance: { id: 'i', version: 7 }, expectedPlan: null, factId: 'f', range: value }, ctx('unplanned')).data;
  assert.equal(next.planner.facts[0].plannedSnapshot, null); assert.equal(next.planner.plans.length, 0);
});

test('2B C35 cross-day flags and half-day boundaries use complete sources, conserving duration', () => {
  const cross = shanghai('23:50', 25), first = splitRangeForDay(cross, '2026-09-28', 'Asia/Shanghai'), second = splitRangeForDay(cross, '2026-09-29', 'Asia/Shanghai');
  assert.equal(first[0].continuesAfter, true); assert.equal(second[0].continuesBefore, true);
  assert.equal([...first, ...second].reduce((n, s) => n + elapsedMinutes(s.range), 0), 25);
  const noon = splitRangeForDay(shanghai('11:50', 20), '2026-09-28', 'Asia/Shanghai');
  assert.deepEqual(noon.map(s => s.half), [0, 1]); assert.equal(noon.some(s => s.continuesAfter || s.continuesBefore), false);
  assert.equal(splitRangeForDay(shanghai('23:45', 15), '2026-09-28', 'Asia/Shanghai')[0].continuesAfter, false);
});

const timezoneCases = [
  ['America/New_York', '2026-03-08', 1380, '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z'],
  ['America/New_York', '2026-11-01', 1500, '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z'],
  ['Australia/Lord_Howe', '2026-04-05', 1470, '2026-04-04T13:00:00Z', '2026-04-05T13:30:00Z'],
  ['America/Sao_Paulo', '2018-11-04', 1380, '2018-11-04T03:00:00Z', '2018-11-05T02:00:00Z']
] as const;
for (const [zone, date, duration, startAt, endAt] of timezoneCases) test(`2B C44 day bounds: ${zone} ${date}`, () => {
  const range = dayRange(date, zone); assert.deepEqual(range, { startAt, endAt, zone }); assert.equal(elapsedMinutes(range), duration);
  assert.equal(splitRangeForDay(range, date, zone).reduce((n, s) => n + elapsedMinutes(s.range), 0), duration);
});
test('2B C36/C44 missing date/time and independently ambiguous actual endpoints are explicit', () => {
  expectCode('NONEXISTENT_LOCAL_TIME', () => dayRange('2011-12-30', 'Pacific/Apia'));
  expectCode('NONEXISTENT_LOCAL_TIME', () => resolveLocal({ date: '2026-03-08', time: '02:30', zone: 'America/New_York' }));
  for (const endpoint of ['01:10', '01:50']) assert.throws(() => resolveLocal({ date: '2026-11-01', time: endpoint, zone: 'America/New_York' }), (e: any) => e.code === 'AMBIGUOUS_LOCAL_TIME' && e.choices.length === 2);
  const value = actualRange({ date: '2026-11-01', time: '01:50', zone: 'America/New_York', offset: '-04:00' }, { date: '2026-11-01', time: '01:10', zone: 'America/New_York', offset: '-05:00' });
  assert.equal(value.startAt, '2026-11-01T05:50:00Z'); assert.equal(value.endAt, '2026-11-01T06:10:00Z'); assert.equal(elapsedMinutes(value), 20);
});
test('2B C24 elapsed duration lands on distinct real identities during fall-back', () => {
  const start = { date: '2026-10-31', time: '23:00', zone: 'America/New_York' };
  const a = plannedRange(start, 150), b = plannedRange(start, 210);
  assert.equal(a.localEnd, b.localEnd); assert.equal(a.endOffset, '-04:00'); assert.equal(b.endOffset, '-05:00'); assert.equal(a.endAt, '2026-11-01T05:30:00Z'); assert.equal(b.endAt, '2026-11-01T06:30:00Z');
});

test('2B C32 red empty-time projection is derived at local midnight, and recomputes from actual only', async () => {
  const snapshot = await inspectSnapshot(envelope(confirmed()));
  const before = clone(snapshot.raw), input = { date: '2026-09-28', zone: 'Asia/Shanghai' };
  const early = projectDay(snapshot, input, '2026-09-28T15:59:00Z'), ended = projectDay(snapshot, input, '2026-09-28T16:00:00Z');
  assert.equal(early.segments.some(s => s.kind === 'empty'), false); assert.equal(ended.segments.some(s => s.kind === 'empty'), true);
  assert.equal(ended.freeRanges.reduce((n, r) => n + elapsedMinutes(r), 0), 1400);
  assert.deepEqual(snapshot.raw, before); assert.deepEqual(ended.facts[0].actualRange, shanghai('09:20', 40));
});

test('2B C37 all old envelopes restore exact field presence and order without initializing', () => {
  const raw = old();
  for (const value of [{ schemaVersion: 1, revision: 3, config: raw.config }, { schemaVersion: 2, revision: 4, data: raw }, { schemaVersion: 3, revision: 5, data: { config: raw.config, legacyArchives: [] } }]) {
    validateWorkspace(value);
    const pack = value.schemaVersion === 1 ? { format: 'cardgrid', version: 2, kind: 'backup', dataFormat: 'envelope-v1', data: value } : { format: 'cardgrid', version: 1, kind: 'backup', data: value.data };
    for (let i = 0; i < 3; i++) { const target = parseRestore(JSON.stringify(pack)); assert.equal(target.mode, 'legacy-readonly'); assert.deepEqual(target.data, pack.data); }
  }
});
test('2B C16 capacity counts UTF-8 bytes and accepts exactly 5 MiB, rejects the next byte', () => {
  const raw = JSON.stringify({ format: 'cardgrid', version: 2, kind: 'backup', dataFormat: 'action-v2', data: blank() });
  const size = new TextEncoder().encode(raw).length, boundary = raw + ' '.repeat(MAX_BACKUP_BYTES - size);
  assert.equal(new TextEncoder().encode(boundary).length, MAX_BACKUP_BYTES); assert.deepEqual(parseRestore(boundary).data, blank()); assert.throws(() => parseRestore(boundary + ' '));
  const data = clone(blank()); data.planner.captures = [{ id: 'c', version: 1, text: '字'.repeat(1000), createdAt: AT, source: '', status: 'unprocessed', target: null }];
  assert.equal(backupBytes(data), new TextEncoder().encode(JSON.stringify({ format: 'cardgrid', version: 2, kind: 'backup', dataFormat: 'action-v2', data })).length);
});

test('2B C39 source identity ignores key order, retains array order and escaped original IDs', async () => {
  const raw = old(); raw.planner.tasks[0].id = 'a/b~c'; raw.planner.days[0].blocks[0].task = 'a/b~c'; raw.planner.days[0].top3[0] = 'a/b~c';
  assert.deepEqual(resolveLegacyPath(raw, '/planner/tasks/' + sourcePathPart('a/b~c')), raw.planner.tasks[0]);
  const reordered = Object.fromEntries(Object.entries(raw).reverse()); assert.equal(await fingerprint(raw), await fingerprint(reordered));
  const reversed = clone(raw); reversed.planner.tasks.reverse(); assert.notEqual(await fingerprint(raw), await fingerprint(reversed));
  const prepared = await migration(raw); assert.equal(prepared.report.issues.some(i => i.blocking), false);
  await validateSourceFingerprints(prepared.data); const corrupted = clone(prepared.data); corrupted.legacySources[0].raw.planner.tasks[0].title = 'changed'; await assert.rejects(() => validateSourceFingerprints(corrupted));
});
test('2B C12/C39 migration preserves old seven-minute occupancy and old completed records without facts', async () => {
  const raw = old(); raw.config.cards[0].minutes = 7; raw.planner.days[0].blocks[0].end = 547;
  const before = clone(raw), prepared = await migration(raw);
  assert.equal(prepared.report.issues.some(i => i.blocking), false); assert.equal(prepared.data.planner.facts.length, 0); assert.equal(prepared.data.planner.plans.length, 0); assert.equal(prepared.data.planner.instances.length, 0);
  assert.deepEqual(prepared.data.legacySources[0].raw, before); assert.deepEqual(raw, before);
  const projected = legacyProjection(prepared.data); assert.equal(projected.occupancy.unknown, false); assert.equal(elapsedMinutes(projected.occupancy.items[0].range), 7);
});
test('2B C39 multi-block association needs explicit read-only choice and never picks the first block', async () => {
  const raw = old(); raw.planner.days[0].blocks.push({ ...raw.planner.days[0].blocks[0], id: 'b2', start: 600, end: 630 });
  const blocked = await migration(raw); assert.equal(blocked.report.issues.some(i => i.code === 'MULTIPLE_BLOCKS' && i.blocking), true); assert.equal(blocked.data.planner.plans.length, 0);
  const explicit = await prepareMigration(blank(), source(raw), { zone: 'Asia/Shanghai', readonlyPaths: ['/planner/tasks/@t'] }, AT, 'chosen');
  assert.equal(explicit.report.issues.some(i => i.blocking), false); assert.equal(explicit.data.planner.instances.length, 0); assert.equal(legacyProjection(explicit.data).occupancy.items.length, 2);
});
test('2B C39 missing zone, dangling block, over-limit Top3 and WIP are blocked without modifying source', async () => {
  const raw = old(), before = clone(raw);
  const noZone = await prepareMigration(blank(), source(raw), { zone: null }, AT, 'no-zone'); assert.equal(noZone.report.issues.some(i => i.blocking), true); assert.deepEqual(raw, before);
  for (const mutate of [(d: Mutable) => d.planner.days[0].blocks[0].task = 'missing', (d: Mutable) => d.planner.days[0].top3 = ['t', 'done', 't', 'done'], (d: Mutable) => d.planner.refs = [1, 2, 3, 4].map(i => ({ id: String(i), name: String(i), status: 'active' }))]) {
    const damaged = clone(raw); mutate(damaged); const copy = clone(damaged); await assert.rejects(() => migration(damaged)); assert.deepEqual(damaged, copy);
  }
});
test('2B C39 same source retry is idempotent; different sources with same IDs stay separate', async () => {
  const first = await migration(old()); const replay = await migration(old(), undefined, first.data); assert.deepEqual(replay.data, first.data);
  const different = old(); different.planner.days = []; different.planner.tasks[0].title = '另一真实来源';
  const second = await prepareMigration(first.data, source(different), { zone: 'Asia/Shanghai' }, AT, 'second-migration'); assert.equal(second.report.issues.some(i => i.blocking), false); assert.equal(second.data.legacySources.length, 2);
  assert.equal(new Set(second.data.planner.definitions.map(d => d.id)).size, 2); assert.equal(new Set(second.data.planner.instances.map(i => i.id)).size, 2);
});
test('2B C23/C43 preparation is explicit, idempotent per rule/date and does not roll old days forward', () => {
  const data = clone(blank()); data.planner.definitions = [{ id: 'd', version: 2, content: content(), enabled: true, parentDefinitionId: null, source: { kind: 'manual' } }];
  data.planner.rules = [{ id: 'r', version: 1, name: '规则', definitionId: 'd', weekdays: [0, 1, 2, 3, 4, 5, 6], startDate: '2026-09-01', zone: 'Asia/Shanghai', status: 'active', source: { kind: 'manual' } }];
  let next = applyAction(data, calendarOperation(data, { date: '2026-09-28', zone: 'Asia/Shanghai', templateId: null }, false, AT, 'a'), ctx('a')).data;
  const again = applyAction(next, calendarOperation(next, { date: '2026-09-28', zone: 'Asia/Shanghai', templateId: null }, false, AT, 'b'), ctx('b')); assert.equal(again.changed, false); assert.deepEqual(again.data, next);
  const past = applyAction(next, calendarOperation(next, { date: '2026-09-27', zone: 'Asia/Shanghai', templateId: null }, false, AT, 'past'), ctx('past')).data;
  assert.equal(past.planner.instances.length, 1); assert.equal(past.planner.occurrences.length, 1);
});
test('2B C43 ordinary past plans remain editable and retain before/after history', () => {
  const data = clone(planned()); data.planner.plans[0].range = shanghai('09:00', 30, '2026-09-27');
  const next = applyAction(data, { type: 'MovePlan', plan: { id: 'p', version: 4 }, range: shanghai('10:00', 30, '2026-09-27') }, ctx('past-move')).data;
  assert.equal(next.planner.plans[0].id, 'p'); assert.deepEqual((next.planner.history[0].before as any).range, data.planner.plans[0].range); assert.deepEqual((next.planner.history[0].after as any).range, next.planner.plans[0].range);
});
test('2B C44 mixed record zones clip to the display day without rewriting their snapshots', async () => {
  const data = clone(planned()); data.planner.instances[0].currentContent = content(25); data.planner.instances[0].creationSnapshot = content(25);
  const first = { startAt: '2026-09-28T03:50:00Z', endAt: '2026-09-28T04:15:00Z', zone: 'Pacific/Kiritimati', localStart: '2026-09-28T17:50', localEnd: '2026-09-28T18:15', startOffset: '+14:00', endOffset: '+14:00' };
  data.planner.plans[0].range = first; data.planner.plans[0].contentSnapshot = content(25);
  data.planner.instances.push({ ...data.planner.instances[0], id: 'other', currentContent: content(), creationSnapshot: content() });
  data.planner.plans.push({ ...data.planner.plans[0], id: 'other-plan', instanceId: 'other', range: shanghai('11:55', 30), contentSnapshot: content() });
  validateActionData(data); const snapshot = await inspectSnapshot(envelope(data)), before = clone(snapshot.raw);
  const a = projectDay(snapshot, { date: '2026-09-27', zone: 'America/New_York' }, AT), b = projectDay(snapshot, { date: '2026-09-28', zone: 'America/New_York' }, AT);
  assert.equal(a.plans.length, 2); assert.equal(b.plans.length, 2); assert.deepEqual(a.plans[0].range, first); assert.deepEqual(b.plans[0].range, first);
  assert.equal(a.freeRanges.reduce((n, r) => n + elapsedMinutes(r), 0), 1430); assert.equal(b.freeRanges.reduce((n, r) => n + elapsedMinutes(r), 0), 1415); assert.deepEqual(snapshot.raw, before);
});
test('2B C39 explicit source ID with changed bytes is blocked and leaves the existing mapping unchanged', async () => {
  const first = await migration(old(), 'explicit-source'), changed = old(); changed.planner.tasks[0].criteria = 'different';
  const next = await prepareMigration(first.data, source(changed, 'explicit-source'), { zone: 'Asia/Shanghai' }, AT, 'changed-source');
  assert.equal(next.report.issues.some(i => i.code === 'SOURCE_CHANGED' && i.blocking), true); assert.deepEqual(next.data, first.data);
});
for (const boundary of ['backup', 'config'] as const) test(`2B-F02 C11/C16 non-grid template is rejected by the ${boundary} validator`, () => {
  const data = clone(blank()); data.planner.templates = [{ id: 'bad', version: 1, name: '非网格', weekdays: [1], source: { kind: 'manual' }, entries: [{ id: 'entry', title: '非网格', start: '09:02', elapsedMinutes: 30, definitionId: null }] }];
  const value = boundary === 'backup' ? data : { format: 'cardgrid', version: 2, kind: 'config', config: { settings: data.settings, definitions: [], templates: data.planner.templates, rules: [] } };
  const before = clone(value);
  assert.throws(() => boundary === 'backup' ? validateActionData(value) : validateDefinitionConfig(value), 'A newly persisted template must not make plannedRange/readDay fail on its grid.');
  assert.deepEqual(value, before);
});
test('2B command boundary rejects extra top-level/nested fields and direct fact replacement', () => {
  const command: any = { commandId: 'c', expected: { epoch: 'e', revision: 1 }, type: 'ReorderHand', payload: { instanceIds: [] } }; assertCommand(command);
  for (const bad of [{ ...command, data: blank() }, { ...command, expected: { ...command.expected, bypass: true } }, { ...command, payload: { instanceIds: [], facts: [] } }, { ...command, type: 'ReplaceData', payload: { data: blank() } }]) expectCode('INVALID_INPUT', () => assertCommand(bad));
  assert.equal(canonicalJson({ a: 1, b: [1, 2] }), canonicalJson({ b: [1, 2], a: 1 }));
});
