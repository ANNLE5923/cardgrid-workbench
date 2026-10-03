/**
 * 3A-dial-1 design contract. Type declarations only, never a production Host.
 * See 11-3A正式投影几何与手势合同.md for invariants and execution order.
 */
import type {
  CardView, Command, FactView, LegacyRef, PlacementPreview, PlacementSubject,
  ProductionDayView, Range, Result, Segment, Token, VersionRef,
} from '../../src/workspace/contracts.ts';
import type { WorkspaceSnapshot } from '../../src/workspace/commands.ts';

export type Half = 0 | 1;
export type Point = Readonly<{ x: number; y: number }>;
export type Viewport = Readonly<{ left: number; top: number; width: number; height: number }>;
/** Absolute local reading, 0..1440 inclusive; never modulo the stored value. */
export type DialFocus = Readonly<{ minuteOfDay: number }>;
export type DialPose = Readonly<{ focus: DialFocus; rotationDegrees: number }>;
export type DialMetrics = Readonly<{
  size: 400; center: Point; innerRadius: number; outerRadius: number;
  captureInnerRadius: number; captureOuterRadius: number;
  halfDividerRadius: number; halfHysteresis: number;
  pullExitRadius: number; pullTravel: number;
}>;
/** next-day zero is explicit, never sent as minute 1440 to the Host. */
export type Landing = Readonly<{
  date: string; zone: string; focusMinuteOfDay: number; half: Half;
  originDate: string; dayShift: 0 | 1;
}>;
export type DialSource =
  | Readonly<{ kind: 'plan'; plan: VersionRef; instance: VersionRef }>
  | Readonly<{ kind: 'fixed'; commitment: VersionRef }>
  | Readonly<{ kind: 'fact'; factId: string }>
  | Readonly<{ kind: 'projected-readonly'; sourceId: string }>
  | Readonly<{ kind: 'legacy'; source: LegacyRef }>
  | Readonly<{ kind: 'empty'; derivedKey: string }>;
/** JSON tuple key; versions are capabilities, not replacements for source identity. */
export type SourceKey = string;
export type DialFragment = Readonly<{
  key: string; sourceKey: SourceKey; role: Segment['kind'] | 'legacy';
  half: Half; startMinuteOfHalf: number; endMinuteOfHalf: number;
  clippedRange: Range; sourceRange: Range; startDate: string; offset: string;
  continuesBefore: boolean; continuesAfter: boolean;
}>;
export type DialAction =
  | 'inspect' | 'move-plan' | 'retract-plan' | 'confirm-actual'
  | 'unlock-fixed' | 'open-fact' | 'prepare-day';
export type DialItem = Readonly<{
  key: SourceKey; source: DialSource; title: string; description: string | null;
  color: string | null; fragments: readonly DialFragment[]; actions: readonly DialAction[];
}>;
export type AxisPiece = Readonly<{
  key: string; half: Half; startMinuteOfHalf: number; endMinuteOfHalf: number;
  offset: string; range: Range;
}>;
export type DialScene = Readonly<{
  token: Token; date: string; zone: string; now: string; dayRange: Range;
  mode: ProductionDayView['mode']; occupancyKnown: boolean;
  items: readonly DialItem[]; hand: readonly CardView[];
  axis: readonly AxisPiece[]; freeRanges: ProductionDayView['freeRanges'];
  facts: readonly FactView[];
}>;
export type DialSceneResult =
  | Readonly<{ ok: true; scene: DialScene }>
  | Readonly<{ ok: false; code: 'METADATA_STALE' | 'INCONSISTENT_PROJECTION'; message: string }>;

export interface DialProjectionPort {
  /** Read-only join. Optional metadata must have exactly the DayView token. */
  buildScene(day: ProductionDayView, metadata?: WorkspaceSnapshot): DialSceneResult;
  /** Return ALL matching fragment keys; half-open intervals, no current-day hit at 1440. */
  focusFragments(scene: DialScene, focus: DialFocus): readonly string[];
  /** 24 wall-hour rows, repeated offsets retained, references never counted as occupancy. */
  hourOverview(scene: DialScene, hour: number): readonly DialItem[];
}

export type PolarHit = Readonly<{
  half: Half; radius: number; angleDegrees: number;
  /** 0..720; the seam uses the gesture anchor to distinguish start and end. */
  minuteOfHalf: number;
}>;
export type ArcPiece = Readonly<{
  fragmentKey: string; radius: number; start: Point; end: Point; sweepDegrees: number;
  largeArc: 0 | 1; sweep: 1;
}>;
export interface DialGeometryPort {
  toLogical(point: Point, viewport: Viewport): Point | null;
  pose(focus: DialFocus): DialPose;
  rotate(focus: DialFocus, angularDeltaDegrees: number): DialFocus;
  /** Inverse screen transform plus ring hysteresis. A seam anchor is mandatory. */
  hit(point: Point, pose: DialPose, metrics: DialMetrics,
    anchor: Readonly<{ half: Half; minuteOfHalf: number }> | null): PolarHit | null;
  /** Round the start to 5 minutes, normalize noon/day-end, keep the preset duration intact. */
  landing(hit: PolarHit, date: string, zone: string): Landing;
  /** 720-minute full circles become two SVG arc commands. */
  arcs(fragment: DialFragment, metrics: DialMetrics): readonly ArcPiece[];
  pulledOutside(startRadius: number, currentRadius: number, metrics: DialMetrics): boolean;
}
export type AckBinding = Readonly<{ previewId: string; candidateId: string }>;
export type PlacementSession = Readonly<{
  generation: number; subject: PlacementSubject; landing: Landing;
  originView: Readonly<{ date: string; zone: string; focus: DialFocus }>;
}> & (
  | Readonly<{ phase: 'pending'; requestSerial: number }>
  | Readonly<{ phase: 'ready'; preview: PlacementPreview; selectedCandidateId: string | null; acknowledgement: AckBinding | null }>
  | Readonly<{ phase: 'error'; failure: Exclude<Result<never>, { ok: true }>; retryCommand: Extract<Command, { type: 'CommitPlacement' }> | null; preview: PlacementPreview | null; selectedCandidateId: string | null; acknowledgement: AckBinding | null }>
  | Readonly<{ phase: 'submitting'; preview: PlacementPreview; command: Extract<Command, { type: 'CommitPlacement' }> }>
);
/** View components emit intent; only the existing DayBoard controller talks to the Host. */
export type DialIntent =
  | Readonly<{ type: 'focus'; focus: DialFocus }>
  | Readonly<{ type: 'reset-now' }>
  | Readonly<{ type: 'inspect-card'; instanceId: string }>
  | Readonly<{ type: 'inspect-items'; itemKeys: readonly SourceKey[] }>
  | Readonly<{ type: 'open-overview'; hour: number }>
  | Readonly<{ type: 'preview'; subject: PlacementSubject; landing: Landing }>
  | Readonly<{ type: 'select-candidate'; previewId: string; candidateId: string }>
  | Readonly<{ type: 'acknowledge'; binding: AckBinding; checked: boolean }>
  | Readonly<{ type: 'commit'; previewId: string; candidateId: string }>
  | Readonly<{ type: 'cancel-preview' }>
  | Readonly<{ type: 'retract-plan'; plan: VersionRef }>
  | Readonly<{ type: 'unlock-fixed'; commitment: VersionRef }>
  | Readonly<{ type: 'confirm-actual'; itemKey: SourceKey }>
  | Readonly<{ type: 'record-hand-actual'; instance: VersionRef }>
  | Readonly<{ type: 'open-fact'; factId: string }>;

export type TimeDialProps = Readonly<{
  scene: DialScene; focus: DialFocus; session: PlacementSession | null;
  selectedItemKeys: readonly SourceKey[]; busy: boolean;
  onIntent: (intent: DialIntent) => void;
}>;
export type DayOverviewProps = Readonly<{
  scene: DialScene; hour: number; onClose: () => void;
}>;
export type CardDragEvent = Readonly<{
  phase: 'start' | 'move' | 'end' | 'cancel'; instanceId: string; pointerId: number;
  clientPoint: Point; cardTopEdgeClientPoint: Point;
}>;
export type HandFanProps = Readonly<{
  hand: readonly CardView[]; inspectedInstanceId: string | null;
  busy: boolean; onIntent: (intent: DialIntent) => void;
  onDrag: (event: CardDragEvent) => void;
}>;
/** Frozen interfaces constrain effects; pointer recognition thresholds remain 3E tuning. */
export type ViewMode = 'follow-now' | 'manual';
export type GestureOwner = 'dial' | 'card' | 'preview' | 'saved-plan';
export type GestureSession = Readonly<{
  pointerId: number; owner: GestureOwner; generation: number; token: Token;
  start: Point; previousAngleDegrees: number; startRadius: number;
  originFocus: DialFocus; cancelled: boolean;
}>;
