import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectEnvelope, inspectImport, inspectImportText, readWorkspaceSnapshot, WorkspaceFormatError } from '../../../src/workspace/format.ts';

function data() {
  return {
    version: 2,
    settings: { zone: null, preferences: { theme: 'paper', density: 'comfortable', startHour: 8, endHour: 23, defaultMinutes: 15 }, categories: [] },
    planner: { version: 2, definitions: [], instances: [], handOrder: [], plans: [], facts: [], annotations: [], fixed: [], templates: [], days: [], rules: [], occurrences: [], captures: [], refs: [], goals: [], history: [] },
    legacySources: [], migrationBindings: [], commandReceipts: []
  };
}
function legacyData(withPlanner: boolean) {
  return { config: { preferences: { theme: 'paper', density: 'comfortable', startHour: 8, endHour: 23, defaultMinutes: 15 }, categories: [], cards: [], schedules: [] }, legacyArchives: [], ...(withPlanner ? { planner: { version: 1, tasks: [], rules: [], occurrences: [], templates: [], days: [], captures: [], history: [], refs: [], goals: [], legacyImported: false } } : {}) };
}
function envelope() { return { schemaVersion: 4, epoch: 'epoch-1', revision: 0, mode: 'current', dataFormat: 'action-v2', data: data(), lifecycleReceipt: null }; }
function badAt(fn: () => unknown, path: string) {
  assert.throws(fn, error => error instanceof WorkspaceFormatError && error.path === path);
}

test('2A.1 identifies empty and current snapshots without changing a single field', () => {
  assert.equal(inspectEnvelope(undefined).kind, 'uninitialized');
  const raw = envelope();
  const before = structuredClone(raw);
  const found = inspectEnvelope(raw);
  assert.equal(found.kind, 'current');
  assert.equal(found.raw, raw);
  assert.deepEqual(raw, before);
  assert.equal(found.semanticValidationPending, true);
});

test('2A.1 preserves both legacy backup shapes and schema 1 envelope verbatim', () => {
  for (const withPlanner of [false, true]) {
    const raw = { format: 'cardgrid', version: 1, kind: 'backup', data: legacyData(withPlanner) };
    const before = structuredClone(raw);
    const found = inspectImport(raw);
    assert.equal(found.kind, 'backup-v1');
    assert.equal(found.raw, raw);
    assert.deepEqual(raw, before);
    if (found.kind === 'backup-v1') assert.equal(found.sourceFormat, withPlanner ? 'cardgrid-v1-p1a' : 'cardgrid-v1-pre-planner');
  }
  const schema1 = { schemaVersion: 1, revision: 9, config: legacyData(false).config };
  assert.equal(inspectEnvelope(schema1).raw, schema1);
  assert.equal(inspectImport({ format: 'cardgrid', version: 2, kind: 'backup', dataFormat: 'envelope-v1', data: schema1 }).kind, 'backup-v2');
  for (const schemaVersion of [2, 3]) {
    const local = { schemaVersion, revision: 11, data: legacyData(true) };
    assert.equal(inspectEnvelope(local).raw, local);
    assert.equal(inspectEnvelope(local).kind, 'legacy-readonly');
  }
});

test('2A.1 rejects version ambiguity, unknown fields, missing fields and mismatched dataFormat', () => {
  badAt(() => inspectImport({ format: 'cardgrid', version: 3, kind: 'backup', data: data() }), '$.version');
  badAt(() => inspectEnvelope({ ...envelope(), schemaVersion: 5 }), '$.schemaVersion');
  badAt(() => inspectEnvelope({ ...envelope(), surprise: 1 }), '$.surprise');
  const missing = envelope();
  delete (missing as Partial<typeof missing>).lifecycleReceipt;
  badAt(() => inspectEnvelope(missing), '$.lifecycleReceipt');
  badAt(() => inspectImport({ format: 'cardgrid', version: 2, kind: 'backup', dataFormat: 'action-v2', data: legacyData(true) }), '$.data.version');
  badAt(() => inspectEnvelope({ ...envelope(), mode: 'legacy-readonly', dataFormat: 'action-v2' }), '$.dataFormat');
});

test('2A.1 catches core dangling references before exposing a new snapshot', () => {
  const withBadPlan = envelope();
  withBadPlan.data.planner.plans.push({ id: 'p1', instanceId: 'missing' } as never);
  badAt(() => inspectEnvelope(withBadPlan), '$.data.planner.plans[0].instanceId');
  const withBadFact = envelope();
  withBadFact.data.planner.annotations.push({ id: 'a1', factId: 'missing' } as never);
  badAt(() => inspectEnvelope(withBadFact), '$.data.planner.annotations[0].factId');
  const withBadLegacyRef = envelope();
  withBadLegacyRef.data.planner.days.push({ date: '2026-09-26', top3: [{ kind: 'legacy', sourceId: 'missing', path: 'planner.tasks[0]' }] } as never);
  badAt(() => inspectEnvelope(withBadLegacyRef), '$.data.planner.days[0].top3[0].sourceId');
});

test('2A.1 limits input and leaves the original text with its caller on parse failure', () => {
  const malformed = '{"format":"cardgrid",';
  badAt(() => inspectImportText(malformed), '$');
  assert.equal(malformed, '{"format":"cardgrid",');
  badAt(() => inspectImportText(' '.repeat(5 * 1024 * 1024 + 1)), '$');
});

test('2A.1 database reader requests a readonly transaction and never opens or upgrades a database', async () => {
  const raw = envelope();
  const modes: string[] = [];
  const db = {
    transaction(store: string, mode: string) {
      assert.equal(store, 'workspace');
      modes.push(mode);
      return {
        objectStore(name: string) {
          assert.equal(name, 'workspace');
          return { get(key: string) {
            assert.equal(key, 'current');
            const request: { result: unknown; onsuccess?: () => void } = { result: raw };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          } };
        }
      };
    }
  } as unknown as IDBDatabase;
  const inspected = await readWorkspaceSnapshot(db);
  assert.equal(inspected.raw, raw);
  assert.deepEqual(modes, ['readonly']);
});
