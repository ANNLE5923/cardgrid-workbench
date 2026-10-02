import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fanLayout,
  shortestAngle,
  rotateFocus,
  isReclaim,
  clientPointToLogical,
} from '../src/components/time-dial/interaction.ts';

test('fanLayout returns no angles for an empty hand', () => {
  assert.deepEqual(fanLayout(0), []);
});

test('fanLayout centers a single card at zero', () => {
  assert.deepEqual(fanLayout(1), [0]);
});

test('fanLayout spreads cards symmetrically around the bottom', () => {
  const angles = fanLayout(4);
  assert.equal(angles.length, 4);
  assert.ok(angles.every((a, i) => i === 0 || a > angles[i - 1]), 'angles increase');
  assert.ok(Math.abs(angles[0] + angles[3]) < 1e-9, 'symmetric');
  assert.ok(Math.abs(angles[1] + angles[2]) < 1e-9, 'symmetric inner pair');
  assert.ok(angles[0] >= -32 && angles[3] <= 32, 'within default spread');
});

test('fanLayout caps the number of shown cards', () => {
  assert.equal(fanLayout(9, { maxCards: 4 }).length, 4);
});

test('shortestAngle unwraps to [-180,180]', () => {
  assert.equal(shortestAngle(0, 90), 90);
  assert.equal(shortestAngle(0, 270), -90);
  assert.equal(shortestAngle(350, 10), 20);
  assert.equal(shortestAngle(10, 350), -20);
});

test('rotateFocus maps zero delta to the same focus', () => {
  assert.equal(rotateFocus(540, 0), 540);
});

test('rotateFocus moves focus opposite the rotation and clamps to the day', () => {
  assert.equal(rotateFocus(540, 10), 520);
  assert.equal(rotateFocus(540, -10), 560);
  assert.equal(rotateFocus(0, -1000), 1440);
  assert.equal(rotateFocus(1440, 1000), 0);
});

test('isReclaim requires both the outside radius and the pull distance', () => {
  assert.equal(isReclaim(145, 190), true); // 190 >= 190 and diff 45 >= 45
  assert.equal(isReclaim(145, 189), false); // not far enough out
  assert.equal(isReclaim(180, 200), false); // outside but only 20 radial travel
  assert.equal(isReclaim(100, 200), true);
});

test('clientPointToLogical maps the center of a square rect', () => {
  const rect = { left: 0, top: 0, width: 400, height: 400 } as DOMRect;
  assert.deepEqual(clientPointToLogical(200, 200, rect), { x: 200, y: 200 });
  assert.deepEqual(clientPointToLogical(0, 0, rect), { x: 0, y: 0 });
});

test('clientPointToLogical letterboxes a non-square rect to the logical dial', () => {
  const rect = { left: 0, top: 0, width: 300, height: 400 } as DOMRect;
  // scale 0.75, vertical letterbox offset 50; the viewport center is still logical (200,200)
  assert.deepEqual(clientPointToLogical(150, 200, rect), { x: 200, y: 200 });
});
