import test from 'node:test';
import assert from 'node:assert/strict';
import {b4Harness, ok, ref} from '../../support/v06/b4-fixtures.ts';
import {catalog} from '../../support/v06/fixtures.ts';
import {createFormalCatalogEditor} from '../../../src/workshop/formal-catalog-editor.ts';
import {createInMemoryCatalogEditor} from '../../../src/workshop/catalog-editor.ts';
import {backupV5} from '../../../src/workspace/v5-format.ts';
import type {V06Command} from '../../../src/workspace/v06.ts';

const readFailure = {ok: false, code: 'STORAGE_FAILED', message: 'post-commit read unavailable', retry: 'same-command'} as const;
const operations = ['takeAction', 'takeEntry', 'confirmSynthesis', 'moveMember', 'saveEntry', 'saveAction'] as const;
type Operation = typeof operations[number];
type Harness = Awaited<ReturnType<typeof b4Harness>>;

async function prepare(h: Harness, editor: ReturnType<typeof createFormalCatalogEditor>, operation: Operation) {
  if (operation === 'takeAction') return () => editor.takeAction({action: ref(catalog.actionCards[0])});
  if (operation === 'takeEntry') return () => editor.takeEntry({entry: ref(catalog.catalogEntries[0])});
  if (operation === 'saveEntry') return () => editor.saveEntry({draft: {...catalog.catalogEntries[0], id: 'retry-entry'}, expectedVersion: null});
  if (operation === 'saveAction') return () => editor.saveAction({draft: {...catalog.actionCards[0], id: 'retry-action'}, expectedVersion: null});
  if (operation === 'moveMember') {
    await h.submit('SaveDeck', {deck: {...catalog.decks[0], id: 'retry-target', memberIds: []}, expectedVersion: null});
    return () => editor.moveMember({entry: ref(catalog.catalogEntries[0]), from: ref(catalog.decks[0]), to: {id: 'retry-target', version: 1}, targetIndex: 0});
  }
  const answer = await h.answer(true);
  const action = (await h.liveData()).handCards.find(c => c.kind === 'action');
  const preview = ok(await editor.previewSynthesis({inputs: [ref(action), ref(answer)], resolutions: []}));
  return () => editor.confirmSynthesis({previewId: preview.previewId});
}

for (const operation of operations) for (const mode of ['return', 'throw', 'missing'] as const) {
  if (operation === 'moveMember' && mode === 'missing') continue;
  test(`formal editor ${operation}: post-commit ${mode} retries one durable request`, async () => {
    const h = await b4Harness();
    const commands: V06Command[] = [];
    let committed = false, faulted = false;
    const catalogRead = ['moveMember', 'saveEntry', 'saveAction'].includes(operation);
    const editor = createFormalCatalogEditor({...h.host,
      submit: async command => {commands.push(command as V06Command); const result = await h.host.submit(command); if (result.ok) committed = true; return result;},
      readCatalog: async input => {
        const result = await h.host.readCatalog(input);
        if (!catalogRead || !committed || faulted) return result;
        faulted = true;
        if (mode === 'throw') throw Error('catalog read threw');
        if (mode === 'return') return readFailure;
        if (!result.ok) return result;
        return {...result, value: {...result.value, data: {...result.value.data,
          catalogEntries: result.value.data.catalogEntries.filter(e => e.id !== 'retry-entry'),
          actionCards: result.value.data.actionCards.filter(e => e.id !== 'retry-action'),
        }}};
      },
      readMaterials: async input => {
        const result = await h.host.readMaterials(input);
        if (catalogRead || !committed || faulted) return result;
        faulted = true;
        if (mode === 'throw') throw Error('material read threw');
        if (mode === 'return') return readFailure;
        return result.ok ? {...result, value: {...result.value, data: []}} : result;
      },
    });
    try {
      const call = await prepare(h, editor, operation);
      const first = await call();
      assert.equal(first.ok, false);
      if (first.ok) throw Error('read fault reported success');
      assert.equal(first.retry, 'same-command');
      const committedData = await h.liveData();
      // A different operation cannot replace an unconfirmed request.
      assert.equal((await editor.takeEntry({entry: ref(catalog.catalogEntries[3])})).ok, false);
      ok(await call());
      assert.equal(commands.length, 2);
      assert.equal(commands[0].commandId, commands[1].commandId);
      assert.deepEqual(await h.liveData(), committedData);
      assert.equal(committedData.commandReceipts.filter(r => r.commandId === commands[0].commandId).length, 1);
    } finally {h.host.close();}
  });
}

for (const operation of ['takeAction', 'moveMember', 'saveEntry', 'saveAction'] as const) {
  test(`formal editor ${operation}: restoration between commit and read cannot acknowledge the old result`, async () => {
    const h = await b4Harness();
    let restoreText = '', baseline: Awaited<ReturnType<Harness['liveData']>>, replace = true;
    const editor = createFormalCatalogEditor({...h.host, submit: async command => {
      const result = await h.host.submit(command);
      if (result.ok && replace) {
        replace = false;
        const backup = ok(await h.host.prepareBackup());
        const preview = ok(await h.host.previewRestore({token: backup.token, text: restoreText}));
        ok(await h.host.submit({commandId: crypto.randomUUID(), expected: backup.token, type: 'RestoreWorkspace', payload: {previewId: preview.previewId, discardDraftsConfirmed: true, backup: {token: backup.token, dataFingerprint: backup.dataFingerprint, fileSavedConfirmed: true}}}));
      }
      return result;
    }});
    try {
      const call = await prepare(h, editor, operation);
      baseline = await h.liveData();
      restoreText = JSON.stringify(backupV5(baseline));
      const first = await call();
      assert.equal(first.ok, false);
      if (first.ok) throw Error('old workspace acknowledged');
      assert.equal(first.code, 'WORKSPACE_REPLACED');
      assert.equal(first.retry, 'reload');
      assert.deepEqual(await h.liveData(), baseline);
    } finally {h.host.close();}
  });
}

test('formal editor cannot retry an uncertain request after a later restoration', async () => {
  const h = await b4Harness();
  let lost = true;
  const editor = createFormalCatalogEditor({...h.host, submit: async command => {const result = await h.host.submit(command); if (lost && result.ok) {lost = false; throw Error('lost reply');} return result;}});
  try {
    assert.equal((await editor.takeAction({action: ref(catalog.actionCards[0])})).ok, false);
    const backup = ok(await h.host.prepareBackup());
    const preview = ok(await h.host.previewRestore({token: backup.token, text: backup.text}));
    ok(await h.host.submit({commandId: crypto.randomUUID(), type: 'RestoreWorkspace', expected: backup.token, payload: {previewId: preview.previewId, discardDraftsConfirmed: true, backup: {token: backup.token, dataFingerprint: backup.dataFingerprint, fileSavedConfirmed: true}}}));
    const before = await h.liveData();
    const retry = await editor.takeAction({action: ref(catalog.actionCards[0])});
    assert.equal(!retry.ok && retry.code, 'WORKSPACE_REPLACED');
    assert.deepEqual(await h.liveData(), before);
  } finally {h.host.close();}
});

test('action edits preserve frozen material and legacy metadata in both editor adapters', async () => {
  const h = await b4Harness();
  try {
    const editor = createFormalCatalogEditor(h.host);
    const draft = {...catalog.actionCards[0], id: 'editable-action', parentId: 'read', content: {...catalog.actionCards[0].content, presetMinutes: null, projectIds: ['old-project'], projectLabels: [{id: 'old-project', label: '旧项目'}]}};
    const original = ok(await editor.saveAction({draft, expectedVersion: null})).action;
    const taken = ok(await editor.takeAction({action: ref(original)})).card;
    const update = {...original, content: {...original.content, title: '新标题'}, status: 'paused' as const};
    const edited = ok(await editor.saveAction({draft: update, expectedVersion: 1})).action;
    assert.equal(edited.version, 2);
    assert.deepEqual(edited.content.projectLabels, draft.content.projectLabels);
    assert.equal(edited.parentId, draft.parentId);
    assert.equal(edited.content.presetMinutes, null);
    assert.deepEqual((await h.liveData()).handCards.find(c => c.id === taken.id), taken);
    assert.equal((await editor.saveAction({draft: update, expectedVersion: 1})).ok, false);
    const memory = createInMemoryCatalogEditor(catalog);
    ok(await memory.saveAction({draft, expectedVersion: null}));
    assert.equal(ok(await memory.saveAction({draft: update, expectedVersion: 1})).action.version, 2);
  } finally {h.host.close();}
});
