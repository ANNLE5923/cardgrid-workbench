import type { HitAnchor, LogicalPoint } from './types.ts';
import { geometry, defaultMetrics } from './geometry.ts';

const HALF_MINUTES = 720;

/**
 * Pure gesture/fan math. No React, no Host calls, no writes.
 * The React layer (HandFan / use-placement-session) calls these so pointer,
 * wheel, keyboard and buttons all share the same decisions.
 */

// Per-card fan angle (degrees), centered on the bottom. At most maxCards are shown per page.
export function fanLayout(
  count: number,
  options?: Readonly<{ maxCards?: number; perCard?: number; maxSpread?: number }>,
): number[] {
  const shown = Math.max(0, Math.min(count, options?.maxCards ?? 4));
  if (shown <= 1) return shown === 0 ? [] : [0];
  const perCard = options?.perCard ?? 13;
  const spread = Math.min(options?.maxSpread ?? 64, perCard * (shown - 1));
  return Array.from({ length: shown }, (_, i) => -spread / 2 + (spread / (shown - 1)) * i);
}

// Shortest signed difference between two screen angles, unwrapped to [-180,180].
export function shortestAngle(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

// Shared rotate intent for wheel / keys / drag.
export function rotateFocus(focus: number, angularDelta: number): number {
  return geometry.rotate(focus, angularDelta);
}

// Map a logical pointer position to a placement hit, carrying the seam anchor.
export function dragHit(point: LogicalPoint, focus: number, anchor: HitAnchor | null) {
  return geometry.hit(point, geometry.pose(focus), defaultMetrics, anchor);
}

// Reclaim a card only when it is pulled beyond the dial by the required distance.
export function isReclaim(startRadius: number, currentRadius: number): boolean {
  return geometry.pulledOutside(startRadius, currentRadius);
}

// Convert a client point over the dial element rect into logical 400x400 coordinates.
export function clientPointToLogical(
  clientX: number,
  clientY: number,
  rect: DOMRect,
): LogicalPoint {
  return geometry.toLogical(
    { x: clientX - rect.left, y: clientY - rect.top },
    { width: rect.width, height: rect.height },
  );
}

export { HALF_MINUTES };

/** Entry is measured at the translated card TOP EDGE, independent of the grab point. */
export type HandEntryState = {
  entered: boolean; entryY: number; entryRadius: number; innerEnabled: boolean; anchor: HitAnchor | null;
};
export const emptyHandEntry = (): HandEntryState => ({
  entered: false, entryY: 0, entryRadius: -1, innerEnabled: false, anchor: null,
});

/** Sweep the real edge trajectory so a fast event crossing the whole band still enters it. */
export function advanceHandEntry(previous: LogicalPoint, point: LogicalPoint, focus: number, initial: HandEntryState) {
  const state = { ...initial };
  let hit: ReturnType<typeof dragHit> = null;
  const steps = Math.max(1, Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / 2));
  for (let i = 1; i <= steps; i++) {
    const p = { x: previous.x + (point.x - previous.x) * i / steps,
      y: previous.y + (point.y - previous.y) * i / steps };
    const dx = p.x - 200, dy = p.y - 200, radius = Math.hypot(dx, dy);
    if (!state.entered) {
      if (radius > defaultMetrics.startRadius || radius < 70) continue;
      state.entered = true; state.entryY = p.y; state.entryRadius = radius;
      state.anchor = { half: 'outer', minuteOfHalf: focus % HALF_MINUTES };
    }
    if (state.entryY - p.y >= 75) state.innerEnabled = true;
    let target = p;
    if (!state.innerEnabled) {
      if (radius > 185 || radius === 0) continue;
      target = { x: 200 + dx * defaultMetrics.outerRadius / radius,
        y: 200 + dy * defaultMetrics.outerRadius / radius };
    } else if (radius < 70 && radius > 0) {
      // Keep the last band angle while an edge overshoots the small inner hit band.
      target = { x: 200 + dx * 70.01 / radius, y: 200 + dy * 70.01 / radius };
    }
    const next = dragHit(target, focus, state.anchor);
    if (next) { hit = next; state.anchor = { half: next.half, minuteOfHalf: next.minuteOfHalf }; }
  }
  return { state, hit };
}
