import test from 'node:test';
import assert from 'node:assert/strict';
import {harness, ok, actionCard, bookEntry, pool, rule} from './v3-fixtures.ts';
import {createWorkshopHost} from '../../../src/workspace/workshop-host.ts';
import {emptyActionData, emptyWorkspaceData, inspectEnvelope, inspectImport, exportWorkspace, parseRestore, validateActionData, validateDefinitionConfig} from '../../../src/workspace/format.ts';
import {confirmed, envelope} from '../../fixtures/action/independent.ts';

test('B3 uninitialized reads expose blank v3 without writes or seeded rules', async () => {
  const h = harness(); const first = ok(await h.client.load()), second = ok(await h.client.load());
  assert.equal(first.data?.version, 3); assert.deepEqual(first, second); assert.equal(h.writes(), 0);
  assert.deepEqual(first.data, emptyWorkspaceData());
  ok(await h.submit('CreateCapture', {text: '旧捕获入口', source: 'manual'}));
  assert.equal((h.evidence().raw as any).dataFormat, 'action-v3');
});

test('B3 workshop saves append complete version evidence and reject invalid references atomically', async () => {
  const h = harness(); await h.setup();
  const before = h.evidence();
  const result = await h.submit('SavePool', {pool: pool({version: 2, memberIds: ['reading']}), expectedVersion: 1});
  assert.equal(result.ok, false); assert.deepEqual(h.evidence(), before);
  ok(await h.submit('SaveBookEntry', {bookEntry: bookEntry({version: 2, title: '新书名'}), expectedVersion: 1}));
  const data = await h.data(), histories = data.planner.history.filter(v => v.entity.kind === 'book-entry');
  assert.equal(histories.length, 2); assert.equal((histories[1].before as any).title, '百年孤独'); assert.equal((histories[1].after as any).version, 2);
  validateActionData(data);
});

test('duplicate slot labels are rejected by saves, config and backup before an unusable copy can persist', async () => {
  const h = harness(); await h.setup(); const original = (await h.data()).actionCards[0];
  const invalid = {...original,version:2,slots:[...original.slots,{...original.slots[0],id:'another-book'}]};
  const before = h.evidence();
  assert.equal((await h.submit('SaveActionCard',{actionCard:invalid,expectedVersion:1})).ok,false);
  assert.deepEqual(h.evidence(),before);
  const data=await h.data(); data.actionCards[0]=invalid;
  assert.throws(()=>validateActionData(data),/槽位文字标签不能重复/);
  const {settings,planner,actionCards,bookEntries,pools,generationRules}=data;
  assert.throws(()=>validateDefinitionConfig({format:'cardgrid',version:3,kind:'config',config:{settings,definitions:planner.definitions,templates:planner.templates,rules:planner.rules,
    actionCards,bookEntries,pools,generationRules}}),/槽位文字标签不能重复/);
});

test('B3 save tokens, expected entity versions, frozen zone and sources prevent stale overwrite', async () => {
  const h = harness(); await h.setup();
  const stale = await h.command('SaveBookEntry', {bookEntry: bookEntry({version: 2, title: '陈旧'}), expectedVersion: 1});
  ok(await h.submit('SaveBookEntry', {bookEntry: bookEntry({version: 2, title: '新值'}), expectedVersion: 1}));
  const before = h.evidence(); assert.equal((await h.client.submit(stale) as any).code, 'REVISION_CONFLICT');
  assert.equal((await h.submit('SaveBookEntry', {bookEntry: bookEntry({version: 3, title: '覆盖'}), expectedVersion: 1}) as any).code, 'REVISION_CONFLICT');
  assert.equal((await h.submit('SaveGenerationRule', {generationRule: rule({version: 2, zone: 'UTC'}), expectedVersion: 1})).ok, false);
  assert.equal((await h.submit('SaveBookEntry', {bookEntry: bookEntry({version: 3, source: {kind: 'capture', id: 'other'}}), expectedVersion: 2})).ok, false);
  assert.deepEqual(h.evidence(), before);
});

test('B3 generation is explicit, today-only and idempotent with no hand writes', async () => {
  const h = harness(); await h.setup(); h.setNow('2026-10-06T04:00:00Z');
  const before = h.evidence(); const preview = ok(await h.client.previewGeneration({token: await h.token()}));
  assert.equal(preview.planned[0].sourceDate, '2026-10-06'); assert.deepEqual(h.evidence(), before);
  await h.generate(); await h.generate(); const data = await h.data();
  assert.equal(data.dailyCopies.length, 1); assert.equal(data.generationLedger.length, 1); assert.equal(data.planner.instances.length, 0);
});

test('B3 backfill resolves old action and schedule versions while same-day ledger keeps the old snapshot', async () => {
  const h = harness(); await h.setup(); h.setNow('2026-10-06T04:00:00Z'); await h.generate();
  ok(await h.submit('SaveActionCard', {actionCard: actionCard({version: 2, content: {...actionCard().content, title: '改后《{书名}》'}}), expectedVersion: 1}));
  ok(await h.submit('SaveGenerationRule', {generationRule: rule({version: 2, schedule: {mode: 'weekdays', weekdays: [2]}}), expectedVersion: 1}));
  ok(await h.submit('GenerateDailyCopies', {target: {ruleId: 'daily-reading', date: '2026-10-05'}}));
  const data = await h.data(); assert.deepEqual(data.dailyCopies.map(c => [c.sourceDate, c.actionCard.version, c.ruleVersion]), [['2026-10-06', 1, 1], ['2026-10-05', 1, 1]]);
  await h.generate(); assert.equal((await h.data()).dailyCopies.length, 2);
  assert.equal((await h.submit('GenerateDailyCopies', {target: {ruleId: 'daily-reading', date: '2026-10-03'}}) as any).code, 'VERSION_HISTORY_UNAVAILABLE');
});

test('B3 generation rejects future, expired and invalid dates without changing recovery or ledger', async () => {
  const h = harness(); await h.setup(); h.setNow('2026-10-10T04:00:00Z'); const before = h.evidence();
  for (const [date, code] of [['2026-10-11', 'FUTURE_DATE'], ['2026-10-03', 'DATE_OUTSIDE_RETENTION'], ['2026-02-30', 'INVALID_INPUT']]) {
    assert.equal((await h.submit('GenerateDailyCopies', {target: {ruleId: 'daily-reading', date}}) as any).code, code);
  }
  assert.deepEqual(h.evidence(), before);
});

test('B3 stopped originals or rules generate no new copies and existing copies remain intact', async () => {
  const h = harness(); await h.setup(); const copy = await h.generate();
  ok(await h.submit('SaveActionCard', {actionCard: actionCard({version: 2, status: 'paused'}), expectedVersion: 1}));
  h.setNow('2026-10-05T04:00:00Z'); await h.generate(); assert.deepEqual((await h.data()).dailyCopies[0], copy);
  assert.equal((await h.submit('GenerateDailyCopies', {target: {ruleId: 'daily-reading', date: '2026-10-05'}}) as any).code, 'ACTION_CARD_INACTIVE');
});

test('B3 combo preview is read-only; explicit random selection uses rejection sampling and then stays fixed', async () => {
  const h = harness(); await h.setup();
  for (const id of ['book-2', 'book-3']) ok(await h.submit('SaveBookEntry', {bookEntry: bookEntry({id, title: id}), expectedVersion: null}));
  ok(await h.submit('SavePool', {pool: pool({version: 2, memberIds: ['book-1', 'book-2', 'book-3']}), expectedVersion: 1}));
  const copy = await h.generate(), ref = {id: copy.id, version: copy.version}, before = h.evidence();
  h.randomValues.push(0xffffffff, 2);
  const selection = ok(await h.client.selectEntry({token: await h.token(), copy: ref, slotId: 'book', choice: {mode: 'random'}})).selection!;
  assert.equal(selection.entryId, 'book-3'); assert.equal(h.randomValues.length, 0);
  const input = {token: await h.token(), copy: ref, selections: [selection]};
  const preview = ok(await h.client.previewCombo(input)); assert.equal(preview.composedText, '阅读《book-3》');
  assert.deepEqual(ok(await h.client.previewCombo(input)), preview); assert.deepEqual(h.evidence(), before);
});

test('B3 incomplete, forged, changed and archived choices cannot create partial instances', async () => {
  const h = harness(); await h.setup(); const copy = await h.generate(), ref = {id: copy.id, version: copy.version};
  const selection = await h.selection(copy), before = h.evidence();
  assert.equal((await h.submit('AcceptDailyCopy', {copy: ref, selections: [], composedText: '阅读《》'}) as any).code, 'REQUIRED_SLOT_EMPTY');
  assert.equal((await h.submit('AcceptDailyCopy', {copy: ref, selections: [selection], composedText: '伪造文字'}) as any).code, 'INVALID_INPUT');
  assert.deepEqual(h.evidence(), before);
  ok(await h.submit('SaveBookEntry', {bookEntry: bookEntry({version: 2, title: '改名'}), expectedVersion: 1}));
  assert.equal((await h.submit('AcceptDailyCopy', {copy: ref, selections: [selection], composedText: '阅读《百年孤独》'}) as any).code, 'ENTRY_STALE');
  ok(await h.submit('SaveBookEntry', {bookEntry: bookEntry({version: 3, title: '改名', status: 'archived'}), expectedVersion: 2}));
  assert.equal((await h.submit('AcceptDailyCopy', {copy: ref, selections: [selection], composedText: '阅读《百年孤独》'}) as any).code, 'ENTRY_ARCHIVED');
  assert.equal((await h.data()).planner.instances.length, 0);
});

test('B3 deliberate repeated accept creates independent instances; request replay and lost reply do not duplicate', async () => {
  const h = harness(); await h.setup(); const copy = await h.generate(), selection = await h.selection(copy);
  const command = await h.command('AcceptDailyCopy', {copy: {id: copy.id, version: 1}, selections: [selection], composedText: '阅读《百年孤独》'});
  h.loseNextReply(); assert.equal((await h.client.submit(command) as any).code, 'STORAGE_FAILED');
  const committed = h.evidence(); assert.equal(ok(await h.client.submit(command)).replayed, true); assert.deepEqual(h.evidence(), committed);
  const second = await h.accept(); const data = await h.data();
  assert.equal(data.planner.instances.length, 2); assert.notEqual(data.planner.instances[0].id, second.id);
  assert.equal(data.dailyCopies[0].acceptedInstanceIds.length, 2); assert.equal(data.planner.instances[0].daily!.sourceDate, second.daily!.sourceDate);
  assert.equal((await h.client.submit({...command, payload: {...command.payload, composedText: 'changed'}} as any) as any).code, 'COMMAND_ID_REUSED');
});

test('B3 archive retracts unfinished plans, removes active hand and retains confirmed facts and annotations', async () => {
  const h = harness(); await h.setup(); await h.generate(); const first = await h.accept(), second = await h.accept();
  const place = async (instance: typeof first, date: string) => {
    const preview = ok(await h.client.previewPlacement({token: await h.token(), subject: {kind: 'hand', instanceId: instance.id, version: 1}, date, zone: 'Asia/Shanghai', focusMinuteOfDay: 540}));
    ok(await h.submit('CommitPlacement', {previewId: preview.previewId, candidateId: preview.candidates[0].id, acknowledgedOverlap: null}));
    return (await h.data()).planner.plans.find(p => p.instanceId === instance.id)!;
  };
  const plan1 = await place(first, '2026-10-04'); await place(second, '2026-10-10');
  const actual = ok(await h.client.previewActual({token: await h.token(), draft: {mode: 'planned', instanceId: first.id, instanceVersion: 1, planId: plan1.id, planVersion: 1,
    start: {date: '2026-10-04', time: '09:00', zone: 'Asia/Shanghai'}, end: {date: '2026-10-04', time: '09:30', zone: 'Asia/Shanghai'}}}));
  ok(await h.submit('ConfirmActual', {previewId: actual.previewId, acknowledgedOverlap: null}));
  const fact = (await h.data()).planner.facts[0]; ok(await h.submit('AppendAnnotation', {factId: fact.id, text: '保留批注'}));
  const before = await h.data(); h.setNow('2026-10-10T04:00:00Z'); ok(await h.submit('ArchiveDueCopies', {})); assert.equal((await h.data()).archiveLogs.length, 0);
  h.setNow('2026-10-11T04:00:00Z'); ok(await h.submit('ArchiveDueCopies', {})); const after = await h.data();
  assert.equal(after.dailyCopies.length, 0); assert.equal(after.archiveLogs.length, 1); assert.equal(after.generationLedger.length, 1);
  assert.deepEqual(after.planner.facts, before.planner.facts); assert.deepEqual(after.planner.annotations, before.planner.annotations);
  assert.deepEqual(after.planner.instances, before.planner.instances); assert.equal(after.planner.handOrder.length, 0);
  assert.equal(after.planner.plans.find(p => p.instanceId === first.id)!.status, 'confirmed');
  assert.equal(after.planner.plans.find(p => p.instanceId === second.id)!.status, 'retracted');
  assert.equal(after.archiveLogs[0].slotSelectionsSnapshot.length, 2);
  const forgedArchive = structuredClone(after); (forgedArchive.archiveLogs[0] as any).archivedAt = '2026-10-12T04:00:00Z';
  assert.throws(() => validateActionData(forgedArchive));
  const logs = structuredClone(after.archiveLogs); ok(await h.submit('ArchiveDueCopies', {})); assert.deepEqual((await h.data()).archiveLogs, logs);
  assert.equal((await h.submit('AcceptDailyCopy', {copy: {id: logs[0].copyId, version: 3}, selections: [], composedText: 'expired'}) as any).code, 'COPY_EXPIRED');
  const archived = h.evidence();
  assert.equal((await h.submit('ReturnWithdrawnToHand', {instance: {id: second.id, version: second.version}}) as any).code, 'COPY_EXPIRED');
  assert.deepEqual(h.evidence(), archived);
});

test('B3 aborted accept and archive preserve the whole workspace, receipt and recovery', async () => {
  const h = harness(); await h.setup(); const copy = await h.generate(), selection = await h.selection(copy);
  const accept = await h.command('AcceptDailyCopy', {copy: {id: copy.id, version: 1}, selections: [selection], composedText: '阅读《百年孤独》'});
  const before = h.evidence(); h.failNext(); assert.equal((await h.client.submit(accept) as any).code, 'STORAGE_FAILED'); assert.deepEqual(h.evidence(), before);
  ok(await h.client.submit(accept)); h.setNow('2026-10-11T04:00:00Z'); const archive = await h.command('ArchiveDueCopies', {}), active = h.evidence();
  h.failNext(); assert.equal((await h.client.submit(archive) as any).code, 'STORAGE_FAILED'); assert.deepEqual(h.evidence(), active);
  ok(await h.client.submit(archive)); assert.equal((await h.data()).archiveLogs.length, 1);
});

test('B3 strict backups reject current/history disagreement, forged snapshots and version mismatch', async () => {
  const h = harness(); await h.setup(); await h.generate(); await h.accept(); const data = await h.data();
  const pack = exportWorkspace(h.evidence().raw); assert.equal(pack.version, 3); assert.deepEqual(parseRestore(JSON.stringify(pack)).data, data);
  for (const mutate of [(d: any) => d.actionCards[0].content.title = '伪造', (d: any) => d.planner.history = d.planner.history.slice(1),
    (d: any) => d.dailyCopies[0].contentSnapshot.title = '伪造', (d: any) => d.generationLedger.push(d.generationLedger[0]),
    (d: any) => d.planner.instances[0].daily.sourceDate = '2026-10-03', (d: any) => d.dailyCopies[0].version++,
    (d: any) => d.planner.history.find((row: any) => row.type === 'AcceptDailyCopy' && row.entity.kind === 'instance').before = {},
    (d: any) => d.planner.history.find((row: any) => row.type === 'AcceptDailyCopy' && row.entity.kind === 'daily-copy').after.version++]) {
    const broken = structuredClone(data); mutate(broken); assert.throws(() => validateActionData(broken));
  }
  assert.throws(() => inspectImport({...pack, version: 2})); assert.throws(() => inspectEnvelope({...h.evidence().raw as object, dataFormat: 'action-v2'}));
  assert.throws(() => validateDefinitionConfig({format: 'cardgrid', version: 3, kind: 'config', config: {settings: data.settings, definitions: [], templates: [], rules: [], actionCards: [], bookEntries: [], pools: []}}));
});

test('B3 v2 stays v2 through reads and ordinary writes; only backed-up explicit migration upgrades it', async () => {
  const h = harness(), old = confirmed(); await h.store.atomic(() => ({write: envelope(old), result: null}));
  const before = h.evidence(); assert.equal(ok(await h.client.load()).data?.version, 2); assert.deepEqual(h.evidence(), before);
  assert.equal((await h.submit('SaveBookEntry', {bookEntry: bookEntry(), expectedVersion: null}) as any).code, 'UNSUPPORTED_VERSION');
  const preview = ok(await h.client.previewMigration({token: await h.token(), choices: {zone: null}})); assert.deepEqual(h.evidence(), before);
  assert.deepEqual(preview.upgrade, {from: 2, to: 3}); assert.equal(preview.targetSummary.facts, old.planner.facts.length);
  const prepared = ok(await h.client.prepareBackup()), backup = {token: prepared.token, dataFingerprint: prepared.dataFingerprint, fileSavedConfirmed: true as const};
  const command = await h.command('CommitMigration', {previewId: preview.previewId, backup, discardDraftsConfirmed: true});
  const result = ok(await h.client.submit(command)); assert.notEqual(result.token.epoch, before.raw && (before.raw as any).epoch);
  const data = await h.data(); assert.deepEqual(data.planner, old.planner); assert.deepEqual(data.settings, old.settings); assert.deepEqual(data.dailyCopies, []);
  assert.equal(ok(await h.client.submit(command)).replayed, true);
});

test('B3 config import uses version history, retains inventory/facts and has no hidden generation', async () => {
  const h = harness(); await h.setup(); await h.generate(); const instance = await h.accept(), before = await h.data();
  const pack = ok(await h.client.exportDefinitions()); assert.equal(pack.version, 3); const changed = structuredClone(pack) as any; changed.config.actionCards[0].content.title = '配置改名《{书名}》';
  const preview = ok(await h.client.previewDefinitions({token: await h.token(), text: JSON.stringify(changed), mode: 'merge'}));
  assert.equal(preview.workshopChanges.length, 1); const prepared = ok(await h.client.prepareBackup());
  ok(await h.submit('ImportDefinitions', {previewId: preview.previewId, mode: 'merge', backup: {token: prepared.token, dataFingerprint: prepared.dataFingerprint, fileSavedConfirmed: true}}));
  const after = await h.data(); assert.equal(after.actionCards[0].version, 2); assert.deepEqual(after.dailyCopies, before.dailyCopies);
  assert.deepEqual(after.planner.instances.find(i => i.id === instance.id), instance); assert.deepEqual(after.generationLedger, before.generationLedger);
  assert.equal(after.planner.history.filter(h => h.entity.kind === 'action-card').length, 2);
});

test('B3 production workshop adapter preserves stale drafts and retries lost response with the same command', async () => {
  const h = harness(); await h.setup(); const host = createWorkshopHost(h.client); ok(await host.load() as any);
  h.loseNextReply(); const draft = bookEntry({title: '适配器新书名'}), first = await host.saveBookEntry(draft);
  assert.equal(first.ok, false); const committed = h.evidence(); const second = await host.saveBookEntry(draft);
  assert.equal(second.ok, true); assert.deepEqual(h.evidence(), committed); if (second.ok) assert.equal(second.value.version, 2);
  const stale = bookEntry({version: 2, title: '过期修改'}); ok(await h.submit('SaveBookEntry', {bookEntry: bookEntry({version: 3, title: '其他窗口'}), expectedVersion: 2}));
  const before = h.evidence(); assert.equal((await host.saveBookEntry(stale) as any).code, 'REVISION_CONFLICT'); assert.deepEqual(h.evidence(), before);
});

test('B3 optional and absent slots accept without inventing selections', async () => {
  const h = harness(); await h.setup();
  ok(await h.submit('SaveActionCard', {actionCard: actionCard({version: 2, slots: [{id: 'book', label: '书名', poolId: 'books', required: false, valueKind: 'entry'}]}), expectedVersion: 1}));
  const copy = await h.generate(), ref = {id: copy.id, version: copy.version};
  const preview = ok(await h.client.previewCombo({token: await h.token(), copy: ref, selections: []}));
  assert.equal(preview.ready, true); assert.equal(preview.composedText, '阅读《》');
  ok(await h.submit('AcceptDailyCopy', {copy: ref, selections: [], composedText: preview.composedText}));
  const blank = harness(); await blank.setup();
  ok(await blank.submit('SaveActionCard', {actionCard: actionCard({version: 2, content: {...actionCard().content, title: '散步'}, slots: []}), expectedVersion: 1}));
  const walk = await blank.generate();
  ok(await blank.submit('AcceptDailyCopy', {copy: {id: walk.id, version: walk.version}, selections: [], composedText: '散步'}));
  assert.deepEqual((await blank.data()).planner.instances[0].daily!.slotSelections, []);
});

test('B3 source date and midnight expiry use the frozen rule zone', async () => {
  const h = harness(); h.setNow('2026-10-04T01:00:00Z');
  ok(await h.submit('SaveBookEntry', {bookEntry: bookEntry(), expectedVersion: null}));
  ok(await h.submit('SavePool', {pool: pool(), expectedVersion: null}));
  ok(await h.submit('SaveActionCard', {actionCard: actionCard(), expectedVersion: null}));
  ok(await h.submit('SaveGenerationRule', {generationRule: rule({zone: 'America/Sao_Paulo', startDate: '2026-10-03'}), expectedVersion: null}));
  const copy = await h.generate(); assert.equal(copy.sourceDate, '2026-10-03');
  h.setNow('2026-10-10T02:59:59Z'); ok(await h.submit('ArchiveDueCopies', {})); assert.equal((await h.data()).dailyCopies.length, 1);
  h.setNow('2026-10-10T03:00:00Z'); ok(await h.submit('ArchiveDueCopies', {})); assert.equal((await h.data()).archiveLogs.length, 1);
});
