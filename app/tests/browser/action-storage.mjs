// Isolated real IndexedDB regression. Never uses an existing browser profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { chromium } = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.CARDGRID_ACTION_OUTPUT || path.join(os.tmpdir(), `cardgrid-action-storage-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { noDiscovery: true, entries: [], include: ['@js-temporal/polyfill', 'jsbi'] },
  plugins: [{ name: 'isolated-test-page', configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (req.url === '/__action-test') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Isolated action storage tests</title>'); }
      else next();
    });
  } }], logLevel: 'error' });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true, ...(process.env.CARDGRID_CHROME_PATH ? { executablePath: process.env.CARDGRID_CHROME_PATH } : {}) });
  async function pageIn(context) {
    const page = await context.newPage();
    await page.goto(origin + '/__action-test');
    await page.evaluate(async () => {
      const S = await import('/src/workspace/store.ts'), C = await import('/src/workspace/commands.ts');
      const F = await import('/src/workspace/format.ts'), D = await import('/src/daily/model/domain.ts'), T = await import('/src/daily/schedule/time.ts');
      const fixture = await import('/tests/fixtures/action/seed.ts');
      const W = await import('/src/workspace/client.ts');
      const store = S.createWorkspaceStore({ name: 'cardgrid-isolated-action' });
      const service = C.createActionService(store, { now: () => '2026-09-27T01:30:00Z' });
      const client = W.createWorkspaceClient({ store, now: () => '2026-09-27T01:30:00Z' });
      globalThis.cg = { S, C, F, D, T, W, fixture, store, service, client,
        async evidence() { const prepared = await client.prepareBackup(); if (!prepared.ok) throw new Error(JSON.stringify(prepared)); return { token: prepared.value.token, dataFingerprint: prepared.value.dataFingerprint, fileSavedConfirmed: true }; },
        async seed(data) { await store.atomic(() => ({ write: { schemaVersion: 4, epoch: 'test-epoch', revision: 1, mode: 'current', dataFormat: 'action-v2', lifecycleReceipt: null, data }, result: null })); },
        async snapshot() { return { raw: await store.read(), recovery: await store.readRecovery() }; },
        async save(id, title = id) { const snap = await service.readSnapshot(); return service.submit({ commandId: id, expected: snap.token, type: 'SaveDefinition', payload: { id, expectedVersion: null, content: { ...fixture.content(), title }, enabled: true, parentDefinitionId: null } }); }
      };
    });
    return page;
  }
  async function test(name, fn) {
    const context = await browser.newContext({ timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    const started = Date.now();
    try { const detail = await fn(context); results.push({ name, status: 'pass', durationMs: Date.now() - started, detail }); console.log('PASS', name); }
    catch (error) { results.push({ name, status: 'fail', error: error.stack }); console.error('FAIL', name, error); }
    finally { await context.close(); }
  }
  await test('empty-read-no-write-and-explicit-first-command', async context => {
    const page = await pageIn(context);
    const result = await page.evaluate(async () => {
      const { service, store, save } = cg;
      const a = await service.readSnapshot(), b = await service.readSnapshot();
      const before = await store.read(), receipt = await save('first');
      return { modes: [a.mode, b.mode], tokens: [a.token, b.token], before: before ?? null, receipt, after: await store.read(), recovery: await store.readRecovery() };
    });
    assert.deepEqual(result.modes, ['uninitialized', 'uninitialized']); assert.deepEqual(result.tokens[0], result.tokens[1]); assert.equal(result.before, null);
    assert.equal(result.receipt.ok, true); assert.equal(result.after.data.planner.definitions.length, 1); assert.equal(result.recovery.length, 0);
    return { revision: result.after.revision };
  });
  await test('request-replay-and-command-id-reuse', async context => {
    const page = await pageIn(context);
    const result = await page.evaluate(async () => {
      const snap = await cg.service.readSnapshot();
      const command = { commandId: 'same', expected: snap.token, type: 'SaveDefinition', payload: { id: 'd1', expectedVersion: null, content: cg.fixture.content(), enabled: true, parentDefinitionId: null } };
      const first = await cg.service.submit(command), before = await cg.snapshot();
      const replay = await cg.service.submit(command), after = await cg.snapshot();
      const reused = await cg.service.submit({ ...command, payload: { ...command.payload, enabled: false } });
      return { first, replay, before, after, reused };
    });
    assert.equal(result.first.ok, true); assert.equal(result.replay.value.replayed, true); assert.deepEqual(result.before, result.after); assert.equal(result.reused.code, 'COMMAND_ID_REUSED');
    return { facts: result.after.raw.data.planner.facts.length, history: result.after.raw.data.planner.history.length };
  });
  await test('two-windows-confirm-once-and-replay-from-other-window', async context => {
    const a = await pageIn(context), b = await pageIn(context);
    await a.evaluate(async () => {
      const data = cg.D.applyAction(cg.F.emptyActionData(), { type: 'CreateManualInstance', instanceId: 'i1', content: cg.fixture.content(), targetDate: null }, cg.fixture.context('seed')).data;
      await cg.seed(data);
    });
    const prepare = async page => page.evaluate(async () => {
      const snap = await cg.service.readSnapshot();
      const preview = await cg.service.previewActual({ token: snap.token, draft: { mode: 'unplanned', instanceId: 'i1', instanceVersion: 1,
        start: { date: '2026-09-27', time: '09:20', zone: 'Asia/Shanghai' }, end: { date: '2026-09-27', time: '09:50', zone: 'Asia/Shanghai' } } });
      if (!preview.ok) throw new Error(JSON.stringify(preview));
      const command = { commandId: crypto.randomUUID(), expected: snap.token, type: 'ConfirmActual', payload: { previewId: preview.value.previewId, acknowledgedOverlap: null } };
      globalThis.pendingCommand = command; return command;
    });
    const commands = await Promise.all([prepare(a), prepare(b)]);
    const replies = await Promise.all([a.evaluate(() => cg.service.submit(pendingCommand)), b.evaluate(() => cg.service.submit(pendingCommand))]);
    assert.equal(replies.filter(r => r.ok).length, 1); assert.equal(replies.find(r => !r.ok).code, 'REVISION_CONFLICT');
    const winner = replies.findIndex(r => r.ok), target = winner === 0 ? b : a;
    const before = await target.evaluate(() => cg.snapshot());
    const replay = await target.evaluate(command => cg.service.submit(command), commands[winner]);
    assert.equal(replay.ok, true); assert.equal(replay.value.replayed, true);
    assert.deepEqual(await target.evaluate(() => cg.snapshot()), before);
    assert.equal(before.raw.data.planner.facts.length, 1); assert.equal(before.raw.data.planner.facts[0].confirmedAt, '2026-09-27T01:30:00Z');
    return { factId: before.raw.data.planner.facts[0].id, revision: before.raw.revision };
  });
  await test('transaction-abort-restores-workspace-and-recovery-then-retries-once', async context => {
    const page = await pageIn(context);
    const result = await page.evaluate(async () => {
      await cg.save('base'); await cg.save('second');
      const before = await cg.snapshot(), snap = await cg.service.readSnapshot();
      const command = { commandId: 'abort-request', expected: snap.token, type: 'SaveDefinition', payload: { id: 'third', expectedVersion: null, content: cg.fixture.content(), enabled: true, parentDefinitionId: null } };
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) { const request = original.apply(this, args); if (this.name === 'workspace') this.transaction.abort(); return request; };
      let failed;
      try { failed = await cg.service.submit(command); } finally { IDBObjectStore.prototype.put = original; }
      const afterFailure = await cg.snapshot(), retry = await cg.service.submit(command), afterRetry = await cg.snapshot();
      return { before, failed, afterFailure, retry, afterRetry };
    });
    assert.equal(result.failed.code, 'STORAGE_FAILED'); assert.deepEqual(result.afterFailure, result.before); assert.equal(result.retry.ok, true);
    assert.equal(result.afterRetry.raw.data.planner.definitions.length, 3); assert.equal(result.afterRetry.raw.data.commandReceipts.filter(r => r.commandId === 'abort-request').length, 1);
    return { rollback: true, retry: true };
  });
  await test('old-database-open-is-readonly-and-ordinary-submit-is-blocked', async context => {
    const page = await context.newPage(); await page.goto(origin + '/__action-test');
    const old = { schemaVersion: 1, revision: 7, config: { preferences: { theme: 'paper', density: 'comfortable', startHour: 8, endHour: 23, defaultMinutes: 15 }, categories: [], cards: [], schedules: [] } };
    await page.evaluate(async raw => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('cardgrid-isolated-action', 1); r.onupgradeneeded = () => r.result.createObjectStore('workspace'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise((resolve, reject) => { const tx = db.transaction('workspace', 'readwrite'); tx.objectStore('workspace').put(raw, 'current'); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    }, old);
    const initialized = await pageIn(context);
    const result = await initialized.evaluate(async () => ({ snap: await cg.service.readSnapshot(), save: await cg.save('blocked'), raw: await cg.store.read(), recovery: await cg.store.readRecovery() }));
    assert.equal(result.snap.mode, 'legacy-readonly'); assert.equal(result.save.code, 'LEGACY_READ_ONLY'); assert.deepEqual(result.raw, old); assert.deepEqual(result.recovery, []);
    return { oldRevision: result.raw.revision, sourcePreserved: true };
  });
  await test('stale-preview-and-untrusted-candidate-rejected-without-partial-records', async context => {
    const page = await pageIn(context);
    const result = await page.evaluate(async () => {
      const data = cg.D.applyAction(cg.F.emptyActionData(), { type: 'CreateManualInstance', instanceId: 'i1', content: cg.fixture.content(), targetDate: null }, cg.fixture.context('seed')).data;
      await cg.seed(data); const snap = await cg.service.readSnapshot();
      const preview = await cg.service.previewPlacement({ token: snap.token, subject: { kind: 'hand', instanceId: 'i1', version: 1 }, date: '2026-09-27', zone: 'Asia/Shanghai', focusMinuteOfDay: 540 });
      if (!preview.ok) throw new Error(JSON.stringify(preview));
      const command = { commandId: 'forged', expected: snap.token, type: 'CommitPlacement', payload: { previewId: preview.value.previewId, candidateId: 'forged-candidate', acknowledgedOverlap: null } };
      const before = await cg.snapshot(), rejected = await cg.service.submit(command), after = await cg.snapshot();
      const second = await cg.service.previewPlacement(preview.value.query); await cg.save('external-like');
      const stale = await cg.service.submit({ ...command, commandId: 'stale', payload: { ...command.payload, previewId: second.value.previewId, candidateId: second.value.candidates[0].id } });
      return { rejected, before, after, stale, final: await cg.snapshot() };
    });
    assert.equal(result.rejected.code, 'PREVIEW_STALE'); assert.deepEqual(result.before, result.after); assert.equal(result.stale.code, 'REVISION_CONFLICT');
    assert.equal(result.final.raw.data.planner.plans.length, 0); return { forged: 'rejected', stale: 'rejected' };
  });
  await test('exact-new-and-old-restore-then-repeated-export', async context => {
    const page = await pageIn(context);
    const result = await page.evaluate(async () => {
      await cg.save('source');
      const original = (await cg.client.prepareBackup()).value.text;
      const old = { format: 'cardgrid', version: 1, kind: 'backup', data: { config: { preferences: { theme: 'paper', density: 'comfortable', startHour: 8, endHour: 23, defaultMinutes: 15 }, categories: [], cards: [], schedules: [] }, legacyArchives: [] } };
      const evidence = await cg.evidence(), preview = await cg.client.previewRestore({ token: evidence.token, text: JSON.stringify(old) });
      const restoredOld = await cg.client.submit({ commandId: 'restore-old', expected: evidence.token, type: 'RestoreWorkspace', payload: { previewId: preview.value.previewId, backup: evidence, discardDraftsConfirmed: true } });
      const reads = [];
      for (let i = 0; i < 3; i++) { reads.push((await cg.client.load()).value.mode); const backup = await cg.client.prepareBackup(); reads.push(JSON.parse(backup.value.text)); }
      const secondEvidence = await cg.evidence(), secondPreview = await cg.client.previewRestore({ token: secondEvidence.token, text: original });
      const restoredNew = await cg.client.submit({ commandId: 'restore-new', expected: secondEvidence.token, type: 'RestoreWorkspace', payload: { previewId: secondPreview.value.previewId, backup: secondEvidence, discardDraftsConfirmed: true } });
      return { old, original: JSON.parse(original), restoredOld, restoredNew, reads, final: JSON.parse((await cg.client.prepareBackup()).value.text), recovery: await cg.store.readRecovery() };
    });
    assert.equal(result.restoredOld.ok, true); assert.equal(result.restoredNew.ok, true);
    for (let i = 0; i < 6; i += 2) { assert.equal(result.reads[i], 'legacy-readonly'); assert.deepEqual(result.reads[i + 1], result.old); }
    assert.deepEqual(result.final, result.original); assert.deepEqual(result.recovery, []); return { exact: true, reads: 6 };
  });
  await test('clear-every-recovery-key-and-replay-after-later-write-without-overwrite', async context => {
    const page = await pageIn(context), other = await pageIn(context);
    const result = await page.evaluate(async () => {
      await cg.save('before');
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('cardgrid-isolated-action', 3); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise((resolve, reject) => { const tx = db.transaction('recovery', 'readwrite'); for (const key of ['previous', 'pre-p1a', 'other-backup']) tx.objectStore('recovery').put({ secret: key }, key); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
      const backup = await cg.evidence(); const command = { commandId: 'clear-once', expected: backup.token, type: 'ClearWorkspace', payload: { backup, discardDraftsConfirmed: true } };
      const first = await cg.client.submit(command), cleared = await cg.snapshot(); await cg.save('after-clear'); const afterWrite = await cg.snapshot();
      const replay = await cg.client.submit(command), afterReplay = await cg.snapshot(); return { command, first, cleared, afterWrite, replay, afterReplay, empty: cg.F.emptyWorkspaceData() };
    });
    assert.equal(result.first.ok, true); assert.deepEqual(result.cleared.raw.data, result.empty); assert.deepEqual(result.cleared.recovery, []);
    assert.equal(result.replay.value.replayed, true); assert.deepEqual(result.afterWrite, result.afterReplay);
    const cross = await other.evaluate(command => cg.client.submit(command), result.command); assert.equal(cross.value.replayed, true);
    const stale = await other.evaluate(command => cg.client.submit({ commandId: 'stale-after-clear', expected: command.expected, type: 'ReorderHand', payload: { instanceIds: [] } }), result.command); assert.equal(stale.code, 'WORKSPACE_REPLACED');
    return { everyRecoveryKeyRemoved: true, replayKeepsLaterWrites: true, crossWindowReplay: true };
  });
  await test('lifecycle-abort-restores-epoch-data-and-all-recovery', async context => {
    const page = await pageIn(context);
    const result = await page.evaluate(async () => {
      await cg.save('a'); await cg.save('b'); const backup = await cg.evidence(), before = await cg.snapshot();
      const command = { commandId: 'failed-clear', expected: backup.token, type: 'ClearWorkspace', payload: { backup, discardDraftsConfirmed: true } };
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) { const r = original.apply(this, args); if (this.name === 'workspace') this.transaction.abort(); return r; };
      let failed; try { failed = await cg.client.submit(command); } finally { IDBObjectStore.prototype.put = original; }
      const after = await cg.snapshot(), retry = await cg.client.submit(command); return { before, failed, after, retry, final: await cg.snapshot() };
    });
    assert.equal(result.failed.code, 'STORAGE_FAILED'); assert.deepEqual(result.after, result.before); assert.equal(result.retry.ok, true); assert.deepEqual(result.final.recovery, []); return { rollback: true, retry: true };
  });
  await test('backup-evidence-and-restore-preview-expire-on-other-window-write', async context => {
    const a = await pageIn(context), b = await pageIn(context);
    await a.evaluate(async () => { await cg.save('a'); globalThis.backup = await cg.evidence(); globalThis.prepared = await cg.client.previewRestore({ token: backup.token, text: (await cg.client.prepareBackup()).value.text }); });
    await b.evaluate(() => cg.save('b'));
    const result = await a.evaluate(async () => {
      const before = await cg.snapshot(); const response = await cg.client.submit({ commandId: 'stale-restore', expected: backup.token, type: 'RestoreWorkspace', payload: { previewId: prepared.value.previewId, backup, discardDraftsConfirmed: true } });
      return { before, response, after: await cg.snapshot() };
    });
    assert.equal(result.response.code, 'REVISION_CONFLICT'); assert.deepEqual(result.after, result.before); return { staleRestoreRejected: true };
  });
  await test('migration-reports-and-commits-source-without-old-done-facts', async context => {
    const page = await pageIn(context);
    const result = await page.evaluate(async () => {
      const P = await import('/src/workspace/legacy/planner.ts'); const raw = { config: { preferences: { theme: 'paper', density: 'comfortable', startHour: 8, endHour: 23, defaultMinutes: 15 }, categories: [], cards: [], schedules: [] }, legacyArchives: [], planner: P.emptyPlanner() };
      raw.planner.tasks.push({ id: 'done', title: '旧完成', date: '2026-09-26', status: 'done', criteria: '', minimum: false, projects: [], goals: [], source: 'manual', occurrence: '', makeupOf: '' });
      await cg.store.atomic(() => ({ write: { schemaVersion: 3, revision: 4, data: raw }, result: null }));
      const backup = await cg.evidence(), before = await cg.snapshot(), preview = await cg.client.previewMigration({ token: backup.token, choices: { zone: 'Asia/Shanghai' } });
      const afterPreview = await cg.snapshot(); const response = await cg.client.submit({ commandId: 'migration', expected: backup.token, type: 'CommitMigration', payload: { previewId: preview.value.previewId, backup, discardDraftsConfirmed: true } });
      return { raw, before, afterPreview, preview, response, final: await cg.snapshot() };
    });
    assert.deepEqual(result.before, result.afterPreview); assert.equal(result.response.ok, true); assert.deepEqual(result.final.raw.data.legacySources[0].raw, result.raw); assert.equal(result.final.raw.data.planner.facts.length, 0); assert.deepEqual(result.final.recovery, []); return { migrated: true, facts: 0 };
  });
  await test('template-overlap-capability-preserves-manual-exceptions-and-ordinary-preview-input', async context => {
    const page = await pageIn(context);
    const result = await page.evaluate(async () => {
      const data = cg.F.emptyActionData(); data.settings.zone = 'Asia/Shanghai';
      data.planner.templates.push({ id: 't', version: 1, name: '重叠模板', weekdays: [], source: { kind: 'manual' }, entries: [{ id: 'a', title: 'a', start: '09:00', elapsedMinutes: 30, definitionId: null }, { id: 'b', title: 'b', start: '09:15', elapsedMinutes: 30, definitionId: null }] });
      await cg.seed(data); const token = (await cg.client.load()).value.token;
      const input = { token, date: '2026-09-27', zone: 'Asia/Shanghai', templateId: 't' };
      const preview = await cg.client.previewDayTemplate(input); if (!preview.ok) throw Error(JSON.stringify(preview));
      const rejected = await cg.client.submit({ commandId: 'without-ack', expected: token, type: 'ApplyDayTemplate', payload: { previewId: preview.value.previewId, acknowledgedOverlap: null } });
      const second = await cg.client.previewDayTemplate(input);
      const applied = await cg.client.submit({ commandId: 'with-ack', expected: token, type: 'ApplyDayTemplate', payload: { previewId: second.value.previewId, acknowledgedOverlap: second.value.acknowledgementId } });
      let snapshot = (await cg.client.load()).value; const fixed = snapshot.data.planner.fixed[0], unlock = await cg.client.unlockFixed({ token: snapshot.token, commitmentId: fixed.id, version: fixed.version });
      const cancelled = await cg.client.submit({ commandId: 'cancel-one', expected: snapshot.token, type: 'CancelFixed', payload: { commitment: { id: fixed.id, version: fixed.version }, unlockId: unlock.value } });
      snapshot = (await cg.client.load()).value; const third = await cg.client.previewDayTemplate({ ...input, token: snapshot.token });
      const reapplied = await cg.client.submit({ commandId: 'reapply', expected: snapshot.token, type: 'ApplyDayTemplate', payload: { previewId: third.value.previewId, acknowledgedOverlap: third.value.acknowledgementId } });
      return { rejected, applied, cancelled, reapplied, final: await cg.snapshot(), fixedId: fixed.id };
    });
    assert.equal(result.rejected.code, 'OVERLAP_CONFIRMATION_REQUIRED'); assert.equal(result.applied.ok, true); assert.equal(result.cancelled.ok, true); assert.equal(result.reapplied.ok, true);
    assert.equal(result.final.raw.data.planner.fixed.find(f => f.id === result.fixedId).cancelled, true); return { overlapAcknowledged: true, manualExceptionPreserved: true };
  });
  await test('actual-confirmation-storage-failure-keeps-same-command-retry-and-size-rejection-is-atomic', async context => {
    const page = await pageIn(context);
    const result = await page.evaluate(async () => {
      const data = cg.D.applyAction(cg.F.emptyActionData(), { type: 'CreateManualInstance', instanceId: 'i', content: cg.fixture.content(), targetDate: null }, cg.fixture.context('seed')).data;
      await cg.seed(data); const token = (await cg.client.load()).value.token;
      const preview = await cg.client.previewActual({ token, draft: { mode: 'unplanned', instanceId: 'i', instanceVersion: 1, start: { date: '2026-09-27', time: '09:30', zone: 'Asia/Shanghai' }, end: { date: '2026-09-27', time: '09:45', zone: 'Asia/Shanghai' } } });
      const command = { commandId: 'actual-retry', expected: token, type: 'ConfirmActual', payload: { previewId: preview.value.previewId, acknowledgedOverlap: null } }, before = await cg.snapshot();
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) { const r = original.apply(this, args); if (this.name === 'workspace') this.transaction.abort(); return r; };
      let failed; try { failed = await cg.client.submit(command); } finally { IDBObjectStore.prototype.put = original; }
      const afterFailure = await cg.snapshot(), retried = await cg.client.submit(command), confirmed = await cg.snapshot();
      const latest = (await cg.client.load()).value.token;
      const oversized = await cg.client.submit({ commandId: 'oversized', expected: latest, type: 'CreateCapture', payload: { text: '字'.repeat(2 * 1024 * 1024), source: 'size-test' } });
      return { before, failed, afterFailure, retried, confirmed, oversized, afterSize: await cg.snapshot() };
    });
    assert.equal(result.failed.code, 'STORAGE_FAILED'); assert.deepEqual(result.before, result.afterFailure); assert.equal(result.retried.ok, true);
    assert.equal(result.confirmed.raw.data.planner.facts.length, 1); assert.equal(result.oversized.code, 'DATA_TOO_LARGE'); assert.deepEqual(result.confirmed, result.afterSize); return { sameRequestRetried: true, oversizedNoWrite: true };
  });
  await test('config-replace-retires-referenced-definitions-without-changing-fact-or-instance-snapshots', async context => {
    const page = await pageIn(context);
    const result = await page.evaluate(async () => {
      let data = cg.D.applyAction(cg.F.emptyActionData(), { type: 'SaveDefinition', id: 'definition', expectedVersion: null, content: cg.fixture.content(), enabled: true, parentDefinitionId: null }, cg.fixture.context('d')).data;
      data = cg.D.applyAction(data, { type: 'AcceptDefinition', definition: { id: 'definition', version: 1 }, instanceId: 'instance', targetDate: null }, cg.fixture.context('i')).data;
      data = cg.D.applyAction(data, { type: 'ConfirmActual', instance: { id: 'instance', version: 1 }, expectedPlan: null, factId: 'fact', range: cg.fixture.range() }, cg.fixture.context('f')).data;
      await cg.seed(data); const backup = await cg.evidence();
      const pack = { format: 'cardgrid', version: 2, kind: 'config', config: { settings: data.settings, definitions: [], templates: [], rules: [] } };
      const preview = await cg.client.previewDefinitions({ token: backup.token, text: JSON.stringify(pack), mode: 'replace' });
      const before = await cg.snapshot(); const response = await cg.client.submit({ commandId: 'replace-definitions', expected: backup.token, type: 'ImportDefinitions', payload: { previewId: preview.value.previewId, mode: 'replace', backup } });
      return { before, response, preview, after: await cg.snapshot() };
    });
    assert.equal(result.response.ok, true); assert.equal(result.after.raw.data.planner.definitions[0].enabled, false);
    assert.deepEqual(result.after.raw.data.planner.instances, result.before.raw.data.planner.instances); assert.deepEqual(result.after.raw.data.planner.facts, result.before.raw.data.planner.facts); assert.equal(result.preview.value.changes.length, 1);
    return { definitionRetained: true, snapshotsUnchanged: true };
  });
} finally {
  await browser?.close(); await server.close();
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ at: new Date().toISOString(), origin, results }, null, 2));
  console.log('Evidence:', output);
}
if (results.some(r => r.status !== 'pass') || results.length === 0) process.exitCode = 1;
