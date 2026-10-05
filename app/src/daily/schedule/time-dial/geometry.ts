import { nextDate } from '../time.ts';
import type {
  ArcPiece,
  DialFragment,
  DialGeometryPort,
  DialHalf,
  DialHit,
  DialLanding,
  DialMetrics,
  DialPose,
  DialViewport,
  HitAnchor,
  LogicalPoint,
} from './types.ts';

const HALF_MINUTES = 720; // 12 hours expressed in 5-minute units
const DAY_MINUTES = 1440; // 24 hours expressed in 5-minute units
const HIT_MIN_RADIUS = 70;
const HIT_MAX_RADIUS = 185;
const HALF_BOUNDARY = 113; // no anchor: inner below this, outer above
const INNER_ANCHOR_OUTER = 119; // while anchored inner, cross above this to reach outer
const OUTER_ANCHOR_INNER = 107; // while anchored outer, cross below this to reach inner
const OUTSIDE_RADIUS = 190;
const PULL_DISTANCE = 45;

export const defaultMetrics: DialMetrics = {
  width: 400,
  height: 400,
  centerX: 200,
  centerY: 200,
  innerRadius: 94,
  outerRadius: 132,
  startRadius: 145,
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Point on the ring for a clockwise-from-top angle. Degrees 0 = top, 90 = right. */
function polar(radius: number, degrees: number, m: DialMetrics): { x: number; y: number } {
  const rad = (degrees * Math.PI) / 180;
  return { x: m.centerX + radius * Math.sin(rad), y: m.centerY - radius * Math.cos(rad) };
}

function radiusFor(half: DialHalf, m: DialMetrics): number {
  return half === 'inner' ? m.innerRadius : m.outerRadius;
}

export const geometry: DialGeometryPort = {
  // The 400x400 logical dial is centered (letterboxed) inside the viewport, then scaled.
  toLogical(point: LogicalPoint, viewport: DialViewport): LogicalPoint {
    const scale = Math.min(viewport.width, viewport.height) / 400;
    const offsetX = (viewport.width - 400 * scale) / 2;
    const offsetY = (viewport.height - 400 * scale) / 2;
    return { x: (point.x - offsetX) / scale, y: (point.y - offsetY) / scale };
  },

  pose(focus: number): DialPose {
    return { focus, rotationDegrees: 180 - (focus / HALF_MINUTES) * 360 };
  },

  // angularDelta is the shortest signed difference [-180,180]; one degree == two 5-minute units.
  rotate(focus: number, angularDelta: number): number {
    return clamp(Math.round(focus - angularDelta * 2), 0, DAY_MINUTES);
  },

  hit(
    point: LogicalPoint,
    pose: DialPose,
    metrics: DialMetrics,
    anchor: HitAnchor | null,
  ): DialHit | null {
    const dx = point.x - metrics.centerX;
    const dy = point.y - metrics.centerY;
    const radius = Math.hypot(dx, dy);
    if (radius < HIT_MIN_RADIUS || radius > HIT_MAX_RADIUS) return null;

    let half: DialHalf;
    if (anchor) {
      if (anchor.half === 'inner') half = radius > INNER_ANCHOR_OUTER ? 'outer' : 'inner';
      else half = radius < OUTER_ANCHOR_INNER ? 'inner' : 'outer';
    } else {
      half = radius < HALF_BOUNDARY ? 'inner' : 'outer';
    }

    // Clockwise degrees from top: atan2(dx, -dy). Top 0, right 90, bottom 180, left 270.
    const angle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const rotationDegrees = 180 - (pose.focus / HALF_MINUTES) * 360;
    const phase = ((((angle - rotationDegrees) % 360) + 360) % 360) * 2;
    const anchorMinute =
      anchor && anchor.half === half
        ? anchor.minuteOfHalf
        : pose.focus === DAY_MINUTES && half === 'outer'
          ? HALF_MINUTES
          : pose.focus % HALF_MINUTES;
    // Unwrap phase onto the copy nearest the anchor, then bound to the half.
    const minuteOfHalf = clamp(
      phase + Math.round((anchorMinute - phase) / HALF_MINUTES) * HALF_MINUTES,
      0,
      HALF_MINUTES,
    );
    const totalMinute = half === 'inner' ? minuteOfHalf : HALF_MINUTES + minuteOfHalf;
    return { half, angle: (angle + 360) % 360, minuteOfHalf, totalMinute };
  },

  landing(hit: DialHit, date: string): DialLanding {
    const snapped = clamp(Math.round(hit.totalMinute / 5) * 5, 0, DAY_MINUTES);
    if (snapped === DAY_MINUTES) {
      return { date: nextDate(date), minuteOfDay: 0, half: 'inner' };
    }
    return { date, minuteOfDay: snapped, half: snapped < HALF_MINUTES ? 'inner' : 'outer' };
  },

  arcPath(half: DialHalf, startMinute: number, endMinute: number, metrics: DialMetrics): string {
    const radius = radiusFor(half, metrics);
    const start = (startMinute / HALF_MINUTES) * 360;
    const end = (endMinute / HALF_MINUTES) * 360;
    if (end - start >= 359.999) {
      const a = polar(radius, start, metrics);
      const b = polar(radius, start + 180, metrics);
      return `M${a.x} ${a.y} A${radius} ${radius} 0 1 1 ${b.x} ${b.y} A${radius} ${radius} 0 1 1 ${a.x} ${a.y}`;
    }
    const a = polar(radius, start, metrics);
    const b = polar(radius, end, metrics);
    return `M${a.x} ${a.y} A${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${b.x} ${b.y}`;
  },

  arcs(fragment: DialFragment, metrics: DialMetrics): readonly ArcPiece[] {
    const half: DialHalf = fragment.startMinute < HALF_MINUTES ? 'inner' : 'outer';
    const radius = radiusFor(half, metrics);
    const s = fragment.startMinute % HALF_MINUTES;
    let e = fragment.endMinute % HALF_MINUTES;
    if (fragment.endMinute % HALF_MINUTES === 0 && fragment.endMinute > fragment.startMinute) {
      e = HALF_MINUTES;
    }
    const toPiece = (deg: number, largeArc: number): ArcPiece => {
      const p = polar(radius, deg, metrics);
      return { x: p.x, y: p.y, radius, largeArc, sweep: 1 };
    };
    if (e - s >= HALF_MINUTES - 0.001) {
      // Full circle cannot be one SVG arc; return two half-circle endpoints.
      return [
        toPiece(((s + HALF_MINUTES / 2) / HALF_MINUTES) * 360, 1),
        toPiece((s / HALF_MINUTES) * 360, 1),
      ];
    }
    return [toPiece((e / HALF_MINUTES) * 360, e - s > HALF_MINUTES / 2 ? 1 : 0)];
  },

  pulledOutside(startRadius: number, currentRadius: number): boolean {
    return currentRadius >= OUTSIDE_RADIUS && currentRadius - startRadius >= PULL_DISTANCE;
  },
};
