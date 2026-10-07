import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createRequire} from 'node:module';
import {emptyWorkspaceData, backupBytes, fingerprint, validateActionData, inspectImportText, parseRestore} from '../../../app/src/workspace/format.ts';
import {catalog} from './fixtures.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const app = path.join(repo, 'app');
const out = path.join(app, 'test-results/v06-c0-20261006');
fs.mkdirSync(out, {recursive: true});
const require = createRequire(pathToFileURL(path.join(app, 'package.json')));
const {chromium} = require('playwright');
const LIMIT = 32 * 1024 * 1024;
const round = n => Math.round(n * 100) / 100;
const text = '合成日记容量验证。'.repeat(20); // 180 CJK characters, 540 UTF-8 bytes.
const at = date => `${date}T00:12:00Z`;
const dateAt = d => new Date(Date.UTC(2020, 0, 1 + d)).toISOString().slice(0, 10);
const content = {title: '合成行动', criteria: '合成标准', presetMinutes: 30, color: '#336699', categoryId: null, categoryLabel: null, minimum: false, projectIds: [], goalIds: [], projectLabels: [], goalLabels: []};

function history(data, id, date, kind, entityId, before, after) {
  data.planner.history.push({id, commandId: id, at: at(date), date, type: kind, entity: {kind: kind === 'SaveJournalNote' ? 'journal-note' : 'instance', id: entityId}, before, after});
  data.commandReceipts.push({commandId: id, type: kind, payloadFingerprint: 'a'.repeat(64), resultRefs: [{kind: kind === 'SaveJournalNote' ? 'journal-note' : 'instance', id: entityId}]});
}

function proposed(days) {
  const data = {...emptyWorkspaceData(), version: 5};
  delete data.bookEntries; delete data.pools;
  data.catalogEntries = Array.from({length: 1000}, (_, i) => ({id: `entry-${i}`, version: 1, title: `合成条目${i}`, attributes: {author: '合成'}, url: null, status: 'active', source: {kind: 'manual'}}));
  data.decks = Array.from({length: 10}, (_, i) => ({id: `deck-${i}`, version: 1, name: `合成牌堆${i}`, deckKind: 'entry', parentDeckId: null, memberIds: data.catalogEntries.slice(i * 100, i * 100 + 100).map(e => e.id), source: {kind: 'manual'}}));
  data.decisionCards = catalog.decisions.map(d => ({...d, version: 1}));
  data.handCards = []; data.referencePlacements = []; data.factReferenceSnapshots = []; data.catalogAliases = [];
  data.journalNotes = [];
  for (let d = 0; d < days; d++) {
    const date = dateAt(d);
    for (let n = 0; n < 4; n++) {
      const id = `note-${d}-${n}`, initial = {id, version: 1, kind: 'reflection', date, zone: 'Asia/Shanghai', recordedAt: at(date), createdAt: at(date), updatedAt: at(date), text};
      const updated = {...initial, version: 2, text: `${text}修订`, updatedAt: `${date}T01:12:00Z`};
      data.journalNotes.push(updated);
      history(data, `note-create-${d}-${n}`, date, 'SaveJournalNote', id, null, initial);
      history(data, `note-edit-${d}-${n}`, date, 'SaveJournalNote', id, initial, updated);
    }
    for (let n = 0; n < 6; n++) {
      const id = `instance-${d}-${n}`;
      const instance = {id, version: 1, definition: null, creationSnapshot: content, currentContent: content, source: {kind: 'manual'}, createdAt: at(date), targetDate: date, state: 'open', occurrenceId: null, makeupOf: null};
      data.planner.instances.push(instance);
      const start = new Date(`${date}T02:00:00Z`); start.setUTCHours(2 + n);
      const startAt = start.toISOString(), endAt = new Date(+start + 1800000).toISOString();
      const range = {startAt, endAt, zone: 'Asia/Shanghai', localStart: `${date}T${String(10+n).padStart(2,'0')}:00`, localEnd: `${date}T${String(10+n).padStart(2,'0')}:30`, startOffset: '+08:00', endOffset: '+08:00'};
      const plan = {id: `plan-${d}-${n}`, version: 2, instanceId: id, range, contentSnapshot: content, status: 'confirmed', createdAt: at(date), changedAt: at(date)};
      const fact = {id: `fact-${d}-${n}`, instanceId: id, contentSnapshot: content, actualRange: range, plannedSnapshot: {planId: plan.id, planVersion: 1, range, content}, confirmedAt: at(date), source: {kind: 'manual'}};
      data.planner.plans.push(plan); data.planner.facts.push(fact);
      history(data, `take-${d}-${n}`, date, 'TakeActionMaterial', id, null, instance);
      history(data, `place-${d}-${n}`, date, 'CommitPlacement', id, null, {...plan, version: 1, status: 'active'});
      history(data, `actual-${d}-${n}`, date, 'ConfirmActual', id, {...plan, version: 1, status: 'active'}, {plan, fact});
    }
  }
  return data;
}

function legacy(days) {
  const data = emptyWorkspaceData();
  for (let d = 0; d < days; d++) {
    const date = dateAt(d), id = `journal-${d}`;
    let previous = null;
    // Four entries added across the day; each current save retains the whole before/after.
    for (let n = 1; n <= 8; n++) {
      const entry = {id, version: n, date, zone: 'Asia/Shanghai', text: text.repeat(Math.ceil(n/2)), createdAt: at(date), updatedAt: at(date)};
      data.planner.history.push({id: `legacy-${d}-${n}`, commandId: `legacy-${d}-${n}`, at: at(date), date, type: 'SaveJournalEntry', entity: {kind: 'journal-entry', id}, before: previous, after: entry});
      previous = entry;
    }
    data.journalEntries.push(previous);
  }
  return data;
}

function packageOf(data) { return {format: 'cardgrid', version: data.version, kind: 'backup', dataFormat: `action-v${data.version}`, data}; }
async function measure(label, data, fullFingerprint = true) {
  const before = process.memoryUsage();
  let start = performance.now(); const pack = packageOf(data), serialized = JSON.stringify(pack), stringifyMs = performance.now() - start;
  const bytes = Buffer.byteLength(serialized);
  start = performance.now(); const restored = JSON.parse(serialized); const parseMs = performance.now() - start;
  assert.equal(JSON.stringify(restored), serialized);
  start = performance.now(); structuredClone(data); const cloneMs = performance.now() - start;
  start = performance.now(); const hash = fullFingerprint ? await fingerprint(data) : null; const fingerprintMs = performance.now() - start;
  const after = process.memoryUsage();
  return {label, bytes, mib: round(bytes/1048576), notes: data.journalNotes?.length ?? data.journalEntries.length, facts: data.planner.facts.length, history: data.planner.history.length, receipts: data.commandReceipts.length, stringifyMs: round(stringifyMs), parseMs: round(parseMs), cloneMs: round(cloneMs), fingerprintMs: round(fingerprintMs), sha256: hash, heapBeforeMiB: round(before.heapUsed/1048576), heapAfterMiB: round(after.heapUsed/1048576), rssMiB: round(after.rss/1048576), roundtrip: 'exact-json', proposedFits32MiB: bytes <= LIMIT};
}

function currentControl(days, model) {
  const control = legacy(days);
  for (const key of ['instances', 'plans', 'facts']) control.planner[key] = model.planner[key];
  control.planner.history.push(...model.planner.history.filter(h => h.entity.kind === 'instance'));
  control.commandReceipts = model.commandReceipts.filter(r => r.resultRefs[0].kind === 'instance');
  return control;
}

if (process.argv.includes('--month-only')) {
  const model = proposed(31), control = currentControl(31, model);
  const result = await measure('v5-model-31-days', model);
  const start = performance.now(); validateActionData(control);
  const monthReport = {kind: 'C0-monthly-archive-size-model', node: process.version, model: result,
    currentV4Control: {bytes: backupBytes(control), validateMs: round(performance.now()-start), validV4: true},
    archiveZipOrCleanupImplemented: false, note: 'A size/validator probe only. It does not prove a dependency-closed monthly archive or ZIP import.'};
  fs.writeFileSync(path.join(out, 'month-capacity.json'), JSON.stringify(monthReport, null, 2));
  console.log(JSON.stringify(monthReport, null, 2));
  process.exit(0);
}

const report = {kind: 'C0-capacity-feasibility', date: '2026-10-06', node: process.version, platform: process.platform, productionChanged: false, note: 'Data5 is an unvalidated size model, not a production schema. Browser checks measure the current/previous IDB transaction structure, not v0.6 Host or user-directory output.', nodeCases: [], browserCases: [], currentValidatorCases: []};
const old = legacy(365);
validateActionData(old);
assert.equal(backupBytes(old), Buffer.byteLength(JSON.stringify(packageOf(old))));
assert.throws(() => inspectImportText(JSON.stringify(packageOf(old))));
report.nodeCases.push(await measure('v4-one-year-four-notes-eight-whole-day-saves', old));
const small = legacy(2); assert.deepEqual(parseRestore(JSON.stringify(packageOf(small))).data, small);
report.currentV4SmallRestore = 'pass';
const samples = [365, 1095].map(days => ({days, data: proposed(days)}));
for (const sample of samples) report.nodeCases.push(await measure(`v5-model-${sample.days}-days`, sample.data));

// Valid v4 control with the same action/plan/fact volume and genuine v4 diary history.
// The byte gate is NOT relaxed: this probes the existing pure semantic validator only.
for (const sample of samples) {
  const control = currentControl(sample.days, sample.data);
  const start = performance.now(); validateActionData(control);
  report.currentValidatorCases.push({days: sample.days, bytes: backupBytes(control), validateMs: round(performance.now() - start), validV4: true, passesProductionByteGate: backupBytes(control) <= 5*1024*1024});
}

// Exact proposed UTF-8 boundary; include the complete backup wrapper.
const boundaryData = proposed(1), boundaryPack = packageOf(boundaryData);
// Separate the current note from the literal history snapshot before padding it.
boundaryData.journalNotes[0] = {...boundaryData.journalNotes[0], text: ''};
const overhead = Buffer.byteLength(JSON.stringify(boundaryPack));
boundaryData.journalNotes[0].text = 'a'.repeat(LIMIT - overhead);
const boundaryText = JSON.stringify(boundaryPack);
assert.equal(Buffer.byteLength(boundaryText), LIMIT);
assert.ok(Buffer.byteLength(boundaryText + ' ') > LIMIT);
report.boundary = {limitBytes: LIMIT, exactBytesAcceptedByProposedPolicy: Buffer.byteLength(boundaryText), nextByteRejectedByProposedPolicy: true, productionLimitStill5MiB: true};

const server = http.createServer((req, res) => {res.writeHead(200, {'Content-Type': 'text/html'}); res.end('<!doctype html><title>C0 isolated capacity probe</title>');});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  const chrome = process.env.CARDGRID_CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({headless: true, ...(fs.existsSync(chrome) ? {executablePath: chrome} : {})});
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  report.browser = await browser.version();
  for (const sample of [...samples.map(s => ({label: `v5-model-${s.days}-days`, data: s.data})), {label: '32-MiB-boundary', data: boundaryData}]) {
    const result = await page.evaluate(async ({label, data}) => {
      const db = await new Promise((resolve, reject) => {const req = indexedDB.open('cardgrid-c0-synthetic-only', 1); req.onupgradeneeded = () => {req.result.createObjectStore('workspace'); req.result.createObjectStore('recovery');}; req.onerror = () => reject(req.error); req.onsuccess = () => resolve(req.result);});
      const time = performance.now();
      const env = {schemaVersion: 4, epoch: 'c0-synthetic', revision: 1, lifecycleReceipt: null, mode: 'current', dataFormat: 'action-v5', data};
      const commit = (value, abort = false) => new Promise((resolve, reject) => {const tx = db.transaction(['workspace','recovery'], 'readwrite'), store = tx.objectStore('workspace'), req = store.get('current'); req.onsuccess = () => {if (req.result) tx.objectStore('recovery').put({raw: req.result}, 'previous'); store.put(value, 'current'); if (abort) tx.abort();}; tx.oncomplete = resolve; tx.onabort = () => abort ? resolve('aborted') : reject(tx.error); tx.onerror = () => {};});
      await commit(env); const firstCommitMs = performance.now() - time;
      let start = performance.now(); await commit({...env, revision: 2}); const commitWithPreviousMs = performance.now() - start;
      const read = () => new Promise((resolve, reject) => {const tx = db.transaction('workspace','readonly'), req = tx.objectStore('workspace').get('current'); tx.oncomplete = () => resolve(req.result); tx.onabort = () => reject(tx.error);});
      start = performance.now(); const loaded = await read(); const readMs = performance.now() - start;
      start = performance.now(); const serialized = JSON.stringify(loaded.data), restored = JSON.parse(serialized); const jsonRoundtripMs = performance.now() - start;
      const restoredExact = JSON.stringify(restored) === serialized;
      await commit({...env, revision: 999}, true);
      const abortPreservesRevision = (await read()).revision === 2;
      const transaction = db.transaction('recovery', 'readonly'), req = transaction.objectStore('recovery').get('previous');
      const previous = await new Promise((resolve, reject) => {transaction.oncomplete = () => resolve(req.result); transaction.onabort = () => reject(transaction.error);});
      const abortPreservesRecovery = previous.raw.revision === 1;
      db.close();
      await new Promise((resolve, reject) => {const req = indexedDB.deleteDatabase('cardgrid-c0-synthetic-only'); req.onsuccess = resolve; req.onerror = () => reject(req.error);});
      return {label, firstCommitMs, commitWithPreviousMs, readMs, jsonRoundtripMs, restoredExact, abortPreservesRevision, abortPreservesRecovery};
    }, sample);
    assert.ok(result.restoredExact && result.abortPreservesRevision && result.abortPreservesRecovery);
    report.browserCases.push(Object.fromEntries(Object.entries(result).map(([key, value]) => [key, typeof value === 'number' ? round(value) : value])));
  }
  await context.close();
} finally {await browser?.close(); await new Promise(resolve => server.close(resolve));}
report.maxRssMiB = round(process.resourceUsage().maxRSS/1024);
fs.writeFileSync(path.join(out, 'capacity.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
