import assert from 'node:assert/strict';
import {catalog, cases} from './fixtures.mjs';

// Checks the design vector's completeness and internal consistency only.
// No command is executed: these are NOT v0.6 behavior test passes.
for (const collection of Object.values(catalog)) {
  assert.equal(new Set(collection.map(item => item.id)).size, collection.length);
}
for (const deck of catalog.decks) {
  assert.ok(deck.memberIds.length <= 100);
  assert.equal(new Set(deck.memberIds).size, deck.memberIds.length);
  for (const id of deck.memberIds) assert.ok(catalog.entries.some(item => item.id === id));
}
for (const decision of catalog.decisions) {
  const action = catalog.actions.find(item => item.id === decision.ownerActionId);
  assert.ok(action);
  for (const id of decision.deckIds) assert.ok(catalog.decks.some(deck => deck.id === id));
  for (const mapping of decision.mappings) assert.ok(action.fields.some(field => field.id === mapping.fieldId));
}
assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
assert.ok(catalog.decks.some(deck => !catalog.decisions.some(d => d.deckIds.includes(deck.id))));
for (const vector of cases.slice(0, 3)) {
  const decision = catalog.decisions.find(item => item.id === vector.input.decisionId);
  assert.equal(decision.ownerActionId, vector.input.actionId);
  assert.ok(decision.deckIds.some(id => catalog.decks.find(deck => deck.id === id).memberIds.includes(vector.input.entryId)));
  assert.deepEqual(vector.expected.consumedIds, [vector.input.leftId, vector.input.rightId]);
  assert.equal(vector.expected.outputIds.length, 1);
  assert.equal(vector.expected.libraryChanged, false);
}
for (const vector of cases.filter(item => item.expected.error && 'writes' in item.expected)) assert.equal(vector.expected.writes, 0);
console.log(JSON.stringify({kind: 'C0-fixture-integrity', vectors: cases.length, result: 'pass', behaviorExecuted: false}));
