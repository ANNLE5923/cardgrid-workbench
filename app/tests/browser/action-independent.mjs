// 2B independent Host/real-IDB checks. Fresh browser contexts and a dedicated DB only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.env.CARDGRID_2B_OUTPUT || path.join(os.tmpdir(), `cardgrid-2b-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const { chromium } = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { noDiscovery: true, entries: [], include: ['@js-temporal/polyfill', 'jsbi'] },
  plugins: [{ name: '2b-isolated-page', configureServer(vite) { vite.middlewares.use((req, res, next) => {
    if (req.url === '/__2b') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>2B isolated contract regression</title>'); } else next();
  }); } }] });
let browser;
const results = [];
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CARDGRID_CHROME_PATH ? { executablePath: process.env.CARDGRID_CHROME_PATH } : {}) });
  async function pageIn(context) {
    const page = await context.newPage(); await page.goto(origin + '/__2b');
    await page.evaluate(async () => {
      const { createWorkspaceStore } = await import('/src/workspace/store.ts');
      const { createWorkspaceClient } = await import('/src/workspace/client.ts');
      const fx = await import('/tests/fixtures/action/independent.ts');
      const dbName = 'cardgrid-isolated-2b';
      const store = createWorkspaceStore({ name: dbName });
      const client = createWorkspaceClient({ store, now: () => fx.AT });
      const value = result => { if (!result.ok) throw Error(JSON.stringify(result)); return result.value; };
      const token = async () => value(await client.load()).token;
      globalThis.tb = { fx, store, client, dbName, value, token,
        async seed(raw = fx.envelope(fx.hand())) { await store.atomic(() => ({ write: raw, result: null })); },
        async state() { return { raw: (await store.read()) ?? null, recovery: await store.readRecovery() }; },
        async evidence() { const p = value(await client.prepareBackup()); return { token: p.token, dataFingerprint: p.dataFingerprint, fileSavedConfirmed: true }; },
        async submit(type, payload, commandId = crypto.randomUUID(), expected) { return client.submit({ commandId, expected: expected ?? await token(), type, payload }); },
        async recoveryKeys() {
          const db = await new Promise((resolve, reject) => { const r = indexedDB.open(dbName, 3); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
          try { await new Promise((resolve, reject) => { const tx = db.transaction('recovery', 'readwrite'); for (const k of ['previous', 'pre-p1a', 'arbitrary']) tx.objectStore('recovery').put({ secret: k }, k); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); } finally { db.close(); }
        },
        async placement(subject = { kind: 'hand', instanceId: 'i', version: 7 }, minute = 540) {
          return value(await client.previewPlacement({ token: await token(), subject, date: '2026-09-28', zone: 'Asia/Shanghai', focusMinuteOfDay: minute }));
        },
        async actual() { return value(await client.previewActual({ token: await token(), draft: { mode: 'unplanned', instanceId: 'i', instanceVersion: 7, start: { date: '2026-09-28', time: '10:00', zone: 'Asia/Shanghai' }, end: { date: '2026-09-28', time: '10:31', zone: 'Asia/Shanghai' } } })); }
      };
    }); return page;
  }
  async function check(name, run) {
    const context = await browser.newContext({ timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    try { const detail = await run(context); results.push({ name, status: 'pass', detail }); console.log('PASS', name); }
    catch (error) { results.push({ name, status: 'fail', error: error.stack }); console.error('FAIL', name, error); }
    finally { await context.close(); }
  }

  await check('C01/C19/C34 read-catalog-suggest-preview-cancel-do-not-write', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      const data = tb.fx.hand(); data.planner.definitions = [
        { id: 'eligible', version: 8, content: tb.fx.content(), enabled: true, parentDefinitionId: null, source: { kind: 'manual' } },
        { id: 'disabled', version: 1, content: tb.fx.content(), enabled: false, parentDefinitionId: null, source: { kind: 'manual' } }
      ]; await tb.seed(tb.fx.envelope(data)); const before = await tb.state();
      const picks = []; for (let i = 0; i < 12; i++) picks.push(tb.value(await tb.client.suggest({ token: await tb.token() })).definition.id);
      const filtered = await tb.client.suggest({ token: await tb.token(), categoryId: 'absent' });
      await tb.client.readCatalog(); await tb.client.readDay({ date: '2026-09-28', zone: 'America/New_York' });
      const preview = await tb.placement(); tb.client.cancelPreview(preview.previewId); const after = await tb.state();
      const refused = await tb.submit('CommitPlacement', { previewId: preview.previewId, candidateId: preview.candidates[0].id, acknowledgedOverlap: null });
      return { before, after, picks, filtered, refused, final: await tb.state() };
    });
    assert.deepEqual(r.before, r.after); assert.deepEqual(r.after, r.final); assert.equal(r.refused.code, 'PREVIEW_STALE'); assert.deepEqual(new Set(r.picks), new Set(['eligible'])); assert.equal(r.filtered.value.definition, null);
    return { readsAndPreviewsWriteFree: true, draws: 12 };
  });

  await check('C02/C03/C04/C07 full-duration-touching-overlap-and-cross-preview-ack', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      await tb.seed(tb.fx.envelope(tb.fx.fixed())); const before = await tb.state();
      const touching = await tb.placement(undefined, 525); // 08:45-09:15, touching x only.
      const a = await tb.placement(undefined, 540), b = await tb.placement(undefined, 545);
      const wrongAck = await tb.submit('CommitPlacement', { previewId: b.previewId, candidateId: b.candidates[0].id, acknowledgedOverlap: a.candidates[0].acknowledgementId });
      const afterWrong = await tb.state(); const evening = await tb.placement(undefined, 1265);
      const saved = await tb.submit('CommitPlacement', { previewId: evening.previewId, candidateId: evening.candidates[0].id, acknowledgedOverlap: null });
      return { before, touching, a, wrongAck, afterWrong, evening, saved, final: await tb.state() };
    });
    assert.equal(r.touching.candidates[0].state, 'valid'); assert.equal(r.a.candidates[0].state, 'conflict'); assert.equal(r.a.candidates[0].blockers[0].overlap.endAt, '2026-09-28T01:30:00Z');
    assert.equal(r.a.candidates[0].units, 6); assert.equal(r.wrongAck.ok, false); assert.deepEqual(r.afterWrong, r.before);
    assert.equal(r.evening.candidates.length, 1); assert.equal(r.evening.candidates[0].half, 1); assert.equal(r.saved.ok, true); assert.equal(r.final.raw.data.planner.plans[0].range.localStart, '2026-09-28T21:05'); assert.deepEqual(r.final.raw.data.planner.fixed, r.before.raw.data.planner.fixed);
    return { completeDuration: 30, oldAckRefused: true, oneAbsoluteLanding: true };
  });

  await check('C08/C40 real-two-window-confirm-and-response-loss-replay-after-reopen', async context => {
    const a = await pageIn(context), b = await pageIn(context); await a.evaluate(() => tb.seed());
    const prepare = page => page.evaluate(async () => { const p = await tb.actual(); return { commandId: crypto.randomUUID(), expected: p.token, type: 'ConfirmActual', payload: { previewId: p.previewId, acknowledgedOverlap: null } }; });
    const commands = await Promise.all([prepare(a), prepare(b)]);
    const replies = await Promise.all([a.evaluate(c => tb.client.submit(c), commands[0]), b.evaluate(c => tb.client.submit(c), commands[1])]);
    assert.equal(replies.filter(r => r.ok).length, 1); assert.equal(replies.find(r => !r.ok).code, 'REVISION_CONFLICT');
    const before = await a.evaluate(() => tb.state()), winner = commands[replies.findIndex(r => r.ok)];
    const reopened = await pageIn(context), replay = await reopened.evaluate(c => tb.client.submit(c), winner);
    assert.equal(replay.value.replayed, true); assert.deepEqual(await reopened.evaluate(() => tb.state()), before); assert.equal(before.raw.data.planner.facts.length, 1); assert.equal(before.raw.data.planner.history.length, 1);
    const reused = await reopened.evaluate(c => tb.client.submit({ ...c, payload: { ...c.payload, acknowledgedOverlap: 'different' } }), winner); assert.equal(reused.code, 'COMMAND_ID_REUSED');
    return { singleFact: true, replayAfterReopen: true, singleHistory: true };
  });

  await check('C42 fixed-unlock-is-object-version-token-bound-and-navigation-cancel-invalidates', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      await tb.seed(tb.fx.envelope(tb.fx.fixed())); const before = await tb.state();
      const unlock = tb.value(await tb.client.unlockFixed({ token: await tb.token(), commitmentId: 'x', version: 3 }));
      const unrelated = await tb.submit('CancelFixed', { commitment: { id: 'y', version: 2 }, unlockId: unlock });
      const again = tb.value(await tb.client.unlockFixed({ token: await tb.token(), commitmentId: 'x', version: 3 }));
      const p = await tb.placement({ kind: 'fixed', commitmentId: 'x', version: 3, unlockId: again }, 600); tb.client.cancelPreview(p.previewId);
      const cancelled = await tb.submit('CancelFixed', { commitment: { id: 'x', version: 3 }, unlockId: again });
      const third = tb.value(await tb.client.unlockFixed({ token: await tb.token(), commitmentId: 'x', version: 3 })); tb.client.invalidateCapabilities();
      const navigated = await tb.submit('CancelFixed', { commitment: { id: 'x', version: 3 }, unlockId: third });
      return { before, unrelated, cancelled, navigated, after: await tb.state() };
    });
    for (const response of [r.unrelated, r.cancelled, r.navigated]) assert.equal(response.code, 'FIXED_LOCKED'); assert.deepEqual(r.before, r.after);
    return { wrongObjectRejected: true, cancelInvalidates: true, navigationInvalidates: true };
  });

  await check('C16/C40 storage-aborts-before-after-each-put-have-no-notification-or-partial-receipt', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      const outcomes = [];
      for (const location of ['recovery', 'workspace']) for (const mode of ['throw', 'abort']) {
        await tb.seed(); const preview = await tb.actual(), before = await tb.state();
        const command = { commandId: `${location}-${mode}`, expected: preview.token, type: 'ConfirmActual', payload: { previewId: preview.previewId, acknowledgedOverlap: null } };
        let notifications = 0; const unsubscribe = tb.client.subscribe(() => notifications++), original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(...args) { if (this.name === location) { if (mode === 'throw') throw new DOMException('injected quota', 'QuotaExceededError'); const r = original.apply(this, args); this.transaction.abort(); return r; } return original.apply(this, args); };
        let failed; try { failed = await tb.client.submit(command); } finally { IDBObjectStore.prototype.put = original; unsubscribe(); }
        const after = await tb.state(), retried = await tb.client.submit(command), final = await tb.state(); outcomes.push({ location, mode, before, failed, after, retried, final, notifications });
      } return outcomes;
    });
    for (const o of r) { assert.equal(o.failed.code, 'STORAGE_FAILED'); assert.deepEqual(o.before, o.after); assert.equal(o.notifications, 0); assert.equal(o.retried.ok, true); assert.equal(o.final.raw.data.planner.facts.length, 1); assert.equal(o.final.raw.data.commandReceipts.length, 1); }
    return { faultSites: r.length, atomicRetry: true, noFailureNotification: true };
  });

  await check('C27/C42 fixed-storage-failure-consumes-unlock-requires-new-preview', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      await tb.seed(tb.fx.envelope(tb.fx.fixed())); const unlock = tb.value(await tb.client.unlockFixed({ token: await tb.token(), commitmentId: 'x', version: 3 }));
      const p = await tb.placement({ kind: 'fixed', commitmentId: 'x', version: 3, unlockId: unlock }, 660);
      const command = { commandId: 'fixed-retry', expected: p.token, type: 'CommitPlacement', payload: { previewId: p.previewId, candidateId: p.candidates[0].id, acknowledgedOverlap: null } }, before = await tb.state();
      const original = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(...args) { const r = original.apply(this, args); if (this.name === 'workspace') this.transaction.abort(); return r; };
      let failed; try { failed = await tb.client.submit(command); } finally { IDBObjectStore.prototype.put = original; }
      const after = await tb.state(), oldRetry = await tb.client.submit(command);
      const freshUnlock = tb.value(await tb.client.unlockFixed({ token: await tb.token(), commitmentId: 'x', version: 3 }));
      const fresh = await tb.placement({ kind: 'fixed', commitmentId: 'x', version: 3, unlockId: freshUnlock }, 660);
      const saved = await tb.client.submit({ ...command, payload: { previewId: fresh.previewId, candidateId: fresh.candidates[0].id, acknowledgedOverlap: null } }); return { before, failed, after, oldRetry, saved, final: await tb.state() };
    });
    assert.equal(r.failed.code, 'STORAGE_FAILED'); assert.equal(r.failed.retry, 'preview'); assert.deepEqual(r.before, r.after); assert.equal(r.oldRetry.code, 'PREVIEW_STALE'); assert.equal(r.saved.ok, true); assert.equal(r.final.raw.data.planner.fixed[0].version, 4); assert.deepEqual(r.final.raw.data.planner.fixed[1], r.before.raw.data.planner.fixed[1]);
    return { newAuthorizationRequired: true, unrelatedObjectPreserved: true };
  });

  await check('C37/C28 legacy-dispatch-blocks-every-ordinary-command-and-keeps-exact-raw', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      const legacy = tb.fx.old(); const outcomes = [];
      for (const raw of [{ schemaVersion: 1, revision: 2, config: legacy.config }, { schemaVersion: 2, revision: 3, data: legacy }, { schemaVersion: 3, revision: 4, data: { config: legacy.config, legacyArchives: [] } }]) {
        await tb.seed(raw); const backup = await tb.evidence(), before = await tb.state();
        const template = { id: 't', version: 1, name: 't', weekdays: [], entries: [], source: { kind: 'manual' } };
        const rule = { id: 'r', version: 1, name: 'r', definitionId: 'd', weekdays: [1], startDate: '2026-09-28', zone: 'Asia/Shanghai', status: 'active', source: { kind: 'manual' } };
        const payloads = {
          SaveSettings: { settings: tb.fx.blank().settings }, CreateCapture: { text: 'c', source: '' }, SetCaptureStatus: { capture: { id: 'c', version: 1 }, status: 'archived' },
          UpdateDay: { date: '2026-09-28', version: 1, minimum: true, top3: [] }, SaveTemplate: { template, expectedVersion: null }, SaveRule: { rule, expectedVersion: null }, SaveProject: { project: { id: 'p', name: 'p', status: 'active' } }, SaveGoal: { goal: { id: 'g', name: 'g' } },
          SaveDefinition: { id: 'd', expectedVersion: null, content: tb.fx.content(), enabled: true, parentDefinitionId: null }, ArchiveDefinition: { definition: { id: 'd', version: 1 } }, AcceptOffer: { definition: { id: 'd', version: 1 }, targetDate: null }, ResolveCaptureToAction: { capture: { id: 'c', version: 1 }, content: tb.fx.content(), targetDate: null },
          UpdateOpenInstance: { instance: { id: 'i', version: 7 }, content: tb.fx.content(), targetDate: null, placementPreviewId: null, acknowledgedOverlap: null }, ReorderHand: { instanceIds: [] }, WithdrawInstance: { instance: { id: 'i', version: 7 } }, ReturnWithdrawnToHand: { instance: { id: 'i', version: 7 } },
          CommitPlacement: { previewId: 'x', candidateId: 'y', acknowledgedOverlap: null }, RetractPlan: { planId: 'p', version: 4 }, CancelFixed: { commitment: { id: 'x', version: 3 }, unlockId: 'x' }, ApplyDayTemplate: { previewId: 'p', acknowledgedOverlap: null }, ConfirmActual: { previewId: 'p', acknowledgedOverlap: null }, AppendAnnotation: { factId: 'f', text: 'a' }, PrepareDay: { date: '2026-09-28', zone: 'Asia/Shanghai', templateId: null }, CreateMakeup: { occurrence: { kind: 'occurrence', id: 'o' }, targetDate: '2026-09-28' }, ImportDefinitions: { previewId: 'p', mode: 'merge', backup }
        };
        const replies = []; for (const [type, payload] of Object.entries(payloads)) replies.push({ type, result: await tb.submit(type, payload) });
        await tb.client.readDay({ date: '2026-09-28', zone: 'Asia/Shanghai' }); await tb.client.readCatalog(); await tb.client.prepareBackup(); outcomes.push({ before, replies, after: await tb.state() });
      } return outcomes;
    });
    for (const o of r) { for (const reply of o.replies) assert.equal(reply.result.code, 'LEGACY_READ_ONLY', reply.type); assert.deepEqual(o.before, o.after); }
    return { oldEnvelopeVariants: 3, commandChecks: r.reduce((n, o) => n + o.replies.length, 0) };
  });

  await check('C38/C45 lifecycle-failure-at-clear-and-workspace-put-restores-all-keys-and-epoch', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      const outcomes = [];
      for (const type of ['ClearWorkspace', 'RestoreWorkspace', 'CommitMigration']) for (const site of ['clear', 'put']) {
        const raw = type === 'CommitMigration' ? { schemaVersion: 3, revision: 8, data: tb.fx.old() } : tb.fx.envelope(tb.fx.confirmed()); await tb.seed(raw); await tb.recoveryKeys();
        const backup = await tb.evidence(); let preview;
        if (type === 'RestoreWorkspace') preview = tb.value(await tb.client.previewRestore({ token: backup.token, text: JSON.stringify({ format: 'cardgrid', version: 2, kind: 'backup', dataFormat: 'action-v2', data: tb.fx.hand() }) }));
        if (type === 'CommitMigration') preview = tb.value(await tb.client.previewMigration({ token: backup.token, choices: { zone: 'Asia/Shanghai' } }));
        const command = { commandId: `${type}-${site}`, expected: backup.token, type, payload: { ...(preview ? { previewId: preview.previewId } : {}), backup, discardDraftsConfirmed: true } }, before = await tb.state();
        const original = IDBObjectStore.prototype[site]; IDBObjectStore.prototype[site] = function(...args) { const result = original.apply(this, args); if ((site === 'clear' && this.name === 'recovery') || (site === 'put' && this.name === 'workspace')) this.transaction.abort(); return result; };
        let failed; try { failed = await tb.client.submit(command); } finally { IDBObjectStore.prototype[site] = original; }
        const after = await tb.state(), retry = await tb.client.submit(command), afterSuccess = await tb.state();
        await tb.submit('CreateCapture', { text: 'later write', source: '' }); const later = await tb.state(), replay = await tb.client.submit(command), afterReplay = await tb.state();
        outcomes.push({ type, site, before, failed, after, retry, afterSuccess, later, replay, afterReplay });
      } return outcomes;
    });
    for (const o of r) { assert.equal(o.failed.code, 'STORAGE_FAILED', `${o.type}/${o.site}`); assert.deepEqual(o.before, o.after); assert.equal(o.retry.ok, true); assert.deepEqual(o.afterSuccess.recovery, []); assert.notEqual(o.afterSuccess.raw.epoch, o.before.raw.epoch); assert.equal(o.replay.value.replayed, true); assert.deepEqual(o.later, o.afterReplay); }
    return { lifecycleFaultSites: r.length, everyRecoveryKeyRemoved: true, laterWritesPreserved: true };
  });

  await check('C20/C26/C27/C45 revision-conflict-retains-input-and-backup-token-is-exact', async context => {
    const a = await pageIn(context), b = await pageIn(context); await a.evaluate(() => tb.seed());
    const stale = await a.evaluate(async () => ({ expected: await tb.token(), backup: await tb.evidence() }));
    await b.evaluate(() => tb.submit('CreateCapture', { text: 'other window', source: '' }));
    const before = await a.evaluate(() => tb.state());
    const r = await a.evaluate(async stale => ({ clear: await tb.submit('ClearWorkspace', { backup: stale.backup, discardDraftsConfirmed: true }, 'stale-clear', stale.expected), order: await tb.submit('ReorderHand', { instanceIds: ['i'] }, 'stale-order', stale.expected), fake: await tb.submit('ClearWorkspace', { backup: { ...stale.backup, token: await tb.token() }, discardDraftsConfirmed: true }, 'fake-backup') }), stale);
    assert.equal(r.clear.code, 'REVISION_CONFLICT'); assert.equal(r.order.code, 'REVISION_CONFLICT'); assert.equal(r.fake.ok, false); assert.deepEqual(await a.evaluate(() => tb.state()), before);
    return { staleBackupAndOrderRefused: true, forgedEvidenceRefused: true };
  });

  await check('C20/C21 stale-accept-and-sort-refused-after-definition-retirement-or-new-hand', async context => {
    const a = await pageIn(context), b = await pageIn(context);
    await a.evaluate(async () => { const data = tb.fx.hand(); data.planner.definitions = [{ id: 'd', version: 1, enabled: true, content: tb.fx.content(), parentDefinitionId: null, source: { kind: 'manual' } }]; await tb.seed(tb.fx.envelope(data)); });
    const expected = await a.evaluate(() => tb.token());
    const archived = await b.evaluate(() => tb.submit('ArchiveDefinition', { definition: { id: 'd', version: 1 } })); assert.equal(archived.ok, true);
    const r = await a.evaluate(async expected => { const before = await tb.state(); return { before,
      stale: await tb.submit('AcceptOffer', { definition: { id: 'd', version: 1 }, targetDate: null }, 'stale-accept', expected),
      disabled: await tb.submit('AcceptOffer', { definition: { id: 'd', version: 2 }, targetDate: null }), after: await tb.state() }; }, expected);
    assert.equal(r.stale.code, 'REVISION_CONFLICT'); assert.equal(r.disabled.code, 'DEFINITION_DISABLED'); assert.deepEqual(r.before, r.after);
    const sortToken = await a.evaluate(() => tb.token());
    const converted = await b.evaluate(async () => { const response = await tb.submit('CreateCapture', { text: 'new hand', source: '' }); const captureId = response.value.resultRefs[0].id; return tb.submit('ResolveCaptureToAction', { capture: { id: captureId, version: 1 }, content: tb.fx.content(), targetDate: null }); }); assert.equal(converted.ok, true);
    const beforeSort = await a.evaluate(() => tb.state()), staleSort = await a.evaluate(expected => tb.submit('ReorderHand', { instanceIds: ['i'] }, 'sort-before-new-card', expected), sortToken);
    assert.equal(staleSort.code, 'REVISION_CONFLICT'); assert.deepEqual(await a.evaluate(() => tb.state()), beforeSort); assert.equal(beforeSort.raw.data.planner.handOrder.length, 2);
    return { staleDefinitionRevisionFirst: true, disabledAfterRefresh: true, staleHandCannotOmitNewCard: true };
  });

  await check('C05/C30/C40 retract-storage-failure-retry-and-replace-retain-same-instance-old-plan', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      await tb.seed(tb.fx.envelope(tb.fx.planned())); const before = await tb.state();
      const command = { commandId: 'retract', expected: await tb.token(), type: 'RetractPlan', payload: { planId: 'p', version: 4 } };
      const original = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function(...args) { const r = original.apply(this, args); if (this.name === 'workspace') this.transaction.abort(); return r; };
      let failed; try { failed = await tb.client.submit(command); } finally { IDBObjectStore.prototype.put = original; }
      const afterFailure = await tb.state(), retried = await tb.client.submit(command), sealed = (await tb.state()).raw.data.planner.plans[0];
      const edited = await tb.submit('UpdateOpenInstance', { instance: { id: 'i', version: 7 }, content: tb.fx.content(60), targetDate: null, placementPreviewId: null, acknowledgedOverlap: null });
      const p = await tb.placement({ kind: 'hand', instanceId: 'i', version: 8 }, 660), placed = await tb.submit('CommitPlacement', { previewId: p.previewId, candidateId: p.candidates[0].id, acknowledgedOverlap: null });
      const final = await tb.state(), replay = await tb.client.submit(command); return { before, failed, afterFailure, retried, sealed, edited, placed, final, replay, afterReplay: await tb.state() };
    });
    assert.equal(r.failed.code, 'STORAGE_FAILED'); assert.deepEqual(r.before, r.afterFailure); assert.equal(r.retried.ok, true); assert.equal(r.edited.ok, true); assert.equal(r.placed.ok, true);
    assert.equal(r.final.raw.data.planner.instances.length, 1); assert.deepEqual(r.final.raw.data.planner.plans[0], r.sealed); assert.equal(r.sealed.status, 'retracted'); assert.notEqual(r.final.raw.data.planner.plans[1].id, 'p');
    assert.equal(r.final.raw.data.planner.plans[1].range.localEnd, '2026-09-28T12:00'); assert.equal(r.final.raw.data.planner.instances[0].creationSnapshot.presetMinutes, 30); assert.deepEqual(r.final, r.afterReplay); assert.equal(r.replay.value.replayed, true);
    return { sameInstance: true, sealedPlanPreserved: true, failureRetryAndReplay: true };
  });

  await check('C18/C23/C43 past-routine-makeup-once-keeps-original-and-no-midnight-write', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      const data = tb.fx.hand(); data.planner.definitions = [{ id: 'd', version: 1, content: tb.fx.content(), enabled: true, parentDefinitionId: null, source: { kind: 'manual' } }];
      data.planner.rules = [{ id: 'r', version: 1, name: 'routine', definitionId: 'd', weekdays: [0, 1], startDate: '2026-09-01', zone: 'Asia/Shanghai', status: 'active', source: { kind: 'manual' } }];
      data.planner.occurrences = [{ id: 'o', ruleId: 'r', date: '2026-09-27', instanceId: 'i', disposition: 'missed' }];
      data.planner.instances[0] = { ...data.planner.instances[0], source: { kind: 'occurrence', id: 'o' }, occurrenceId: 'o', definition: { id: 'd', version: 1 } };
      await tb.seed(tb.fx.envelope(data)); const before = await tb.state();
      await tb.client.readDay({ date: '2026-09-27', zone: 'Asia/Shanghai' }); await tb.client.load(); const afterRead = await tb.state();
      const editOriginal = await tb.submit('UpdateOpenInstance', { instance: { id: 'i', version: 7 }, content: tb.fx.content(60), targetDate: null, placementPreviewId: null, acknowledgedOverlap: null });
      const first = await tb.submit('CreateMakeup', { occurrence: { kind: 'occurrence', id: 'o' }, targetDate: '2026-09-28' });
      const second = await tb.submit('CreateMakeup', { occurrence: { kind: 'occurrence', id: 'o' }, targetDate: '2026-09-28' }); return { before, afterRead, editOriginal, first, second, after: await tb.state() };
    });
    assert.deepEqual(r.before, r.afterRead); assert.equal(r.editOriginal.code, 'PAST_OCCURRENCE_LOCKED'); assert.equal(r.first.ok, true); assert.equal(r.second.ok, true); assert.deepEqual(r.first.value.resultRefs, r.second.value.resultRefs);
    assert.equal(r.after.raw.data.planner.instances.length, 2); assert.equal(r.after.raw.data.planner.history.length, 1); assert.equal(r.after.raw.data.planner.facts.length, 0); assert.deepEqual(r.after.raw.data.planner.occurrences, r.before.raw.data.planner.occurrences); assert.deepEqual(r.after.raw.data.planner.instances[0], r.before.raw.data.planner.instances[0]);
    return { oneMakeup: true, originalUnchanged: true, noFactInvented: true };
  });

  await check('C13/C36 repeated-local-time-preview-and-independently-selected-actual-endpoints', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      const data = tb.fx.hand(); data.settings.zone = 'America/New_York'; await tb.seed(tb.fx.envelope(data));
      const p = tb.value(await tb.client.previewPlacement({ token: await tb.token(), subject: { kind: 'hand', instanceId: 'i', version: 7 }, date: '2026-11-01', zone: 'America/New_York', focusMinuteOfDay: 90 }));
      const chosen = p.candidates.find(c => c.range.startOffset === '-05:00');
      const placed = await tb.submit('CommitPlacement', { previewId: p.previewId, candidateId: chosen.id, acknowledgedOverlap: null }); const plan = (await tb.state()).raw.data.planner.plans[0];
      const preview = tb.value(await tb.client.previewActual({ token: await tb.token(), draft: { mode: 'planned', instanceId: 'i', instanceVersion: 7, planId: plan.id, planVersion: plan.version,
        start: { date: '2026-11-01', time: '01:45', zone: 'America/New_York', offset: '-04:00' }, end: { date: '2026-11-01', time: '01:10', zone: 'America/New_York', offset: '-05:00' } } }));
      const confirmed = await tb.submit('ConfirmActual', { previewId: preview.previewId, acknowledgedOverlap: preview.acknowledgementId }); return { p, placed, plan, preview, confirmed, after: await tb.state() };
    });
    assert.deepEqual(r.p.candidates.map(c => c.range.startAt), ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z']); assert.equal(r.placed.ok, true); assert.equal(r.plan.range.startAt, '2026-11-01T06:30:00Z');
    assert.equal(r.confirmed.ok, true); assert.equal(r.preview.range.startAt, '2026-11-01T05:45:00Z'); assert.equal(r.preview.range.endAt, '2026-11-01T06:10:00Z'); assert.equal(r.after.raw.data.planner.facts.length, 1);
    return { twoActualIdentities: true, endpointsChosenIndependently: true };
  });

  // Required regressions deliberately remain red when the core violates the contract. 2C owns fixes.
  await check('2B-F01 C42/C44 day-template-spill-from-unprepared-previous-day-requires-overlap-ack', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      const data = tb.fx.blank(); data.planner.templates = [
        { id: 'sun', version: 1, name: 'Sunday', weekdays: [0], source: { kind: 'manual' }, entries: [{ id: 'late', title: '跨午夜固定', start: '23:30', elapsedMinutes: 120, definitionId: null }] },
        { id: 'mon', version: 1, name: 'Monday', weekdays: [1], source: { kind: 'manual' }, entries: [{ id: 'early', title: '凌晨固定', start: '00:00', elapsedMinutes: 30, definitionId: null }] }
      ]; await tb.seed(tb.fx.envelope(data)); const before = await tb.state();
      const view = await tb.client.readDay({ date: '2026-09-28', zone: 'Asia/Shanghai' });
      const preview = await tb.client.previewDayTemplate({ token: await tb.token(), date: '2026-09-28', zone: 'Asia/Shanghai', templateId: 'mon' });
      const submitted = await tb.submit('PrepareDay', { date: '2026-09-28', zone: 'Asia/Shanghai', templateId: 'mon' }); return { before, view, preview, submitted, after: await tb.state() };
    });
    assert.equal(r.view.ok, true); assert.equal(r.preview.ok, true);
    assert.equal(r.submitted.code, 'OVERLAP_CONFIRMATION_REQUIRED', JSON.stringify({ submitted: r.submitted, conflicts: r.preview.value.conflicts })); assert.deepEqual(r.before, r.after);
    assert.equal(r.preview.value.conflicts.some(c => c.id.includes('sun')), true);
    return { crossDayProjectionAcknowledged: true };
  });

  await check('2B-F01b C42/C44 day-template-spill-into-unprepared-next-day-requires-overlap-ack', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      const data = tb.fx.blank(); data.planner.templates = [
        { id: 'mon', version: 1, name: 'Monday', weekdays: [1], source: { kind: 'manual' }, entries: [{ id: 'late', title: '跨午夜固定', start: '23:30', elapsedMinutes: 120, definitionId: null }] },
        { id: 'tue', version: 1, name: 'Tuesday', weekdays: [2], source: { kind: 'manual' }, entries: [{ id: 'early', title: '凌晨固定', start: '00:00', elapsedMinutes: 30, definitionId: null }] }
      ]; await tb.seed(tb.fx.envelope(data)); const before = await tb.state();
      const preview = await tb.client.previewDayTemplate({ token: await tb.token(), date: '2026-09-28', zone: 'Asia/Shanghai', templateId: 'mon' });
      const submitted = await tb.submit('PrepareDay', { date: '2026-09-28', zone: 'Asia/Shanghai', templateId: 'mon' }); return { before, preview, submitted, after: await tb.state() };
    });
    assert.equal(r.preview.ok, true, JSON.stringify(r.preview));
    assert.equal(r.preview.value.conflicts.some(c => c.id.includes('tue')), true, JSON.stringify({ conflicts: r.preview.value.conflicts }));
    assert.equal(r.submitted.code, 'OVERLAP_CONFIRMATION_REQUIRED', JSON.stringify({ submitted: r.submitted, conflicts: r.preview.value.conflicts })); assert.deepEqual(r.before, r.after);
    return { crossDayNextProjectionAcknowledged: true };
  });

  await check('2B-F02 C11/C16 non-grid-new-template-is-refused-at-the-save-boundary', async context => {
    const page = await pageIn(context);
    const r = await page.evaluate(async () => {
      await tb.seed(); const before = await tb.state();
      const template = { id: 'bad', version: 1, name: '非网格模板', weekdays: [1], source: { kind: 'manual' }, entries: [{ id: 'off-grid', title: '非网格', start: '09:02', elapsedMinutes: 30, definitionId: null }] };
      const submitted = await tb.submit('SaveTemplate', { template, expectedVersion: null });
      const read = await tb.client.readDay({ date: '2026-09-28', zone: 'Asia/Shanghai' }); return { before, submitted, read, after: await tb.state() };
    });
    assert.equal(r.submitted.ok, false, JSON.stringify({ submitted: r.submitted, subsequentRead: r.read })); assert.deepEqual(r.before, r.after);
    return { invalidGridRefusedBeforeWrite: true };
  });
} finally {
  await browser?.close(); await server.close();
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ at: new Date().toISOString(), node: process.version, results }, null, 2));
  console.log('Evidence:', output);
}
if (results.some(r => r.status !== 'pass') || !results.length) process.exitCode = 1;
