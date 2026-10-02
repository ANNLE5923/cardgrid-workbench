/** 1F-prototype-2: source versions and day continuation; synthetic adapter contract, not a storage schema. */
export type Id = string;
export type LocalDate = string; // YYYY-MM-DD, validated by Host
export type Instant = string; // canonical UTC ISO string, validated by Host
export type Token = Readonly<{ epoch: string; revision: number }>;
export type Range = Readonly<{ startAt: Instant; endAt: Instant; zone: string }>;
export type LocalInput = Readonly<{
  date: LocalDate; time: string; zone: string; offset?: string;
}>;
export type ErrorCode =
  | 'INVALID_INPUT' | 'INVALID_GRID' | 'DURATION_REQUIRED'
  | 'NONEXISTENT_LOCAL_TIME' | 'AMBIGUOUS_LOCAL_TIME' | 'AMBIGUOUS_DAY_TEMPLATE'
  | 'SLOT_OCCUPIED' | 'NO_AVAILABLE_SLOT' | 'REVISION_CONFLICT'
  | 'WORKSPACE_REPLACED' | 'FACT_LOCKED' | 'ALREADY_CONFIRMED'
  | 'ALREADY_PLANNED' | 'FIXED_LOCKED' | 'PREVIEW_STALE'
  | 'OVERLAP_CONFIRMATION_REQUIRED'
  | 'COMMAND_ID_REUSED' | 'STORAGE_FAILED';
export type Failure = Readonly<{
  ok: false; code: ErrorCode; message: string; field?: string;
  conflicts?: readonly Blocker[]; existingFactId?: Id;
  choices?: readonly Readonly<{ input: LocalInput; instant: Instant }>[];
  retry: 'edit' | 'preview' | 'reload' | 'same-command' | 'none';
}>;
export type Result<T> = Readonly<{ ok: true; value: T }> | Failure;
export type Blocker = Readonly<{
  id: Id; kind: 'fixed' | 'plan' | 'fact' | 'template-projection';
  title: string; range: Range; overlap: Range;
}>;
export type Policies = Readonly<{
  status: 'user-decided';
  actualPrecision: 'minute'; allowFutureActualEnd: true;
  confirmedOccupancy: 'actual-only';
  dayEnd: 'automatic-recompute';
  placementOverlap: 'explicit-acknowledgement';
}>;
export type CardView = Readonly<{
  instanceId: Id; version: number; title: string; criteria: string;
  presetMinutes: number | null; color: string; targetDate: LocalDate | null;
}>;
export type Segment = Readonly<{
  id: Id; sourceId: Id | null; // null only for derived empty-time segments
  kind: 'fixed' | 'plan' | 'fact' | 'plan-reference' | 'empty';
  title: string; sourceRange: Range; clippedRange: Range;
  startDate: LocalDate; half: 0 | 1;
  startMinuteOfHalf: number; endMinuteOfHalf: number;
  label: string; offsetLabel: string; locked: boolean;
  continuesBefore: boolean; continuesAfter: boolean;
}>;
export type PlanView = Readonly<{
  planId: Id; version: number; instanceId: Id; instanceVersion: number; range: Range;
}>;
export type FixedView = Readonly<{ commitmentId: Id; version: number; range: Range }>;
export type FactView = Readonly<{
  factId: Id; instanceId: Id; title: string; criteria: string;
  actualRange: Range; plannedRange: Range | null; confirmedAt: Instant;
  annotations: readonly Readonly<{ id: Id; text: string; createdAt: Instant }>[];
}>;
export type DayView = Readonly<{
  token: Token; date: LocalDate; zone: string; now: Instant;
  dayRange: Range; hand: readonly CardView[]; segments: readonly Segment[];
  facts: readonly FactView[];
  plans: readonly PlanView[]; fixed: readonly FixedView[];
  freeRanges: readonly Range[]; policies: Policies;
}>;
export type PlacementSubject =
  | Readonly<{ kind: 'hand'; instanceId: Id; version: number }>
  | Readonly<{ kind: 'plan'; planId: Id; version: number }>
  | Readonly<{ kind: 'fixed'; commitmentId: Id; version: number; unlockId: Id }>;
export type PlacementQuery = Readonly<{
  token: Token; subject: PlacementSubject; date: LocalDate; zone: string;
  focusMinuteOfDay: number; // 0..1435, multiple of 5; one absolute local-time landing
}>;
export type Candidate = Readonly<{
  id: Id; half: 0 | 1; range: Range; label: string; offsetLabel: string;
  units: number; segments: readonly Segment[];
}> & (
  | Readonly<{ state: 'valid' }>
  | Readonly<{ state: 'conflict'; blockers: readonly Blocker[]; reason: string; acknowledgementId: Id }>
);
export type PlacementPreview = Readonly<{
  previewId: Id; token: Token; query: PlacementQuery;
  candidates: readonly Candidate[];
  unresolved: readonly Readonly<{
    half: 0 | 1; code: 'NONEXISTENT_LOCAL_TIME' | 'AMBIGUOUS_LOCAL_TIME';
    message: string;
  }>[];
}>;
export type ActualDraft = Readonly<{
  instanceId: Id; instanceVersion: number; start: LocalInput; end: LocalInput;
}> & (
  | Readonly<{ mode: 'planned'; planId: Id; planVersion: number }>
  | Readonly<{ mode: 'unplanned' }>
);
export type ActualPreview = Readonly<{
  previewId: Id; token: Token; draft: ActualDraft; range: Range;
  title: string; criteria: string; plannedRange: Range | null;
  conflicts: readonly Blocker[]; acknowledgementId: Id | null;
}>;
export type Payloads = {
  CommitPlacement: Readonly<{ previewId: Id; candidateId: Id; acknowledgedOverlap: Id | null }>;
  RetractPlan: Readonly<{ planId: Id; version: number }>;
  ReorderHand: Readonly<{ instanceIds: readonly Id[] }>;
  ConfirmActual: Readonly<{ previewId: Id; acknowledgedOverlap: Id | null }>;
  AppendAnnotation: Readonly<{ factId: Id; text: string }>;
};
export type Command = {
  [K in keyof Payloads]: Readonly<{
    commandId: Id; expected: Token; type: K; payload: Payloads[K];
  }>
}[keyof Payloads];
export type SubmitResult = Result<Readonly<{
  token: Token; resultRefs: readonly Id[]; replayed: boolean;
}>>;
export interface PrototypeHost {
  /** Queries are pure. Projections share the same source and occupancy rules. */
  readDay(input: Readonly<{ date: LocalDate; zone: string }>): Result<DayView>;
  previewPlacement(input: PlacementQuery): Result<PlacementPreview>;
  previewActual(input: Readonly<{ token: Token; draft: ActualDraft }>): Result<ActualPreview>;
  /** One-use session capability; not a Data write. Invalidated by token change. */
  unlockFixed(input: Readonly<{ token: Token; commitmentId: Id; version: number }>): Result<Id>;
  cancelPreview(previewId: Id): void;
  /** Synthetic in-memory writes only. Validate again; failure leaves state intact. */
  submit(command: Command): Promise<SubmitResult>;
  /** Notify UI to invalidate previews and reload, never silently replay commands. */
  subscribe(onTokenChanged: (token: Token) => void): () => void;
}

/** Controls for synthetic scenarios only; never expose as production commands. */
export interface PrototypeHarness {
  readonly host: PrototypeHost;
  loadScenario(id: 'S01' | 'S02' | 'S03' | 'S04' | 'S05' | 'S06' | 'S07'): void;
  setNow(now: Instant): void; // rerender projections; no business write
  failNextSubmit(code: 'STORAGE_FAILED'): void; // leave snapshot/token unchanged
  simulateExternalWrite(): void; // increment revision and notify subscribers
}
