import test from 'node:test';
import assert from 'node:assert/strict';
import {harness, ok, bookEntry, pool} from './v3-fixtures.ts';
import {validateWorkshopChange} from '../../../src/workshop/catalog.ts';
import {validateDefinitionConfig} from '../../../src/workspace/format.ts';
import type {ConfigV3, DataV3} from '../../../src/workspace/contracts-v3.ts';
import {catalog, actionCard} from '../workshop/a1-fixtures.ts';

test('both pool kinds accept 100 direct members and reject 101; parent pools do not inherit member counts', () => {
  for (const kind of ['book', 'action'] as const) {
    const ids = Array.from({length: 101}, (_, i) => `member-${i}`);
    const entities = kind === 'book' ? ids.map(id => bookEntry({id})) : ids.map(id => actionCard({id, slots: []}));
    const before = {actionCards: kind === 'action' ? entities : [], bookEntries: kind === 'book' ? entities : [], pools: [], generationRules: []};
    const make = (count: number) => ({...before, pools: [pool({id: 'parent', poolKind: kind, memberIds: ids.slice(0, 100)}),
      pool({id: 'child', poolKind: kind, parentPoolId: 'parent', memberIds: ids.slice(0, count)})]});
    assert.equal(validateWorkshopChange(before, make(100)).ok, true);
    const over = validateWorkshopChange(before, make(101));
    assert.equal(over.ok, false);
    if (!over.ok) assert.ok(over.issues.some(issue => issue.code === 'POOL_CAPACITY_EXCEEDED' && issue.path === 'pools[1].memberIds'));
  }
});

const config = (data: DataV3): ConfigV3 => ({format: 'cardgrid', version: 3, kind: 'config', config: {
  settings: data.settings, definitions: data.planner.definitions, templates: data.planner.templates, rules: data.planner.rules,
  actionCards: data.actionCards, bookEntries: data.bookEntries, pools: data.pools, generationRules: data.generationRules,
}});

test('production saves and config previews reject the 101st member without changing data, tokens or recovery', async () => {
  const h = harness();
  for (let i = 1; i <= 101; i++) ok(await h.submit('SaveBookEntry', {bookEntry: bookEntry({id: `book-${i}`}), expectedVersion: null}));
  const ids = (await h.data()).bookEntries.map(book => book.id);
  ok(await h.submit('SavePool', {pool: pool({memberIds: ids.slice(0, 100)}), expectedVersion: null}));
  const before = h.evidence(), data = await h.data();
  const over = {...data.pools[0], version: 2, memberIds: ids};
  const failed = await h.submit('SavePool', {pool: over, expectedVersion: 1});
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.message, /最多 100 张/);
  const pack = config({...data, pools: [over]});
  assert.throws(() => validateDefinitionConfig(pack), /最多 100 张/);
  assert.equal((await h.client.previewDefinitions({token: await h.token(), text: JSON.stringify(pack), mode: 'merge'})).ok, false);
  assert.deepEqual(h.evidence(), before);
  assert.equal(data.bookEntries.length, 101, 'library total is not a pool capacity');
  validateDefinitionConfig(config(data));
});

test('archived members still occupy pool capacity; navigation and global library counts are separate', () => {
  const ids = Array.from({length: 101}, (_, i) => `book-${i}`);
  const before = catalog({bookEntries: ids.map(id => bookEntry({id, status: 'archived'})), pools: [pool({memberIds: ids.slice(0, 100)})]});
  const result = validateWorkshopChange(before, {...before, pools: [pool({version: 2, memberIds: ids})]});
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.issues.some(issue => issue.code === 'POOL_CAPACITY_EXCEEDED'));
});
