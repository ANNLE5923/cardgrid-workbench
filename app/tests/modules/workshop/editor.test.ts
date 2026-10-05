import test from 'node:test';
import assert from 'node:assert/strict';
import type { ActionCard, BookEntry, GenerationRule, Pool } from '../../../src/workspace/contracts-v3.ts';
import {
  actionToForm, bookToForm, poolToForm, ruleToForm,
  formToAction, formToBook, formToPool, formToRule,
  emptyBookForm, emptyRuleForm, parseWorkshopJson,
} from '../../../src/workshop/drafts.ts';
import { createTestWorkshopHost } from '../../support/workshop/test-host.ts';
import { content } from '../../fixtures/action/independent.ts';

const book = (over: Partial<BookEntry> = {}): BookEntry => ({
  id: 'b1', version: 1, kind: 'book', title: '《活着》', author: '余华',
  status: 'active', source: { kind: 'manual' }, ...over,
});
const action = (over: Partial<ActionCard> = {}): ActionCard => ({
  id: 'a1', version: 1, kind: 'action', content: content(), slots: [],
  status: 'active', parentId: null, source: { kind: 'manual' }, ...over,
});
const pool = (over: Partial<Pool> = {}): Pool => ({
  id: 'p1', version: 1, name: '书目池', poolKind: 'book',
  parentPoolId: null, memberIds: [], source: { kind: 'manual' }, ...over,
});
const rule = (over: Partial<GenerationRule> = {}): GenerationRule => ({
  id: 'r1', version: 1, name: '每日阅读', actionCardId: 'a1',
  schedule: { mode: 'daily' }, startDate: '2026-09-01', zone: 'Asia/Shanghai',
  status: 'active', source: { kind: 'manual' }, ...over,
});

test('book form round-trips; blank author becomes null and new version defaults to 1', () => {
  assert.deepEqual(formToBook(bookToForm(book())), book());
  const created = formToBook({ ...emptyBookForm(), id: 'b2', title: '《三体》' });
  assert.equal(created.author, null);
  assert.equal(created.version, 1);
});

test('action form round-trips content and slots', () => {
  const entity: ActionCard = {
    ...action(),
    slots: [{ id: 's1', label: '书名', poolId: 'p1', required: true, valueKind: 'entry' }],
  };
  assert.deepEqual(formToAction(actionToForm(entity)), entity);
});

test('pool form round-trips parent and members', () => {
  const entity: Pool = { ...pool(), parentPoolId: 'p0', memberIds: ['b1'] };
  assert.deepEqual(formToPool(poolToForm(entity)), entity);
});

test('rule form round-trips weekdays; a new daily rule keeps the daily schedule', () => {
  const entity: GenerationRule = { ...rule(), schedule: { mode: 'weekdays', weekdays: [1, 3, 5] } };
  assert.deepEqual(formToRule(ruleToForm(entity)), entity);
  const created = formToRule({ ...emptyRuleForm(), id: 'r2', actionCardId: 'a1', startDate: '2026-10-01' });
  assert.deepEqual(created.schedule, { mode: 'daily' });
});

test('test adapter saves new, bumps versions, and never stores invalid drafts', async () => {
  const host = createTestWorkshopHost();
  assert.equal(host.adapter, 'in-memory-test');

  const created = await host.saveBookEntry(book());
  assert.equal(created.ok, true);
  if (created.ok) assert.equal(created.value.version, 1);

  const invalid = await host.saveBookEntry(book({ id: 'bad', title: '  ' }));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.code, 'VALIDATION_FAILED');
    assert.equal(invalid.issues?.length, 1);
  }
  const snap = host.snapshot();
  assert.equal(snap.bookEntries.length, 1);
  assert.equal(snap.bookEntries[0].id, 'b1');

  const updated = await host.saveBookEntry(book({ title: '《活着》（第二版）' }));
  if (updated.ok) assert.equal(updated.value.version, 2);
  assert.equal(host.snapshot().bookEntries.length, 1);
});

test('changing status via save bumps version and persists the new status', async () => {
  const host = createTestWorkshopHost();
  await host.saveActionCard(action());
  const paused = await host.saveActionCard({ ...action(), status: 'paused' });
  if (paused.ok) {
    assert.equal(paused.value.status, 'paused');
    assert.equal(paused.value.version, 2);
  }
});

test('form and JSON reach the same validation through the host', async () => {
  const host = createTestWorkshopHost();
  const invalidParsed = parseWorkshopJson(JSON.stringify({ ...book(), id: 'jbad', title: '' }));
  assert.equal((await host.saveBookEntry(invalidParsed as BookEntry)).ok, false);

  const validParsed = parseWorkshopJson(JSON.stringify(book({ id: 'j1' })));
  assert.equal((await host.saveBookEntry(validParsed as BookEntry)).ok, true);
});
