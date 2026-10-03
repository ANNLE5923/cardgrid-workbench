import test from 'node:test';
import assert from 'node:assert/strict';
import { previewMinuteAtCardEdge, stagedCardPreview, pulledBeyondDial } from './card-placement.ts';

const dial = { left: 0, top: 0, width: 400, height: 400 };
test('card edge meets outer ring, then inner ring, then leaves preview', () => {
  // At pointer 09:30 the lower edge of both rings represents 09:30/21:30.
  assert.equal(previewMinuteAtCardEdge(200, 375, dial, 570, false), 1290);
  assert.equal(previewMinuteAtCardEdge(200, 320, dial, 570, false), 570);
  assert.equal(previewMinuteAtCardEdge(200, 395, dial, 570, false), null);
  assert.equal(previewMinuteAtCardEdge(200, 375, dial, 570, true), 570);
});
test('held card exposes outer preview before inner even when it starts over the dial', () => {
  assert.equal(stagedCardPreview(200, 320, dial, 570, false, 7), null);
  assert.equal(stagedCardPreview(200, 320, dial, 570, false, 40), 1290);
  assert.equal(stagedCardPreview(200, 320, dial, 570, false, 90), 570);
});
test('slider must cross outside boundary to return, while inner-to-outer movement stays on dial', () => {
  assert.equal(pulledBeyondDial(200, 350, dial, 94), false);
  assert.equal(pulledBeyondDial(200, 350, dial, 132), false);
  assert.equal(pulledBeyondDial(200, 395, dial, 132), true);
  assert.equal(pulledBeyondDial(200, 395, dial, 94), true);
});
