import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ActionCard, BookEntry, GenerationRule, Pool, SlotSpec,
} from '../../../src/workspace/contracts-v3.ts';
import {
  EMPTY_CONTEXT, bumpVersion,
  validateActionDraft, validateBookDraft, validatePoolDraft, validateRuleDraft,
  type WorkshopContext,
} from '../../../src/workshop/model.ts';
import { content } from '../../fixtures/action/independent.ts';

const book = (over: Partial<BookEntry> = {}): BookEntry => ({
  id: 'b1', version: 1, kind: 'book', title: '《百年孤独》', author: null,
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
const ctx = (over: Partial<WorkshopContext> = {}): WorkshopContext => ({
  actionCards: [action()], bookEntries: [book()], pools: [pool()], rules: [rule()], ...over,
});

const slot = (over: Partial<SlotSpec> = {}): SlotSpec => ({
  id: 's', label: '书名', poolId: 'p1', required: true, valueKind: 'entry', ...over,
});

test('bumpVersion increments', () => assert.equal(bumpVersion(3), 4));

test('book entry requires a title', () => {
  assert.equal(validateBookDraft(book({ title: '   ' }))[0].code, 'TITLE_REQUIRED');
  assert.deepEqual(validateBookDraft(book()), []);
});

test('action card requires a title and validates its slots', () => {
  assert.equal(validateActionDraft(action({ content: { ...content(), title: '' } }), ctx())[0].code, 'TITLE_REQUIRED');
  assert.equal(validateActionDraft(action({ slots: [slot(), slot({ id: 's', poolId: 'p1' })] }), ctx())[0].code, 'SLOT_ID_DUPLICATE');
  assert.equal(validateActionDraft(action({ slots: [slot({ poolId: 'ghost' })] }), ctx())[0].code, 'SLOT_POOL_NOT_FOUND');

  const actionPool = pool({ id: 'pa', poolKind: 'action' });
  assert.equal(
    validateActionDraft(action({ slots: [slot({ poolId: 'pa' })] }), ctx({ pools: [pool(), actionPool] }))[0].code,
    'SLOT_POOL_KIND_MISMATCH');

  assert.deepEqual(validateActionDraft(action({ slots: [slot()] }), ctx()), []);
});

test('pool validates name, members, parent kind', () => {
  assert.equal(validatePoolDraft(pool({ name: '' }), ctx())[0].code, 'NAME_REQUIRED');
  assert.equal(validatePoolDraft(pool({ memberIds: ['ghost'] }), ctx())[0].code, 'MEMBER_NOT_FOUND');
  // A book pool referencing an action-card id is a kind mismatch (reported as missing book member).
  assert.equal(validatePoolDraft(pool({ memberIds: ['a1'] }), ctx())[0].code, 'MEMBER_NOT_FOUND');
  // An action pool referencing a book id.
  assert.equal(
    validatePoolDraft(pool({ id: 'pa', poolKind: 'action', memberIds: ['b1'] }),
      ctx({ pools: [pool(), pool({ id: 'pa', poolKind: 'action' })] }))[0].code,
    'MEMBER_NOT_FOUND');

  assert.equal(validatePoolDraft(pool({ parentPoolId: 'ghost' }), ctx())[0].code, 'POOL_PARENT_NOT_FOUND');
  const actionPool = pool({ id: 'pa', poolKind: 'action' });
  assert.equal(
    validatePoolDraft(pool({ parentPoolId: 'pa' }), ctx({ pools: [pool(), actionPool] }))[0].code,
    'POOL_PARENT_KIND');

  assert.deepEqual(validatePoolDraft(pool({ memberIds: ['b1'] }), ctx()), []);
  assert.deepEqual(
    validatePoolDraft(pool({ id: 'pa', poolKind: 'action', memberIds: ['a1'] }),
      ctx({ pools: [pool(), pool({ id: 'pa', poolKind: 'action' })] })),
    []);
});

test('pool hierarchy cannot cycle', () => {
  const A = pool({ id: 'A', parentPoolId: 'B' });
  const B = pool({ id: 'B', parentPoolId: 'A' });
  const C = pool({ id: 'C', parentPoolId: 'A' });
  assert.equal(validatePoolDraft(C, { ...EMPTY_CONTEXT, pools: [A, B, C] })[0]?.code, 'POOL_PARENT_CYCLE');
});

test('generation rule validates references, weekdays, date and zone', () => {
  assert.equal(validateRuleDraft(rule({ name: '' }), ctx())[0].code, 'NAME_REQUIRED');
  assert.equal(validateRuleDraft(rule({ actionCardId: 'ghost' }), ctx())[0].code, 'RULE_ACTION_NOT_FOUND');
  assert.equal(validateRuleDraft(rule({ schedule: { mode: 'weekdays', weekdays: [] } }), ctx())[0].code, 'RULE_WEEKDAYS_INVALID');
  assert.equal(validateRuleDraft(rule({ schedule: { mode: 'weekdays', weekdays: [7] } }), ctx())[0].code, 'RULE_WEEKDAYS_INVALID');
  assert.equal(validateRuleDraft(rule({ startDate: 'nope' }), ctx())[0].code, 'RULE_START_INVALID');
  assert.equal(validateRuleDraft(rule({ zone: 'notazone' }), ctx())[0].code, 'RULE_ZONE_INVALID');

  assert.deepEqual(validateRuleDraft(rule(), ctx()), []);
  assert.deepEqual(validateRuleDraft(rule({ schedule: { mode: 'weekdays', weekdays: [1, 3, 5] } }), ctx()), []);
});
