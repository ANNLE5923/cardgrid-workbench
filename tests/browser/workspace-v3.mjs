// Author checks: synthetic data in fresh browser contexts, never a personal profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {chromium} = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.CARDGRID_V3_OUTPUT || path.join(os.tmpdir(), `cardgrid-v3-${Date.now()}`);
await fs.mkdir(output, {recursive: true});
const server = await createServer({root, configFile: false, server: {host: '127.0.0.1', port: 0},
  optimizeDeps: {noDiscovery: true, entries: [], include: ['@js-temporal/polyfill', 'jsbi']},
  plugins: [{name: 'isolated-v3-test', configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      if (req.url === '/__v3-test') {res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>B3 isolated transaction checks</title>');}
      else if (req.url === '/__v3-built' || /^\/assets\/[^/]+\.(js|css)$/.test(req.url ?? '')) {
        try {
          const file = req.url === '/__v3-built' ? 'index.html' : req.url.slice(1);
          res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : 'text/css');
          res.end(await fs.readFile(path.join(root, 'dist', file)));
        } catch (error) {next(error);}
      } else next();
    });
  }}], logLevel: 'error'});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const results = [];
let browser;
try {
  browser = await chromium.launch({headless: true, ...(process.env.CARDGRID_CHROME_PATH ? {executablePath: process.env.CARDGRID_CHROME_PATH} : {})});
  async function pageIn(context, name = 'cardgrid-b3-isolated') {
    const page = await context.newPage(); await page.goto(origin + '/__v3-test');
    await page.evaluate(async name => {
      const S = await import('/src/workspace/store.ts'), W = await import('/src/workspace/client.ts');
      const F = await import('/src/workspace/format.ts'), H = await import('/src/workspace/workshop-host.ts');
      const fx = await import('/tests/modules/workshop/a1-fixtures.ts'), old = await import('/tests/fixtures/action/independent.ts');
      const base = S.createWorkspaceStore({name}); let at = '2026-10-04T04:00:00Z', lose = false;
      const store = {...base, async atomic(reduce) {
        const result = await base.atomic(reduce);
        if (lose) {lose = false; throw new Error('lost transport reply after real IDB commit');}
        return result;
      }};
      const client = W.createWorkspaceClient({store, now: () => at, random: () => 0});
      const ok = r => {if (!r.ok) throw new Error(JSON.stringify(r)); return r.value;};
      const token = async () => ok(await client.load()).token;
      const command = async (type, payload, commandId = crypto.randomUUID()) => ({type, payload, commandId, expected: await token()});
      const submit = async (type, payload) => ok(await client.submit(await command(type, payload)));
      const data = async () => ok(await client.load()).data;
      globalThis.cg = {S, W, F, H, fx, old, store, client, ok, token, command, submit, data, external: 0,
        setNow(value) {at = value;}, loseNext() {lose = true;},
        async snapshot() {return {raw: (await store.read()) ?? null, recovery: await store.readRecovery()};},
        async setup() {
          await submit('SaveBookEntry', {bookEntry: fx.bookEntry(), expectedVersion: null});
          await submit('SavePool', {pool: fx.pool(), expectedVersion: null});
          await submit('SaveActionCard', {actionCard: fx.actionCard(), expectedVersion: null});
          await submit('SaveGenerationRule', {generationRule: fx.rule(), expectedVersion: null});
        },
        async generate() {await submit('GenerateDailyCopies', {target: 'current'}); return (await data()).dailyCopies.at(-1);},
        async acceptCommand() {
          const copy = (await data()).dailyCopies[0], ref = {id: copy.id, version: copy.version};
          const selection = ok(await client.selectEntry({token: await token(), copy: ref, slotId: 'book', choice: {mode: 'random'}})).selection;
          const preview = ok(await client.previewCombo({token: await token(), copy: ref, selections: [selection]}));
          return command('AcceptDailyCopy', {copy: ref, selections: [selection], composedText: preview.composedText});
        },
        async accept() {const response = ok(await client.submit(await cg.acceptCommand())); return (await data()).planner.instances.find(i => i.id === response.resultRefs[0].id);},
        async backup() {const prepared = ok(await client.prepareBackup()); return {prepared, evidence: {token: prepared.token, dataFingerprint: prepared.dataFingerprint, fileSavedConfirmed: true}};},
        async abort(command) {
          const before = await cg.snapshot(), original = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function(...args) {const request = original.apply(this, args); if (this.name === 'workspace') this.transaction.abort(); return request;};
          let failed; try {failed = await client.submit(command);} finally {IDBObjectStore.prototype.put = original;}
          const after = await cg.snapshot(), retry = await client.submit(command), replay = await client.submit(command);
          return {before, failed, after, retry, replay, final: await cg.snapshot()};
        },
      };
      store.subscribe(external => {if (external) cg.external++;});
    }, name);
    return page;
  }
  async function test(name, fn) {
    const context = await browser.newContext({timezoneId: 'Asia/Shanghai', serviceWorkers: 'block'}), started = Date.now();
    try {const detail = await fn(context); results.push({name, status: 'pass', durationMs: Date.now() - started, detail}); console.log('PASS', name);}
    catch (error) {
      const last = context.pages().at(-1);
      if (last) await last.screenshot({path: path.join(output, `failure-${name}.png`), fullPage: true}).catch(() => {});
      results.push({name, status: 'fail', error: error.stack}); console.error('FAIL', name, error);
    }
    finally {await context.close();}
  }
  await test('blank-read-no-write-and-v3-reload-exact-backup', async context => {
    const page = await pageIn(context);
    const before = await page.evaluate(async () => {await cg.client.load(); await cg.client.load(); return cg.snapshot();});
    assert.deepEqual(before, {raw: null, recovery: []});
    const saved = await page.evaluate(async () => {await cg.setup(); await cg.generate(); await cg.accept(); return cg.snapshot();});
    await page.reload();
    // Reinstall the adapter on the same origin and database after the page lifetime ends.
    await page.close(); const reopened = await pageIn(context);
    const result = await reopened.evaluate(async () => {
      const before = await cg.snapshot(), prepared = cg.ok(await cg.client.prepareBackup());
      const restored = cg.F.parseRestore(prepared.text); await cg.client.readInventory({token: await cg.token()});
      return {before, after: await cg.snapshot(), restored, pack: JSON.parse(prepared.text)};
    });
    assert.deepEqual(result.before, saved); assert.deepEqual(result.after, saved);
    assert.equal(result.pack.version, 4); assert.deepEqual(result.restored.data, saved.raw.data);
    return {persistentInstances: saved.raw.data.planner.instances.length, readsNeverGenerate: true};
  });
  await test('two-windows-generation-and-accept-compete-notify-and-replay', async context => {
    const a = await pageIn(context), b = await pageIn(context); await a.evaluate(() => cg.setup());
    await b.evaluate(() => {cg.external = 0;});
    const commands = await Promise.all([a, b].map(page => page.evaluate(() => cg.command('GenerateDailyCopies', {target: 'current'}))));
    const replies = await Promise.all([a, b].map((page, i) => page.evaluate(command => cg.client.submit(command), commands[i])));
    assert.equal(replies.filter(r => r.ok).length, 1); assert.equal(replies.find(r => !r.ok).code, 'REVISION_CONFLICT');
    await b.waitForFunction(() => cg.external > 0);
    await b.evaluate(() => cg.submit('GenerateDailyCopies', {target: 'current'}));
    const inventory = await b.evaluate(() => cg.data()); assert.equal(inventory.dailyCopies.length, 1); assert.equal(inventory.generationLedger.length, 1);
    const accepts = await Promise.all([a, b].map(page => page.evaluate(() => cg.acceptCommand())));
    const accepted = await Promise.all([a, b].map((page, i) => page.evaluate(command => cg.client.submit(command), accepts[i])));
    assert.equal(accepted.filter(r => r.ok).length, 1); assert.equal(accepted.find(r => !r.ok).code, 'REVISION_CONFLICT');
    const winner = accepted.findIndex(r => r.ok), other = winner === 0 ? b : a;
    const before = await other.evaluate(() => cg.snapshot());
    const replay = await other.evaluate(command => cg.client.submit(command), accepts[winner]);
    assert.equal(replay.value.replayed, true); assert.deepEqual(await other.evaluate(() => cg.snapshot()), before);
    const stale = await other.evaluate(command => cg.client.previewCombo({token: command.expected, copy: command.payload.copy, selections: command.payload.selections}), accepts[winner]);
    assert.equal(stale.code, 'REVISION_CONFLICT'); await other.evaluate(() => cg.accept());
    const final = await other.evaluate(() => cg.data()); assert.equal(final.planner.instances.length, 2); assert.equal(final.dailyCopies[0].version, 3);
    return {oneGeneration: true, independentAccepts: 2, crossWindowReplay: true, notified: true};
  });
  await test('real-idb-abort-rolls-back-generation-accept-and-archive', async context => {
    const page = await pageIn(context);
    const rows = await page.evaluate(async () => {
      await cg.setup(); const rows = [];
      rows.push(await cg.abort(await cg.command('GenerateDailyCopies', {target: 'current'})));
      rows.push(await cg.abort(await cg.acceptCommand()));
      cg.setNow('2026-10-11T04:00:00Z'); rows.push(await cg.abort(await cg.command('ArchiveDueCopies', {})));
      return rows;
    });
    for (const row of rows) {
      assert.equal(row.failed.code, 'STORAGE_FAILED'); assert.deepEqual(row.after, row.before);
      assert.equal(row.retry.ok, true); assert.equal(row.replay.value.replayed, true);
      assert.equal(row.final.raw.data.commandReceipts.length, row.before.raw.data.commandReceipts.length + 1);
    }
    assert.equal(rows[2].final.raw.data.dailyCopies.length, 0); assert.equal(rows[2].final.raw.data.archiveLogs.length, 1);
    return {atomicRollbacks: rows.length, recoveryAndReceiptsPreserved: true};
  });
  await test('real-commit-lost-reply-host-reuses-command-and-keeps-selected-snapshot', async context => {
    const page = await pageIn(context);
    const result = await page.evaluate(async () => {
      await cg.setup(); const host = cg.H.createWorkshopHost(cg.client); cg.ok(await host.load());
      const draft = cg.fx.bookEntry({title: '真实事务改名'}); cg.loseNext(); const failed = await host.saveBookEntry(draft), committed = await cg.snapshot();
      const retry = await host.saveBookEntry(draft), afterRetry = await cg.snapshot();
      await cg.generate(); const command = await cg.acceptCommand(); cg.loseNext(); const lostAccept = await cg.client.submit(command), afterAccept = await cg.snapshot();
      const replay = await cg.client.submit(command); return {failed, committed, retry, afterRetry, lostAccept, afterAccept, replay, final: await cg.snapshot(), command};
    });
    assert.equal(result.failed.code, 'STORAGE_FAILED'); assert.equal(result.retry.value.version, 2); assert.deepEqual(result.committed, result.afterRetry);
    assert.equal(result.lostAccept.code, 'STORAGE_FAILED'); assert.equal(result.replay.value.replayed, true); assert.deepEqual(result.afterAccept, result.final);
    assert.deepEqual(result.final.raw.data.planner.instances[0].daily.slotSelections, result.command.payload.selections);
    return {sameRequestRetry: true, instanceCount: 1, selectionRetained: true};
  });
  await test('archive-retains-facts-and-lifecycle-capabilities-expire-across-windows', async context => {
    const page = await pageIn(context), other = await pageIn(context);
    const archived = await page.evaluate(async () => {
      await cg.setup(); await cg.generate(); const first = await cg.accept(), second = await cg.accept();
      const placement = cg.ok(await cg.client.previewPlacement({token: await cg.token(), subject: {kind: 'hand', instanceId: second.id, version: second.version}, date: '2026-10-10', zone: 'Asia/Shanghai', focusMinuteOfDay: 540}));
      await cg.submit('CommitPlacement', {previewId: placement.previewId, candidateId: placement.candidates[0].id, acknowledgedOverlap: null});
      const actual = cg.ok(await cg.client.previewActual({token: await cg.token(), draft: {mode: 'unplanned', instanceId: first.id, instanceVersion: first.version,
        start: {date: '2026-10-04', time: '09:00', zone: 'Asia/Shanghai'}, end: {date: '2026-10-04', time: '09:30', zone: 'Asia/Shanghai'}}}));
      await cg.submit('ConfirmActual', {previewId: actual.previewId, acknowledgedOverlap: null});
      await cg.submit('AppendAnnotation', {factId: (await cg.data()).planner.facts[0].id, text: '归档后仍需保留'});
      const before = await cg.data(); cg.setNow('2026-10-11T04:00:00Z'); await cg.submit('ArchiveDueCopies', {});
      const after = await cg.data(); globalThis.preparedBackup = await cg.backup();
      globalThis.restorePreview = cg.ok(await cg.client.previewRestore({token: preparedBackup.evidence.token, text: preparedBackup.prepared.text}));
      return {before, after};
    });
    assert.deepEqual(archived.after.planner.facts, archived.before.planner.facts); assert.deepEqual(archived.after.planner.annotations, archived.before.planner.annotations);
    assert.equal(archived.after.planner.plans[0].status, 'retracted'); assert.deepEqual(archived.after.planner.handOrder, []);
    await other.evaluate(() => cg.submit('CreateCapture', {text: '其他窗口', source: 'test'}));
    const lifecycle = await page.evaluate(async () => {
      const beforeStale = await cg.snapshot(), stale = await cg.client.submit({commandId: crypto.randomUUID(), expected: preparedBackup.evidence.token, type: 'RestoreWorkspace',
        payload: {previewId: restorePreview.previewId, backup: preparedBackup.evidence, discardDraftsConfirmed: true}}), afterStale = await cg.snapshot();
      const fresh = await cg.backup(), preview = cg.ok(await cg.client.previewRestore({token: fresh.evidence.token, text: preparedBackup.prepared.text}));
      const restored = await cg.submit('RestoreWorkspace', {previewId: preview.previewId, backup: fresh.evidence, discardDraftsConfirmed: true});
      const restoredData = await cg.data(), clearBackup = await cg.backup(), clearCommand = await cg.command('ClearWorkspace', {backup: clearBackup.evidence, discardDraftsConfirmed: true});
      const rollback = await cg.abort(clearCommand), cleared = await cg.snapshot();
      return {beforeStale, stale, afterStale, restored, restoredData, rollback, cleared};
    });
    assert.equal(lifecycle.stale.code, 'REVISION_CONFLICT'); assert.deepEqual(lifecycle.beforeStale, lifecycle.afterStale);
    assert.deepEqual(lifecycle.restoredData, archived.after); assert.equal(lifecycle.rollback.failed.code, 'STORAGE_FAILED');
    assert.deepEqual(lifecycle.rollback.before, lifecycle.rollback.after); assert.equal(lifecycle.rollback.retry.ok, true);
    assert.equal(lifecycle.cleared.raw.data.version, 4); assert.deepEqual(lifecycle.cleared.raw.data.actionCards, []); assert.deepEqual(lifecycle.cleared.recovery, []);
    return {factsKept: 1, annotationsKept: 1, staleRestoreBlocked: true, restoreExact: true, clearRollback: true};
  });
  await test('v2-read-stays-v2-explicit-backed-up-upgrade-preserves-history', async context => {
    const page = await pageIn(context);
    const result = await page.evaluate(async () => {
      const old = cg.old.confirmed(); await cg.store.atomic(() => ({write: cg.old.envelope(old), result: null}));
      const before = await cg.snapshot(); await cg.client.load(); await cg.client.prepareBackup(); const afterRead = await cg.snapshot();
      const preview = cg.ok(await cg.client.previewMigration({token: await cg.token(), choices: {zone: null}}));
      const backup = await cg.backup(), command = await cg.command('CommitMigration', {previewId: preview.previewId, backup: backup.evidence, discardDraftsConfirmed: true});
      const aborted = await cg.abort(command); return {old, before, afterRead, preview, aborted, final: await cg.snapshot()};
    });
    assert.deepEqual(result.before, result.afterRead); assert.equal(result.preview.targetSummary.facts, 1);
    assert.equal(result.aborted.failed.code, 'STORAGE_FAILED'); assert.deepEqual(result.aborted.before, result.aborted.after);
    assert.equal(result.aborted.retry.ok, true); assert.equal(result.aborted.replay.value.replayed, true);
    assert.equal(result.final.raw.data.version, 3); assert.deepEqual(result.final.raw.data.planner, result.old.planner);
    assert.deepEqual(result.final.raw.data.settings, result.old.settings); assert.deepEqual(result.final.recovery, []);
    return {readNoMigration: true, explicitUpgrade: true, oldFactsKept: 1};
  });
  await test('production-build-v2-upgrade-entry-backup-preview-and-commit', async context => {
    const page = await pageIn(context, 'cardgrid-workspace');
    await page.evaluate(async () => {await cg.store.atomic(() => ({write: cg.old.envelope(cg.old.confirmed()), result: null})); cg.client.close();});
    await page.goto(origin + '/__v3-built');
    await page.getByRole('button', {name: /数据与备份/}).click();
    await page.getByRole('heading', {name: '升级以启用工坊与每日库存'}).waitFor();
    await page.getByRole('button', {name: '预览升级', exact: true}).click();
    await page.getByText('升级后保留：定义').waitFor();
    assert.equal(await page.getByRole('button', {name: '执行已预览操作'}).isDisabled(), true);
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: '下载完整备份', exact: true}).click()]);
    await download.saveAs(path.join(output, 'synthetic-v2-before-upgrade.json'));
    await page.getByLabel('我已保存这份完整备份').check();
    await page.getByLabel('确认放弃未提交草稿并执行以上操作').check();
    await page.getByRole('button', {name: '执行已预览操作'}).click();
    await page.getByRole('heading', {name: '升级以启用工坊与每日库存'}).waitFor({state: 'detached'});
    const final = await page.evaluate(async () => {const S = await import('/src/workspace/store.ts'), store = S.createWorkspaceStore(); const raw = await store.read(); store.close(); return raw;});
    assert.equal(final.data.version, 3); assert.equal(final.data.planner.facts.length, 1);
    await page.screenshot({path: path.join(output, 'production-upgraded.png'), fullPage: true});
    return {builtAssetsUsed: true, explicitBackupAndPreview: true, preservedFacts: 1};
  });
} finally {
  await browser?.close(); await server.close();
  await fs.writeFile(path.join(output, 'browser-results.json'), JSON.stringify({at: new Date().toISOString(), origin, results}, null, 2));
  console.log('Evidence:', output);
}
if (results.length !== 7 || results.some(r => r.status !== 'pass')) process.exitCode = 1;
