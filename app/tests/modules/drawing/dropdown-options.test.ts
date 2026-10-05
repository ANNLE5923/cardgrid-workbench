import test from 'node:test';
import assert from 'node:assert/strict';
import {DROPDOWN_CAPACITY, dropdownOptions, sampleDropdownIds} from '../../../src/drawing/ui/dropdown-options.ts';

const books = (count: number) => Array.from({length: count}, (_, i) => ({id: `book-${i + 1}`, title: `书目${i + 1}`}));

test('small dropdown pools keep their order and do not consume randomness', () => {
  for (const count of [0, 2, 9]) {
    const candidates = books(count), ids = candidates.map(book => book.id);
    assert.deepEqual(sampleDropdownIds(ids, DROPDOWN_CAPACITY - 1, () => {throw Error('unexpected random');}), ids);
  }
});

test('oversized dropdown pools sample nine unique entries, including candidates beyond the first nine', () => {
  const candidates = books(100), before = structuredClone(candidates);
  const ids = sampleDropdownIds(candidates.map(book => book.id), DROPDOWN_CAPACITY - 1, () => 0);
  assert.equal(ids.length, 9);
  assert.equal(new Set(ids).size, 9);
  assert.ok(ids.includes('book-10'));
  assert.deepEqual(candidates, before);
});

test('full-pool selection stays visible within the same capacity and preserves the original display sample', () => {
  const candidates = books(100), ids = candidates.slice(0, 9).map(book => book.id);
  const options = dropdownOptions(candidates, ids, 'book-100');
  assert.equal(options.length, 9);
  assert.equal(options.at(-1), candidates[99]);
  assert.deepEqual(options.slice(0, 8), candidates.slice(0, 8));
  assert.deepEqual(dropdownOptions(candidates, ids, undefined), candidates.slice(0, 9));
  assert.deepEqual(ids, candidates.slice(0, 9).map(book => book.id));
});

test('optional empty choice shares the ten-item budget and removed books are not reintroduced', () => {
  const candidates = books(100), ids = sampleDropdownIds(candidates.map(book => book.id), DROPDOWN_CAPACITY - 2, () => 0);
  assert.equal(dropdownOptions(candidates, ids, 'book-100').length + 2, 10);
  assert.ok(!dropdownOptions(candidates, ids, 'removed').some(book => book.id === 'removed'));
});
