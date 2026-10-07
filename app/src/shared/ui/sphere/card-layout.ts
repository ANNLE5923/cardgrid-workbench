/**
 * Pure layout math for the neutral sphere / matrix visuals (C0.8).
 * No DOM, no React, no workspace access — node-safe and unit tested.
 */

export type SpherePoint = Readonly<{
  index: number;
  /** Unit vector times radius. */
  x: number;
  y: number;
  z: number;
  /** CSS angles (deg) for: rotateY(azimuth) rotateX(elevation) translateZ(radius). */
  azimuth: number;
  elevation: number;
}>;

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const RAD2DEG = 180 / Math.PI;
const clamp1 = (v: number) => Math.min(1, Math.max(-1, v));

/** Evenly distribute points on a sphere (Fibonacci lattice), facing outward. */
export function spherePoints(count: number, radius: number): readonly SpherePoint[] {
  const n = Math.max(0, Math.floor(count));
  const points: SpherePoint[] = [];
  for (let i = 0; i < n; i++) {
    const t = n <= 1 ? 0 : i / (n - 1);
    const y = 1 - 2 * t;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = GOLDEN_ANGLE * i;
    const x = Math.cos(theta) * ring;
    const z = Math.sin(theta) * ring;
    points.push({
      index: i,
      x: x * radius,
      y: y * radius,
      z: z * radius,
      azimuth: Math.atan2(x, z) * RAD2DEG,
      elevation: Math.asin(clamp1(-y)) * RAD2DEG,
    });
  }
  return points;
}

export type GridDims = Readonly<{ rows: number; cols: number }>;

/** Near-square grid dimensions for a given item count. */
export function gridDims(count: number, maxCols?: number): GridDims {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return { rows: 0, cols: 0 };
  const ideal = Math.ceil(Math.sqrt(n));
  const cols = maxCols ? Math.min(ideal, maxCols) : ideal;
  return { rows: Math.ceil(n / cols), cols };
}

/** Stable per-cell wave phase (radians) so the matrix ripples in reading order. */
export function wavePhase(index: number, cols: number): number {
  const row = Math.floor(index / Math.max(1, cols));
  const col = index % Math.max(1, cols);
  return (row + col) * 0.6;
}
