import type { Id, ProductionDayView, Range } from '../../../workspace/index.ts';

export type DialSource =
  | 'plan'
  | 'fixed'
  | 'fact'
  | 'plan-reference'
  | 'empty'
  | 'legacy'
  | 'projected-readonly';
export type DialHalf = 'inner' | 'outer';
export type LogicalPoint = Readonly<{ x: number; y: number }>;
export type DialViewport = Readonly<{ width: number; height: number }>;

/** One continuous arc within a single half of a single day (5-minute units, 0..720 per half). */
export type DialFragment = Readonly<{
  source: DialSource;
  id: Id;
  title: string;
  color: string;
  startMinute: number;
  endMinute: number;
  range?: Range;
  dayStart?: string;
  dayEnd?: string;
  detail?: string;
  sourceRefs?: readonly Id[];
  readOnly?: boolean;
  legacy?: boolean;
  projected?: boolean;
}>;

/** All fragments of one source (a plan / fixed / fact), possibly across the day boundary. */
export type DialItem = Readonly<{
  source: DialSource;
  id: Id;
  title: string;
  color: string;
  startMinute: number;
  endMinute: number;
  fragments: readonly DialFragment[];
  range?: Range;
  detail?: string;
  sourceRefs?: readonly Id[];
  readOnly?: boolean;
  legacy?: boolean;
  projected?: boolean;
}>;

export type AxisPiece = Readonly<{
  half: DialHalf;
  label: string;
  startMinute: number;
  endMinute: number;
}>;

export type DialScene = Readonly<{
  date: string;
  zone: string;
  /** Authority token this scene was projected from; used to reject stale previews/actions. */
  token: ProductionDayView['token'];
  dayRange: Readonly<{ start: string; end: string }>;
  items: readonly DialItem[];
  axis: readonly AxisPiece[];
  hand: ProductionDayView['hand'];
  freeRanges: ProductionDayView['freeRanges'];
  facts: ProductionDayView['facts'];
  /** Raw legacy entries are always retained, even when a range cannot be placed on the ring. */
  legacyItems: ProductionDayView['legacyItems'];
  now: ProductionDayView['now'];
  occupancyKnown: boolean;
  legacy: boolean;
  projected: boolean;
  version: string;
  source: string;
}>;

export type DialPose = Readonly<{ focus: number; rotationDegrees: number }>;
export type HitAnchor = Readonly<{ half: DialHalf; minuteOfHalf: number }>;
export type DialHit = Readonly<{
  half: DialHalf;
  angle: number;
  minuteOfHalf: number;
  totalMinute: number;
}>;
export type DialLanding = Readonly<{ date: string; minuteOfDay: number; half: DialHalf }>;
export type DialMetrics = Readonly<{
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  innerRadius: number;
  outerRadius: number;
  startRadius: number;
}>;
export type ArcPiece = Readonly<{
  x: number;
  y: number;
  radius: number;
  largeArc: number;
  sweep: number;
}>;

/** Geometry port: coordinate transforms, arcs, hits, bounds. Never issues credentials or saves. */
export type DialGeometryPort = Readonly<{
  toLogical(point: LogicalPoint, viewport: DialViewport): LogicalPoint;
  pose(focus: number): DialPose;
  rotate(focus: number, angularDelta: number): number;
  hit(
    point: LogicalPoint,
    pose: DialPose,
    metrics: DialMetrics,
    anchor: HitAnchor | null,
  ): DialHit | null;
  landing(hit: DialHit, date: string): DialLanding;
  /** SVG path for an arc inside one half [startMinute, endMinute] in 5-minute units. */
  arcPath(half: DialHalf, startMinute: number, endMinute: number, metrics: DialMetrics): string;
  arcs(fragment: DialFragment, metrics: DialMetrics): readonly ArcPiece[];
  pulledOutside(startRadius: number, currentRadius: number): boolean;
}>;

export type DialProjectionPort = Readonly<{
  buildScene(day: ProductionDayView): DialScene;
  focusFragments(scene: DialScene, focus: number): readonly DialFragment[];
  hourOverview(scene: DialScene, hour: number): readonly DialItem[];
}>;
