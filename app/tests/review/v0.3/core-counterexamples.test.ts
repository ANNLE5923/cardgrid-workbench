import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceClient} from '../../../src/workspace/client.ts';
import {emptyActionData, validateActionData, validateDefinitionConfig, parseRestore, exportWorkspace, inspectEnvelope, inspectImport} from '../../../src/workspace/format.ts';

// Independent synthetic inputs. No author fixtures, test adapters or private data.
const content = (title = '阅读《{书名}》') => ({title, criteria: '读完一章', presetMinutes: 30, color: '#447755', categoryId: null,
  categoryLabel: null, minimum: false, projectIds: [], goalIds: [], projectLabels: [], goalLabels: []});
const original = (slots = true) => ({id: 'ind-action', version: 1, kind: 'action', content: content(slots ? undefined : '散步'),
  slots: slots ? [{id: 'title-slot', label: '书名', poolId: 'ind-books', required: true, valueKind: 'entry'}] : [],
  status: 'active', parentId: null, source: {kind: 'manual'}});
const book = (id = 'ind-book', title = '独立测试书') => ({id, title, version: 1, kind: 'book', author: null, status: 'active', source: {kind: 'manual'}});
const pool = () => ({id: 'ind-books', version: 1, name: '独立书池', poolKind: 'book', parentPoolId: null, memberIds: ['ind-book'], source: {kind: 'manual'}});
const rule = (zone = 'Asia/Shanghai') => ({id: 'ind-rule', version: 1, name: '每天阅读', actionCardId: 'ind-action',
  schedule: {mode: 'daily'}, startDate: '2026-10-03', zone, status: 'active', source: {kind: 'manual'}});
const ok = (r: any) => {assert.equal(r.ok, true, JSON.stringify(r)); return r.value;};
function h(seed?: any) {
  let raw = structuredClone(seed), at = '2026-10-03T03:00:00Z', seq = 0, writeCount = 0, abort = false, loseReply = false;
  let recovery: any[] = [];
  const listeners = new Set<any>();
  const store: any = {
    read: async () => structuredClone(raw), readRecovery: async () => structuredClone(recovery),
    async atomic(reduce: any) {
      const change = reduce(structuredClone(raw));
      if (abort) {abort = false; throw new Error('independent synthetic abort before commit');}
      if (Object.hasOwn(change, 'write')) {
        if (change.clearRecovery) recovery = [];
        else if (raw !== undefined) recovery = [{key: 'previous', value: structuredClone(raw)}];
        raw = structuredClone(change.write); writeCount++;
        for (const fn of listeners) fn(false);
        if (loseReply) {loseReply = false; throw new Error('independent transport loss after commit');}
      }
      return change.result;
    }, subscribe(fn: any) {listeners.add(fn); return () => listeners.delete(fn);}, close() {listeners.clear();},
  };
  const client = createWorkspaceClient({store, now: () => at, id: () => `ind-${++seq}`, random: () => 0});
  const token = async () => ok(await client.load()).token;
  const command = async (type: any, payload: any, commandId = `ind-command-${++seq}`) => ({type, payload, commandId, expected: await token()});
  const send = async (type: any, payload: any) => client.submit(await command(type, payload));
  const data = async () => ok(await client.load()).data;
  const evidence = () => structuredClone({raw, recovery, writeCount});
  const generate = async (target: any = 'current') => {ok(await send('GenerateDailyCopies', {target})); return (await data()).dailyCopies.at(-1);};
  const pick = async (copy: any) => ok(await client.selectEntry({token: await token(), copy: {id: copy.id, version: copy.version},
    slotId: 'title-slot', choice: {mode: 'manual', entryId: 'ind-book'}})).selection;
  const acceptCommand = async (input?: any) => {
    const copy = input ?? (await data()).dailyCopies[0], selections = copy.slotSpecSnapshot.length ? [await pick(copy)] : [];
    const preview = ok(await client.previewCombo({token: await token(), copy: {id: copy.id, version: copy.version}, selections}));
    return command('AcceptDailyCopy', {copy: {id: copy.id, version: copy.version}, selections, composedText: preview.composedText});
  };
  const accept = async (input?: any) => {const result = ok(await client.submit(await acceptCommand(input))); return (await data()).planner.instances.find((i: any) => i.id === result.resultRefs[0].id);};
  const setup = async (slots = true, zone = 'Asia/Shanghai') => {
    if (slots) {ok(await send('SaveBookEntry', {bookEntry: book(), expectedVersion: null})); ok(await send('SavePool', {pool: pool(), expectedVersion: null}));}
    ok(await send('SaveActionCard', {actionCard: original(slots), expectedVersion: null}));
    ok(await send('SaveGenerationRule', {generationRule: rule(zone), expectedVersion: null}));
  };
  return {client, token, command, send, data, generate, acceptCommand, accept, setup, pick, evidence,
    now(value: string) {at = value;}, abort() {abort = true;}, lose() {loseReply = true;}};
}

test('N-V03-01 reads and all previews leave blank and populated persistence untouched', async () => {
  const s = h(); const blank = s.evidence();
  ok(await s.client.load()); ok(await s.client.readWorkshop({token: await s.token()})); ok(await s.client.readInventory({token: await s.token()}));
  ok(await s.client.previewGeneration({token: await s.token()})); assert.deepEqual(s.evidence(), blank);
  await s.setup(); const copy = await s.generate(), before = s.evidence();
  const selection = await s.pick(copy);
  ok(await s.client.previewCombo({token: await s.token(), copy: {id: copy.id, version: 1}, selections: [selection]}));
  assert.deepEqual(s.evidence(), before); assert.deepEqual((await s.data()).planner.handOrder, []);
});
test('N-V03-02 D+6 last local minute is retained and D+7 local midnight archives exactly once', async () => {
  const s = h(); await s.setup(); const copy = await s.generate(); await s.accept();
  s.now('2026-10-09T15:59:59.999Z'); ok(await s.send('ArchiveDueCopies', {}));
  assert.equal((await s.data()).dailyCopies[0].id, copy.id); assert.equal((await s.data()).archiveLogs.length, 0);
  s.now('2026-10-09T16:00:00Z'); ok(await s.send('ArchiveDueCopies', {}));
  const first = await s.data(); assert.deepEqual(first.dailyCopies, []); assert.equal(first.archiveLogs.length, 1); assert.deepEqual(first.planner.handOrder, []);
  ok(await s.send('ArchiveDueCopies', {})); assert.deepEqual((await s.data()).archiveLogs, first.archiveLogs);
  const rejected = await s.send('GenerateDailyCopies', {target: {ruleId: 'ind-rule', date: '2026-10-03'}});
  assert.equal((rejected as any).code, 'DATE_OUTSIDE_RETENTION');
});
test('N-V03-03 seven unique dates produce seven hand instances then expire only the first date', async () => {
  const s = h(); await s.setup(false);
  for (let day = 3; day <= 9; day++) {s.now(`2026-10-${String(day).padStart(2, '0')}T03:00:00Z`); await s.generate(); await s.accept((await s.data()).dailyCopies.at(-1));}
  assert.equal((await s.data()).planner.handOrder.length, 7);
  s.now('2026-10-10T03:00:00Z'); ok(await s.send('ArchiveDueCopies', {})); await s.generate(); await s.accept((await s.data()).dailyCopies.at(-1));
  const after = await s.data(); assert.equal(after.planner.handOrder.length, 7); assert.equal(after.dailyCopies.length, 7);
  assert.equal(after.archiveLogs[0].sourceDate, '2026-10-03'); assert.equal(after.planner.instances.length, 8);
});
test('N-V03-04 distinct intentional accepts remain independent; lost-reply retry replays one instance even after archive', async () => {
  const s = h(); await s.setup(); await s.generate(); const a = await s.accept();
  const cmd = await s.acceptCommand(); s.lose(); assert.equal((await s.client.submit(cmd) as any).code, 'STORAGE_FAILED');
  const retry = ok(await s.client.submit(cmd)); assert.equal(retry.replayed, true);
  const after = await s.data(); assert.equal(after.planner.instances.length, 2); assert.notEqual(a.id, after.planner.instances[1].id);
  assert.equal(after.dailyCopies.length, 1); assert.deepEqual(after.planner.instances.map((i: any) => i.daily.sourceDate), ['2026-10-03', '2026-10-03']);
  s.now('2026-10-10T03:00:00Z'); ok(await s.send('ArchiveDueCopies', {}));
  assert.equal(ok(await s.client.submit(cmd)).replayed, true); assert.equal((await s.data()).planner.instances.length, 2);
  assert.equal((await s.client.submit({...cmd, payload: {...cmd.payload, composedText: 'different'}}) as any).code, 'COMMAND_ID_REUSED');
});
test('N-V03-05 stale parallel accept refuses a different command then succeeds only after reloading copy version', async () => {
  const s = h(); await s.setup(); await s.generate(); const one = await s.acceptCommand(), two = await s.acceptCommand();
  ok(await s.client.submit(one)); const before = s.evidence();
  assert.equal((await s.client.submit(two) as any).code, 'REVISION_CONFLICT'); assert.deepEqual(s.evidence(), before);
  ok(await s.client.submit(await s.acceptCommand())); assert.equal((await s.data()).planner.instances.length, 2);
});
test('N-V03-06 expired candidate is refused even before archive coordinator runs', async () => {
  const s = h(); await s.setup(); await s.generate(); const cmd = await s.acceptCommand(), before = s.evidence();
  s.now('2026-10-09T16:00:00Z'); assert.equal((await s.client.submit(cmd) as any).code, 'COPY_EXPIRED'); assert.deepEqual(s.evidence(), before);
});
test('N-V03-07 archive abort preserves logs, plans, hands, facts, receipt and recovery; success retains facts and annotations', async () => {
  const s = h(); await s.setup(false); await s.generate(); const planned = await s.accept(), done = await s.accept();
  const preview = ok(await s.client.previewPlacement({token: await s.token(), subject: {kind: 'hand', instanceId: planned.id, version: 1}, date: '2026-10-09', zone: 'Asia/Shanghai', focusMinuteOfDay: 540}));
  ok(await s.send('CommitPlacement', {previewId: preview.previewId, candidateId: preview.candidates[0].id, acknowledgedOverlap: null}));
  const actual = ok(await s.client.previewActual({token: await s.token(), draft: {mode: 'unplanned', instanceId: done.id, instanceVersion: 1,
    start: {date: '2026-10-03', time: '08:03', zone: 'Asia/Shanghai'}, end: {date: '2026-10-03', time: '08:34', zone: 'Asia/Shanghai'}}}));
  ok(await s.send('ConfirmActual', {previewId: actual.previewId, acknowledgedOverlap: null}));
  ok(await s.send('AppendAnnotation', {factId: (await s.data()).planner.facts[0].id, text: '独立保留批注'}));
  s.now('2026-10-10T03:00:00Z'); const cmd = await s.command('ArchiveDueCopies', {}), before = s.evidence();
  s.abort(); assert.equal((await s.client.submit(cmd) as any).code, 'STORAGE_FAILED'); assert.deepEqual(s.evidence(), before);
  ok(await s.client.submit(cmd)); const after = await s.data();
  assert.equal(after.planner.plans[0].status, 'retracted'); assert.deepEqual(after.planner.handOrder, []);
  assert.deepEqual(after.planner.facts, before.raw.data.planner.facts); assert.deepEqual(after.planner.annotations, before.raw.data.planner.annotations);
  assert.deepEqual(after.planner.instances, before.raw.data.planner.instances);
  assert.equal((await s.send('ReturnWithdrawnToHand', {instance: {id: planned.id, version: planned.version}}) as any).code, 'COPY_EXPIRED');
});
test('N-V03-08 manual history selects prior saved day version, never current content or future creation', async () => {
  const s = h(); await s.setup(false); s.now('2026-10-04T03:00:00Z');
  const card = (await s.data()).actionCards[0]; ok(await s.send('SaveActionCard', {actionCard: {...card, version: 2, content: content('新标题')}, expectedVersion: 1}));
  s.now('2026-10-06T03:00:00Z'); const old = await s.generate({ruleId: 'ind-rule', date: '2026-10-03'});
  assert.equal(old.actionCard.version, 1); assert.equal(old.contentSnapshot.title, '散步');
  const revised = await s.generate({ruleId: 'ind-rule', date: '2026-10-04'}); assert.equal(revised.actionCard.version, 2); assert.equal(revised.contentSnapshot.title, '新标题');
  const before = s.evidence(); assert.equal((await s.send('GenerateDailyCopies', {target: {ruleId: 'ind-rule', date: '2026-10-02'}}) as any).code, 'VERSION_HISTORY_UNAVAILABLE');
  assert.deepEqual(s.evidence(), before);
});
test('N-V03-09 same timestamp later edits do not invalidate generated snapshots; manual re-request does not mutate prior copy', async () => {
  const s = h(); await s.setup(false); const copy = await s.generate();
  const card = (await s.data()).actionCards[0]; ok(await s.send('SaveActionCard', {actionCard: {...card, version: 2, content: content('同毫秒后改')}, expectedVersion: 1}));
  ok(await s.send('GenerateDailyCopies', {target: {ruleId: 'ind-rule', date: '2026-10-03'}}));
  const state = await s.data(); assert.deepEqual(state.dailyCopies, [copy]); validateActionData(state);
});
test('N-V03-10 startup generation never backfills misses, and days use frozen zone rather than UTC or browsing', async () => {
  const s = h(); await s.setup(false); s.now('2026-10-06T16:00:00Z'); await s.generate();
  assert.deepEqual((await s.data()).dailyCopies.map((c: any) => c.sourceDate), ['2026-10-07']);
  ok(await s.client.readDay({date: '2026-10-01', zone: 'America/Los_Angeles'}));
  assert.equal((await s.data()).dailyCopies.length, 1);
});
test('N-V03-11 DST fallback still archives by calendar date at the seventh local midnight', async () => {
  const s = h(); s.now('2026-10-28T16:00:00Z'); await s.setup(false, 'America/New_York'); const copy = await s.generate();
  s.now('2026-11-04T04:59:59Z'); ok(await s.send('ArchiveDueCopies', {})); assert.equal((await s.data()).dailyCopies[0].id, copy.id);
  s.now('2026-11-04T05:00:00Z'); ok(await s.send('ArchiveDueCopies', {})); assert.equal((await s.data()).dailyCopies.length, 0);
});
test('N-V03-12 disabled or version-changed choices never resample or silently accept, arbitrary composed text is refused', async () => {
  const s = h(); await s.setup(); const copy = await s.generate(), selection = await s.pick(copy);
  const before = s.evidence(); assert.equal((await s.send('AcceptDailyCopy', {copy: {id: copy.id, version: 1}, selections: [selection], composedText: '任意伪造'}) as any).code, 'INVALID_INPUT'); assert.deepEqual(s.evidence(), before);
  const current = (await s.data()).bookEntries[0]; ok(await s.send('SaveBookEntry', {bookEntry: {...current, version: 2, title: '改名'}, expectedVersion: 1}));
  assert.equal((await s.send('AcceptDailyCopy', {copy: {id: copy.id, version: 1}, selections: [selection], composedText: '阅读《独立测试书》'}) as any).code, 'ENTRY_STALE');
  ok(await s.send('SaveBookEntry', {bookEntry: {...current, version: 3, title: '改名', status: 'archived'}, expectedVersion: 2}));
  assert.equal((await s.send('AcceptDailyCopy', {copy: {id: copy.id, version: 1}, selections: [selection], composedText: '阅读《独立测试书》'}) as any).code, 'ENTRY_ARCHIVED');
  assert.equal((await s.data()).planner.instances.length, 0);
});
test('N-V03-13 concrete titles with braces compose once and optional slots can be left empty', async () => {
  const s = h(); await s.setup(); const b = (await s.data()).bookEntries[0];
  ok(await s.send('SaveBookEntry', {bookEntry: {...b, version: 2, title: '{书名}'}, expectedVersion: 1})); await s.generate();
  const accepted = await s.accept(); assert.equal(accepted.creationSnapshot.title, '阅读《{书名}》');
  const t = h(); await t.setup(); const c = (await t.data()).actionCards[0];
  ok(await t.send('SaveActionCard', {actionCard: {...c, version: 2, slots: [{...c.slots[0], required: false}]}, expectedVersion: 1})); const copy = await t.generate();
  ok(await t.send('AcceptDailyCopy', {copy: {id: copy.id, version: 1}, selections: [], composedText: '阅读《》'}));
  assert.deepEqual((await t.data()).planner.instances[0].daily.slotSelections, []);
});
test('N-V03-14 backup rejects identity/history/archive tampering while valid backup roundtrips exactly', async () => {
  const s = h(); await s.setup(); await s.generate(); await s.accept(); const state = await s.data();
  assert.deepEqual(parseRestore(JSON.stringify(exportWorkspace(s.evidence().raw))).data, state);
  const corruptions = [
    (d: any) => d.dailyCopies[0].ruleVersion++,
    (d: any) => d.dailyCopies[0].slotSpecSnapshot[0].required = false,
    (d: any) => d.generationLedger[0].copyId = 'missing-copy',
    (d: any) => d.planner.instances[0].daily.slotSelections[0].entrySnapshot.title = 'forged',
    (d: any) => d.planner.history.find((x: any) => x.type === 'GenerateDailyCopies').at = '2026-10-02T03:00:00Z',
    (d: any) => d.planner.history.find((x: any) => x.entity.kind === 'book-entry').after.version = 2,
  ];
  for (const mutate of corruptions) {const broken = structuredClone(state); mutate(broken); assert.throws(() => validateActionData(broken));}
  assert.throws(() => inspectEnvelope({...s.evidence().raw, dataFormat: 'action-v2'}));
  assert.throws(() => inspectImport({...exportWorkspace(s.evidence().raw), version: 99}));
});
test('N-V03-15 config and backup both reject invalid new references, mixed pool kinds and hierarchy cycles', async () => {
  const s = h(); await s.setup(); const baseline = await s.data();
  for (const mutate of [
    (d: any) => d.actionCards[0].slots[0].poolId = 'absent-pool',
    (d: any) => d.pools[0].memberIds = ['ind-action'],
    (d: any) => d.pools[0].parentPoolId = d.pools[0].id,
    (d: any) => d.generationRules[0].actionCardId = 'missing-action',
    (d: any) => d.actionCards[0].content.presetMinutes = 7,
  ]) {
    const d = structuredClone(baseline); mutate(d); assert.throws(() => validateActionData(d));
    assert.throws(() => validateDefinitionConfig({format: 'cardgrid', version: 3, kind: 'config', config: {settings: d.settings,
      definitions: [], templates: [], rules: [], actionCards: d.actionCards, bookEntries: d.bookEntries, pools: d.pools, generationRules: d.generationRules}}));
  }
});
test('N-V03-16 restored v2 remains unchanged on reads and normal writes; upgrade requires backup and preserves old data', async () => {
  const old = emptyActionData(), seed = {schemaVersion: 4, epoch: 'ind-old-epoch', revision: 3, mode: 'current', dataFormat: 'action-v2', data: old, lifecycleReceipt: null};
  const s = h(seed), before = s.evidence(); ok(await s.client.load()); assert.deepEqual(s.evidence(), before);
  assert.equal((await s.send('SaveBookEntry', {bookEntry: book(), expectedVersion: null}) as any).code, 'UNSUPPORTED_VERSION');
  ok(await s.send('CreateCapture', {text: 'v2 合成捕获', source: 'manual'})); const v2 = await s.data(); assert.equal(v2.version, 2);
  const preview = ok(await s.client.previewMigration({token: await s.token(), choices: {zone: null}})), staged = s.evidence();
  assert.equal((await s.send('CommitMigration', {previewId: preview.previewId, backup: {token: await s.token(), dataFingerprint: 'missing', fileSavedConfirmed: true}, discardDraftsConfirmed: true}) as any).code, 'BACKUP_REQUIRED');
  assert.deepEqual(s.evidence(), staged);
  const prepared = ok(await s.client.prepareBackup()), cmd = await s.command('CommitMigration', {previewId: preview.previewId,
    backup: {token: prepared.token, dataFingerprint: prepared.dataFingerprint, fileSavedConfirmed: true}, discardDraftsConfirmed: true});
  ok(await s.client.submit(cmd)); const v3 = await s.data(); assert.equal(v3.version, 3); assert.deepEqual(v3.planner, v2.planner); assert.deepEqual(v3.settings, v2.settings);
  for (const key of ['actionCards', 'bookEntries', 'pools', 'generationRules', 'dailyCopies', 'archiveLogs', 'generationLedger']) assert.deepEqual(v3[key], []);
  assert.equal(ok(await s.client.submit(cmd)).replayed, true);
});
test('N-V03-17 ambiguous duplicate slot labels must be refused before saving unusable daily candidates', async () => {
  const s = h(); await s.setup(); const card = (await s.data()).actionCards[0], before = s.evidence();
  const result = await s.send('SaveActionCard', {actionCard: {...card, version: 2,
    slots: [card.slots[0], {...card.slots[0], id: 'another-slot'}]}, expectedVersion: 1});
  if (result.ok) {
    const copy = await s.generate(); const preview = await s.client.previewCombo({token: await s.token(), copy: {id: copy.id, version: 1}, selections: []});
    assert.fail(`SaveActionCard accepted ambiguous labels, generated copy ${copy.id}; every preview fails: ${JSON.stringify(preview)}`);
  }
  assert.equal(result.code, 'INVALID_INPUT'); assert.deepEqual(s.evidence(), before);
});
