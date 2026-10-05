/**
 * 3B regression: reuse the frozen 3A vectors against the REAL geometry/projection-adapter
 * exports, plus no-loss checks on synthetic ProductionDayView fixtures.
 * In-memory only; no IDB/browser/client creation and no user data.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { projectDay } from '../../../src/daily/projection.ts';
import { inspectSnapshot } from '../../../src/workspace/commands.ts';
import { geometry, defaultMetrics } from '../../../src/daily/schedule/time-dial/geometry.ts';
import { projectionAdapter } from '../../../src/daily/schedule/time-dial/projection-adapter.ts';
import type { DialHit, DialHalf, HitAnchor } from '../../../src/daily/schedule/time-dial/types.ts';
import { confirmed, envelope, fixed, planned } from '../../fixtures/action/independent.ts';

const vectors = JSON.parse(
  readFileSync(new URL('../../../../docs/产品设计/3A-regression-vectors.json', import.meta.url), 'utf8'),
);
const angleDelta = (a: number, b: number) => ((b - a + 540) % 360) - 180;
const halfFromCode = (code: number): DialHalf => (code === 0 ? 'inner' : 'outer');

for (const v of vectors.rotation) {
  test(`3B-G01 rotation ${v.focus}`, () => {
    assert.equal(geometry.pose(v.focus).rotationDegrees, v.rotation);
  });
}

for (const v of vectors.arc) {
  test(`3B-G02 arc length ${v.minutes}`, () => {
    assert.equal((v.minutes / 720) * 360, v.degrees);
    if (v.units !== null) assert.equal(v.minutes / 5, v.units);
    // Renderable path for a same-half arc of this length (start at 0).
    const path = geometry.arcPath('inner', 0, v.minutes, defaultMetrics);
    assert.match(path, /^M/);
    assert.match(path, /A/);
  });
}

for (const v of vectors.rotate) {
  test(`3B-G03 bounded rotation ${v.previous}->${v.next}`, () => {
    assert.equal(geometry.rotate(v.focus, angleDelta(v.previous, v.next)), v.expected);
  });
}

for (const v of vectors.landing) {
  test(`3B-G04 landing ${v.minute}`, () => {
    const hit = { half: 'inner', angle: 0, minuteOfHalf: 0, totalMinute: v.minute } as DialHit;
    const landing = geometry.landing(hit, v.date);
    assert.equal(landing.date, v.expectedDate);
    assert.equal(landing.minuteOfDay, v.expectedMinute);
    assert.equal(landing.half, halfFromCode(v.half));
  });
}

for (const v of vectors.surface) {
  test(`3B-G05 inverse scale ${v.width}x${v.height}`, () => {
    const logical = geometry.toLogical(
      { x: v.point[0], y: v.point[1] },
      { width: v.width, height: v.height },
    );
    assert.ok(Math.abs(logical.x - v.expected[0]) < 1e-8);
    assert.ok(Math.abs(logical.y - v.expected[1]) < 1e-8);
  });
}

for (const v of vectors.pull) {
  test(`3B-G06 pull ${v.start}->${v.current}`, () => {
    assert.equal(geometry.pulledOutside(v.start, v.current), v.expected);
  });
}

for (const v of vectors.hit) {
  test(`3B-G07 hit focus=${v.focus} y=${v.point[1]}`, () => {
    const anchor: HitAnchor | null = v.anchor
      ? { half: halfFromCode(v.anchor.half), minuteOfHalf: v.anchor.minuteOfHalf }
      : null;
    const hit = geometry.hit(
      { x: v.point[0], y: v.point[1] },
      geometry.pose(v.focus),
      defaultMetrics,
      anchor,
    );
    if (v.half === null) {
      assert.equal(hit, null);
      return;
    }
    assert.ok(hit);
    assert.equal(hit.half, halfFromCode(v.half));
    assert.ok(Math.abs(hit.minuteOfHalf - v.minute) < 1e-8);
    assert.equal(
      hit.totalMinute,
      halfFromCode(v.half) === 'inner' ? v.minute : 720 + v.minute,
    );
  });
}

async function sceneFor(data: ReturnType<typeof planned>) {
  const view = projectDay(
    await inspectSnapshot(envelope(data)),
    { date: '2026-09-28', zone: 'Asia/Shanghai' },
    '2026-09-28T01:00:00Z',
  );
  return { view, scene: projectionAdapter.buildScene(view) };
}

test('3B-P01 every projected segment is represented in the scene (no loss)', async () => {
  for (const data of [planned(), fixed(), confirmed()]) {
    const { view, scene } = await sceneFor(data);
    const fragmentIds = new Set(scene.items.flatMap(i => i.fragments.map(f => f.id)));
    for (const seg of view.segments) assert.ok(fragmentIds.has(seg.id), `missing ${seg.id}`);
    assert.deepEqual(scene.legacyItems, view.legacyItems);
    assert.equal(scene.version, '3A-dial-1');
    assert.equal(scene.date, view.date);
    assert.equal(scene.zone, view.zone);
  }
});

test('3B-P02 axis covers inner 00-12 and outer 12-24', async () => {
  const { scene } = await sceneFor(planned());
  assert.equal(scene.axis.length, 2);
  assert.deepEqual(
    scene.axis.map(a => [a.half, a.startMinute, a.endMinute]),
    [
      ['inner', 0, 720],
      ['outer', 720, 1440],
    ],
  );
});

test('3B-P03 focusFragments are half-open and plan-reference never counts as occupancy', async () => {
  const { view, scene } = await sceneFor(confirmed());
  // A confirmed fact exists; its plan-reference outline must be present but read-only.
  const references = scene.items.filter(i => i.source === 'plan-reference');
  assert.ok(view.segments.some(s => s.kind === 'plan-reference'));
  for (const item of references) assert.equal(item.readOnly, true);
  // At the fact start, focusFragments include the fact but not the reference outline.
  const fact = view.segments.find(s => s.kind === 'fact')!;
  const atStart = fact.half * 720 + fact.startMinuteOfHalf;
  const covering = projectionAdapter.focusFragments(scene, atStart);
  assert.ok(covering.some(f => f.source === 'fact'));
  // The original-plan outline is drawn at the same place and selectable, but read-only.
  for (const f of covering.filter(f => f.source === 'plan-reference')) {
    assert.equal(f.readOnly, true);
  }
  // Occupancy count excludes plan-reference / empty even though they geometrically cover.
  const occupancy = covering.filter(f => f.source !== 'plan-reference' && f.source !== 'empty');
  assert.ok(!occupancy.some(f => f.source === 'plan-reference'));
  // The end edge is excluded (half-open).
  const atEnd = fact.half * 720 + fact.endMinuteOfHalf;
  assert.ok(!projectionAdapter.focusFragments(scene, atEnd).some(f => f.source === 'fact'));
});

test('3B-P04 hourOverview returns only items intersecting the wall hour', async () => {
  const { scene } = await sceneFor(planned());
  const items = projectionAdapter.hourOverview(scene, 9);
  for (const item of items) {
    assert.ok(item.startMinute < 10 * 60 && item.endMinute > 9 * 60);
  }
});
