// 3G.5: run the design-time 3A regression vectors against the real geometry, time and
// projection modules. Vectors come from docs/产品设计/3A-regression-vectors.json.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { defaultMetrics, geometry } from '../src/components/time-dial/geometry.ts';
import type { HitAnchor } from '../src/components/time-dial/types.ts';
import { dayRange, displayInstant, elapsedMinutes, splitRangeForDay } from '../src/action-time.ts';
import { compatibilityFor, projectDay } from '../src/action-projection.ts';
import { overlaps } from '../src/action-domain.ts';
import type { WorkspaceSnapshot } from '../src/action-commands.ts';
import type { DataV2 } from '../src/action-contract.ts';
import { blank, content, shanghai } from './fixtures/action/independent.ts';

const vectors = JSON.parse(
  fs.readFileSync(new URL('../docs/产品设计/3A-regression-vectors.json', import.meta.url), 'utf8'),
);
const NOW0 = '2026-10-01T00:00:00Z';
const halfWord = (h: number): 'inner' | 'outer' => (h === 0 ? 'inner' : 'outer');

test('rotation vectors', () => {
  for (const v of vectors.rotation)
    assert.equal(geometry.pose(v.focus).rotationDegrees, v.rotation);
});

test('arc vectors (degrees and units)', () => {
  for (const v of vectors.arc) {
    assert.equal(v.minutes / 2, v.degrees);
    assert.equal(v.minutes % 5 === 0 ? v.minutes / 5 : null, v.units);
  }
});

test('rotate vectors across the 0/360 seam', () => {
  const shortest = (a: number, b: number) => {
    let d = b - a;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  };
  for (const v of vectors.rotate)
    assert.equal(geometry.rotate(v.focus, shortest(v.previous, v.next)), v.expected);
});

test('landing vectors (grid snap, noon and day-end D023)', () => {
  for (const v of vectors.landing) {
    const l = geometry.landing({ totalMinute: v.minute } as never, v.date);
    assert.deepEqual(
      { date: l.date, minute: l.minuteOfDay, half: l.half === 'inner' ? 0 : 1 },
      { date: v.expectedDate, minute: v.expectedMinute, half: v.half },
    );
  }
});

function sliceRows(source: Parameters<typeof splitRangeForDay>[0], date: string, zone: string) {
  return splitRangeForDay(source, date, zone).map(s => {
    const startMin = displayInstant(s.range.startAt, zone).minute - s.half * 720;
    return [s.half, startMin, startMin + elapsedMinutes(s.range), s.offset, s.continuesBefore, s.continuesAfter];
  });
}

test('projection vectors (cross-day and DST slices)', () => {
  for (const v of vectors.projection) {
    const source = { startAt: v.start, endAt: v.end, zone: v.zone };
    assert.deepEqual(sliceRows(source, v.date, v.zone), v.expected);
  }
});

test('axis vectors (valid wall-time intervals)', () => {
  for (const v of vectors.axis) {
    const rows = sliceRows(dayRange(v.date, v.zone), v.date, v.zone).map(r => r.slice(0, 4));
    assert.deepEqual(rows, v.expected);
  }
});

test('surface vectors (letterboxed logical scaling)', () => {
  for (const v of vectors.surface) {
    const p = geometry.toLogical({ x: v.point[0], y: v.point[1] }, { width: v.width, height: v.height });
    assert.deepEqual(
      [Math.round(p.x * 1e6) / 1e6, Math.round(p.y * 1e6) / 1e6],
      v.expected,
    );
  }
});

test('pull vectors (outside pull threshold)', () => {
  for (const v of vectors.pull)
    assert.equal(geometry.pulledOutside(v.start, v.current), v.expected);
});

test('hit vectors (half boundary and anchors)', () => {
  for (const v of vectors.hit) {
    const anchor: HitAnchor | null = v.anchor
      ? { half: halfWord(v.anchor.half), minuteOfHalf: v.anchor.minuteOfHalf }
      : null;
    const h = geometry.hit({ x: v.point[0], y: v.point[1] }, geometry.pose(v.focus), defaultMetrics, anchor);
    assert.deepEqual(
      h ? { half: h.half === 'inner' ? 0 : 1, minute: h.minuteOfHalf } : { half: null, minute: null },
      { half: v.half, minute: v.minute },
    );
  }
});

function crowdedData(): DataV2 {
  const c = vectors.crowded;
  const data = blank();
  data.settings.zone = c.zone;
  const instances: DataV2['planner']['instances'] = [];
  const plans: DataV2['planner']['plans'] = [];
  const fixed: DataV2['planner']['fixed'] = [];
  const facts: DataV2['planner']['facts'] = [];
  for (const b of c.blocks) {
    const r = shanghai(b.start, b.minutes, c.date);
    if (b.kind === 'fixed') {
      fixed.push({ id: b.id, version: 1, title: b.id, range: r, cancelled: false, ownerDate: c.date,
        template: null, templateEntryId: null, manuallyOverridden: false, source: { kind: 'manual' } });
    } else {
      const instId = `inst-${b.id}`;
      instances.push({ id: instId, version: 1, definition: null, creationSnapshot: content(b.minutes),
        currentContent: content(b.minutes), source: { kind: 'manual' }, createdAt: NOW0, targetDate: null,
        state: 'open', occurrenceId: null, makeupOf: null });
      if (b.kind === 'plan')
        plans.push({ id: b.id, version: 1, instanceId: instId, range: r, contentSnapshot: content(b.minutes),
          status: 'active', createdAt: NOW0, changedAt: NOW0 });
      else
        facts.push({ id: b.id, instanceId: instId, contentSnapshot: content(b.minutes), actualRange: r,
          confirmedAt: NOW0, source: { kind: 'manual' }, plannedSnapshot: null });
    }
  }
  data.planner.instances = instances;
  data.planner.plans = plans;
  data.planner.fixed = fixed;
  data.planner.facts = facts;
  return data;
}

test('crowded free gaps', () => {
  const c = vectors.crowded;
  const snap = { mode: 'current', token: { epoch: 'crowded', revision: 1 }, data: crowdedData(), raw: null, rawKey: '' } as unknown as WorkspaceSnapshot;
  const view = projectDay(snap, { date: c.date, zone: c.zone }, '2026-10-01T17:00:00Z');
  const gaps = view.freeRanges.map(r => {
    const s = displayInstant(r.startAt, c.zone);
    return [s.time, displayInstant(r.endAt, c.zone).time, elapsedMinutes(r)];
  });
  for (const required of c.requiredGaps)
    assert.ok(gaps.some(g => g[0] === required[0] && g[1] === required[1] && g[2] === required[2]),
      `missing gap ${JSON.stringify(required)}`);
});

test('crowded attempted placement blocker', () => {
  const c = vectors.crowded;
  const data = crowdedData();
  const r = shanghai(c.attemptedPlacement.start, c.attemptedPlacement.minutes, c.date);
  assert.ok(r.localEnd.endsWith(c.attemptedPlacement.expectedEnd.slice(-5)));
  const conflicts = overlaps(data, r, undefined, compatibilityFor(data, r));
  assert.deepEqual(conflicts.map(x => x.id), c.attemptedPlacement.expectedBlockerIds);
});

test('crowded overlap focus sources', () => {
  const c = vectors.crowded;
  const snap = { mode: 'current', token: { epoch: 'crowded', revision: 1 }, data: crowdedData(), raw: null, rawKey: '' } as unknown as WorkspaceSnapshot;
  const view = projectDay(snap, { date: c.date, zone: c.zone }, '2026-10-01T17:00:00Z');
  const m = c.overlapFocus.minute;
  const ids = view.segments
    .filter(s => s.sourceId !== null && s.kind !== 'empty')
    .filter(s => {
      const st = s.half * 720 + s.startMinuteOfHalf;
      const en = s.half * 720 + s.endMinuteOfHalf;
      return st <= m && m < en;
    })
    .map(s => s.sourceId)
    .sort();
  assert.deepEqual(ids, [...c.overlapFocus.expectedSourceIds].sort());
});
