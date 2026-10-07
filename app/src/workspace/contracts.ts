/** 1F-contract-1 production type contract. Runtime checks are implemented separately. */
import type {
  ActionCard,
  BookEntry,
  Pool,
  GenerationRule,
  DailyAcceptance,
  SlotSelection,
  DataV3,
} from './contracts-v3.ts';
import type { DataV4, JournalEntry } from './contracts-v4.ts';
export type Id = string;
export type LocalDate = string; // YYYY-MM-DD, validated by Host
export type Instant = string; // canonical UTC ISO string, validated by Host
export type Token = Readonly<{ epoch: string; revision: number }>;
export type Range = Readonly<{ startAt: Instant; endAt: Instant; zone: string }>;
export type LocalInput = Readonly<{
  date: LocalDate;
  time: string;
  zone: string;
  offset?: string;
}>;
export type BaseErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_GRID'
  | 'DURATION_REQUIRED'
  | 'NONEXISTENT_LOCAL_TIME'
  | 'AMBIGUOUS_LOCAL_TIME'
  | 'AMBIGUOUS_DAY_TEMPLATE'
  | 'SLOT_OCCUPIED'
  | 'NO_AVAILABLE_SLOT'
  | 'REVISION_CONFLICT'
  | 'WORKSPACE_REPLACED'
  | 'FACT_LOCKED'
  | 'ALREADY_CONFIRMED'
  | 'ALREADY_PLANNED'
  | 'FIXED_LOCKED'
  | 'PREVIEW_STALE'
  | 'OVERLAP_CONFIRMATION_REQUIRED'
  | 'COMMAND_ID_REUSED'
  | 'STORAGE_FAILED';
export type Blocker = Readonly<{
  id: Id;
  kind: 'fixed' | 'plan' | 'fact' | 'template-projection';
  title: string;
  range: Range;
  overlap: Range;
}>;
export type Policies = Readonly<{
  status: 'user-decided';
  actualPrecision: 'minute';
  allowFutureActualEnd: true;
  confirmedOccupancy: 'actual-only';
  dayEnd: 'automatic-recompute';
  placementOverlap: 'explicit-acknowledgement';
}>;
export type CardView = Readonly<{
  instanceId: Id;
  version: number;
  title: string;
  criteria: string;
  presetMinutes: number | null;
  color: string;
  targetDate: LocalDate | null;
}>;
export type Segment = Readonly<{
  id: Id;
  sourceId: Id | null; // null only for derived empty-time segments
  kind: 'fixed' | 'plan' | 'fact' | 'plan-reference' | 'empty';
  title: string;
  sourceRange: Range;
  clippedRange: Range;
  startDate: LocalDate;
  half: 0 | 1;
  startMinuteOfHalf: number;
  endMinuteOfHalf: number;
  label: string;
  offsetLabel: string;
  locked: boolean;
  continuesBefore: boolean;
  continuesAfter: boolean;
}>;
export type PlanView = Readonly<{
  planId: Id;
  version: number;
  instanceId: Id;
  instanceVersion: number;
  range: Range;
}>;
export type FixedView = Readonly<{ commitmentId: Id; version: number; range: Range }>;
export type FactView = Readonly<{
  factId: Id;
  instanceId: Id;
  title: string;
  criteria: string;
  actualRange: Range;
  plannedRange: Range | null;
  confirmedAt: Instant;
  annotations: readonly Readonly<{ id: Id; text: string; createdAt: Instant }>[];
}>;
export type DayView = Readonly<{
  token: Token;
  date: LocalDate;
  zone: string;
  now: Instant;
  dayRange: Range;
  hand: readonly CardView[];
  segments: readonly Segment[];
  facts: readonly FactView[];
  plans: readonly PlanView[];
  fixed: readonly FixedView[];
  freeRanges: readonly Range[];
  policies: Policies;
}>;
export type PlacementSubject =
  | Readonly<{ kind: 'hand'; instanceId: Id; version: number }>
  | Readonly<{ kind: 'plan'; planId: Id; version: number }>
  | Readonly<{ kind: 'fixed'; commitmentId: Id; version: number; unlockId: Id }>;
export type PlacementQuery = Readonly<{
  token: Token;
  subject: PlacementSubject;
  date: LocalDate;
  zone: string;
  focusMinuteOfDay: number; // 0..1435, multiple of 5; one absolute local-time landing
}>;
export type Candidate = Readonly<{
  id: Id;
  half: 0 | 1;
  range: Range;
  label: string;
  offsetLabel: string;
  units: number;
  segments: readonly Segment[];
}> &
  (
    | Readonly<{ state: 'valid' }>
    | Readonly<{
        state: 'conflict';
        blockers: readonly Blocker[];
        reason: string;
        acknowledgementId: Id;
      }>
  );
export type PlacementPreview = Readonly<{
  previewId: Id;
  token: Token;
  query: PlacementQuery;
  candidates: readonly Candidate[];
  unresolved: readonly Readonly<{
    half: 0 | 1;
    code: 'NONEXISTENT_LOCAL_TIME' | 'AMBIGUOUS_LOCAL_TIME';
    message: string;
  }>[];
}>;
export type ActualDraft = Readonly<{
  instanceId: Id;
  instanceVersion: number;
  start: LocalInput;
  end: LocalInput;
}> &
  (
    Readonly<{ mode: 'planned'; planId: Id; planVersion: number }> | Readonly<{ mode: 'unplanned' }>
  );
export type ActualPreview = Readonly<{
  previewId: Id;
  token: Token;
  draft: ActualDraft;
  range: Range;
  title: string;
  criteria: string;
  plannedRange: Range | null;
  conflicts: readonly Blocker[];
  acknowledgementId: Id | null;
}>;

/** 1F-contract-1. Design contract only; 2A implements validators and transactions in src. */

export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type VersionRef = Readonly<{ id: Id; version: number }>;
export type LegacyRef = Readonly<{ kind: 'legacy'; sourceId: Id; path: string }>;
export type EntityRef =
  | LegacyRef
  | Readonly<{
      kind:
        | 'definition'
        | 'instance'
        | 'plan'
        | 'fact'
        | 'annotation'
        | 'fixed'
        | 'template'
        | 'rule'
        | 'occurrence'
        | 'capture'
        | 'project'
        | 'goal'
        | 'day'
        | 'settings'
        | 'action-card'
        | 'book-entry'
        | 'pool'
        | 'generation-rule'
        | 'daily-copy'
        | 'archive-log'
        | 'journal-entry';
      id: Id;
    }>;
export type SourceRef =
  | LegacyRef
  | Readonly<{ kind: 'manual' }>
  | Readonly<{ kind: 'definition' | 'capture' | 'occurrence' | 'makeup' | 'daily-copy'; id: Id }>;
export type Content = Readonly<{
  title: string;
  criteria: string;
  presetMinutes: number | null;
  color: string;
  categoryId: Id | null;
  categoryLabel: string | null;
  minimum: boolean;
  projectIds: readonly Id[];
  goalIds: readonly Id[];
  projectLabels: readonly Readonly<{ id: Id; label: string }>[];
  goalLabels: readonly Readonly<{ id: Id; label: string }>[];
}>;
export type RecordedRange = Range &
  Readonly<{
    localStart: string;
    localEnd: string;
    startOffset: string;
    endOffset: string;
  }>;
export type Definition = Readonly<{
  id: Id;
  version: number;
  content: Content;
  enabled: boolean;
  parentDefinitionId: Id | null;
  source: SourceRef;
}>;
export type Instance = Readonly<{
  id: Id;
  version: number;
  definition: VersionRef | null;
  creationSnapshot: Content;
  currentContent: Content;
  source: SourceRef;
  createdAt: string;
  targetDate: string | null;
  state: 'open' | 'withdrawn';
  occurrenceId: Id | null;
  daily?: DailyAcceptance | null;
  makeupOf: Readonly<{ kind: 'occurrence'; id: Id }> | LegacyRef | null;
}>;
export type Plan = Readonly<{
  id: Id;
  version: number;
  instanceId: Id;
  range: RecordedRange;
  contentSnapshot: Content;
  status: 'active' | 'retracted' | 'confirmed';
  createdAt: string;
  changedAt: string;
}>;
export type PlannedSnapshot = Readonly<{
  planId: Id;
  planVersion: number;
  range: RecordedRange;
  content: Content;
}>;
export type Fact = Readonly<{
  id: Id;
  instanceId: Id;
  contentSnapshot: Content;
  actualRange: RecordedRange;
  plannedSnapshot: PlannedSnapshot | null;
  confirmedAt: string;
  source: SourceRef;
}>;
export type Annotation = Readonly<{ id: Id; factId: Id; text: string; createdAt: string }>;
export type Fixed = Readonly<{
  id: Id;
  version: number;
  title: string;
  range: RecordedRange;
  cancelled: boolean;
  ownerDate: string;
  template: VersionRef | null;
  templateEntryId: Id | null;
  manuallyOverridden: boolean;
  source: SourceRef;
}>;
export type TemplateEntry = Readonly<{
  id: Id;
  title: string;
  start: string;
  elapsedMinutes: number;
  definitionId: Id | null; // a reference for display; applying a template does not accept an action
}>;
export type Template = Readonly<{
  id: Id;
  version: number;
  name: string;
  weekdays: readonly number[];
  entries: readonly TemplateEntry[];
  source: SourceRef;
}>;
export type Day = Readonly<{
  date: string;
  zone: string;
  version: number;
  name: string;
  template: VersionRef | null;
  minimum: boolean;
  top3: readonly (Readonly<{ kind: 'instance'; id: Id }> | LegacyRef)[];
  overrides: readonly Readonly<{
    entryId: Id;
    fixedId: Id | null;
    kind: 'edited' | 'cancelled';
    at: string;
  }>[];
}>;
export type Rule = Readonly<{
  id: Id;
  version: number;
  name: string;
  definitionId: Id;
  weekdays: readonly number[];
  startDate: string;
  zone: string;
  status: 'active' | 'paused' | 'archived';
  source: SourceRef;
}>;
export type Occurrence = Readonly<{
  id: Id;
  ruleId: Id;
  date: string;
  instanceId: Id;
  disposition: 'generated' | 'skipped' | 'missed' | 'cancelled';
  // completion is derived from the instance's unique Fact, never a second mutable done flag
}>;
export type Capture = Readonly<{
  id: Id;
  version: number;
  text: string;
  createdAt: string;
  source: string;
  status: 'unprocessed' | 'resolved' | 'archived' | 'discarded';
  target: Readonly<{ kind: 'instance'; id: Id }> | LegacyRef | null;
}>;
export type History = Readonly<{
  id: Id;
  commandId: Id;
  at: string;
  date: string;
  type: string;
  entity: EntityRef;
  before: Json;
  after: Json;
}>;
export type LegacyFormat =
  'cardgrid-v1-p1a' | 'cardgrid-v1-pre-planner' | 'envelope-v1' | 'legacy-archive';
export type LegacySource = Readonly<{
  id: Id;
  format: LegacyFormat;
  fingerprint: string;
  importedAt: string;
  raw: Json;
}>;
export type MigrationBinding = Readonly<{
  sourceId: Id;
  path: string;
  sourceFingerprint: string;
  mappingVersion: 1;
  target: EntityRef;
  disposition: 'converted' | 'readonly';
  // readonly target must equal the source reference, and resolves through the legacy adapter
}>;
export type Receipt = Readonly<{
  commandId: Id;
  type: string;
  payloadFingerprint: string;
  resultRefs: readonly EntityRef[];
}>;
export type Settings = Readonly<{
  zone: string | null;
  preferences: Readonly<{
    theme: 'paper' | 'night';
    density: 'comfortable' | 'compact';
    startHour: number;
    endHour: number;
    defaultMinutes: number;
  }>;
  categories: readonly Readonly<{ id: Id; name: string; color: string }>[];
}>;
export type PlannerV2 = Readonly<{
  version: 2;
  definitions: readonly Definition[];
  instances: readonly Instance[];
  handOrder: readonly Id[];
  plans: readonly Plan[];
  facts: readonly Fact[];
  annotations: readonly Annotation[];
  fixed: readonly Fixed[];
  templates: readonly Template[];
  days: readonly Day[];
  rules: readonly Rule[];
  occurrences: readonly Occurrence[];
  captures: readonly Capture[];
  refs: readonly Readonly<{
    id: Id;
    name: string;
    status: 'active' | 'paused' | 'archived' | 'completed';
  }>[];
  goals: readonly Readonly<{ id: Id; name: string }>[];
  history: readonly History[];
}>;
export type DataV2 = Readonly<{
  version: 2;
  settings: Settings;
  planner: PlannerV2;
  legacySources: readonly LegacySource[];
  migrationBindings: readonly MigrationBinding[];
  commandReceipts: readonly Receipt[];
}>;
export type WorkspaceData = DataV2 | DataV3 | DataV4;
export type LifecycleReceipt = Readonly<{
  commandId: Id;
  payloadFingerprint: string;
  previousToken: Token;
  resultToken: Token;
  type: 'RestoreWorkspace' | 'ClearWorkspace' | 'CommitMigration';
}>;
export type EnvelopeV4 = Readonly<{
  schemaVersion: 4;
  epoch: string;
  revision: number;
  lifecycleReceipt: LifecycleReceipt | null;
}> &
  (
    | Readonly<{ mode: 'current'; dataFormat: 'action-v2'; data: DataV2 }>
    | Readonly<{ mode: 'current'; dataFormat: 'action-v3'; data: DataV3 }>
    | Readonly<{ mode: 'current'; dataFormat: 'action-v4'; data: DataV4 }>
    | Readonly<{
        mode: 'legacy-readonly';
        dataFormat: Exclude<LegacyFormat, 'legacy-archive'>;
        data: Json;
      }>
  );
export type BackupV2 = Readonly<{ format: 'cardgrid'; version: 2; kind: 'backup' }> &
  (
    | Readonly<{ dataFormat: 'action-v2'; data: DataV2 }>
    | Readonly<{ dataFormat: 'envelope-v1'; data: Json }>
  );
/** Existing backup v1 is exported unchanged in legacy-readonly mode, without filling missing fields. */
export type LegacyBackupV1 = Readonly<{
  format: 'cardgrid';
  version: 1;
  kind: 'backup';
  data: Json;
}>;
export type ConfigV2 = Readonly<{
  format: 'cardgrid';
  version: 2;
  kind: 'config';
  config: Readonly<{
    settings: Settings;
    definitions: readonly Definition[];
    templates: readonly Template[];
    rules: readonly Rule[];
  }>;
}>;

export type BackupEvidence = Readonly<{
  token: Token;
  dataFingerprint: string;
  fileSavedConfirmed: true;
}>;
export type CommandPayloads = {
  SaveActionCard: Readonly<{ actionCard: ActionCard; expectedVersion: number | null }>;
  SaveBookEntry: Readonly<{ bookEntry: BookEntry; expectedVersion: number | null }>;
  SavePool: Readonly<{ pool: Pool; expectedVersion: number | null }>;
  SaveGenerationRule: Readonly<{ generationRule: GenerationRule; expectedVersion: number | null }>;
  GenerateDailyCopies: Readonly<{ target: 'current' | Readonly<{ ruleId: Id; date: LocalDate }> }>;
  ArchiveDueCopies: Readonly<Record<string, never>>;
  AcceptDailyCopy: Readonly<{
    copy: VersionRef;
    selections: readonly SlotSelection[];
    composedText: string;
  }>;
  SaveSettings: Readonly<{ settings: Settings }>;
  CreateCapture: Readonly<{ text: string; source: string }>;
  SetCaptureStatus: Readonly<{ capture: VersionRef; status: 'archived' | 'discarded' }>;
  UpdateDay: Readonly<{ date: string; version: number; minimum: boolean; top3: Day['top3'] }>;
  SaveTemplate: Readonly<{ template: Template; expectedVersion: number | null }>;
  SaveRule: Readonly<{ rule: Rule; expectedVersion: number | null }>;
  SaveProject: Readonly<{ project: PlannerV2['refs'][number] }>;
  SaveGoal: Readonly<{ goal: PlannerV2['goals'][number] }>;
  SaveDefinition: Readonly<{
    id: Id | null;
    expectedVersion: number | null;
    content: Content;
    enabled: boolean;
    parentDefinitionId: Id | null;
  }>;
  ArchiveDefinition: Readonly<{ definition: VersionRef }>;
  AcceptOffer: Readonly<{ definition: VersionRef; targetDate: string | null }>;
  ResolveCaptureToAction: Readonly<{
    capture: VersionRef;
    content: Content;
    targetDate: string | null;
  }>;
  UpdateOpenInstance: Readonly<{
    instance: VersionRef;
    content: Content;
    targetDate: string | null;
    placementPreviewId: Id | null;
    acknowledgedOverlap: Id | null;
  }>;
  ReorderHand: Readonly<{ instanceIds: readonly Id[] }>;
  WithdrawInstance: Readonly<{ instance: VersionRef }>;
  ReturnWithdrawnToHand: Readonly<{ instance: VersionRef }>;
  CommitPlacement: Readonly<{ previewId: Id; candidateId: Id; acknowledgedOverlap: Id | null }>;
  RetractPlan: Readonly<{ planId: Id; version: number }>;
  CancelFixed: Readonly<{ commitment: VersionRef; unlockId: Id }>;
  ApplyDayTemplate: Readonly<{ previewId: Id; acknowledgedOverlap: Id | null }>;
  ConfirmActual: Readonly<{ previewId: Id; acknowledgedOverlap: Id | null }>;
  AppendAnnotation: Readonly<{ factId: Id; text: string }>;
  PrepareDay: Readonly<{ date: string; zone: string; templateId: Id | null }>;
  CreateMakeup: Readonly<{
    occurrence: Readonly<{ kind: 'occurrence'; id: Id }> | LegacyRef;
    targetDate: string;
  }>;
  ImportDefinitions: Readonly<{ previewId: Id; mode: 'merge' | 'replace'; backup: BackupEvidence }>;
  RestoreWorkspace: Readonly<{
    previewId: Id;
    backup: BackupEvidence;
    discardDraftsConfirmed: true;
  }>;
  ClearWorkspace: Readonly<{ backup: BackupEvidence; discardDraftsConfirmed: true }>;
  CommitMigration: Readonly<{
    previewId: Id;
    backup: BackupEvidence;
    discardDraftsConfirmed: true;
  }>;
  SaveJournalEntry: Readonly<{ date: LocalDate; zone: string; text: string }>;
};
export type Command = {
  [K in keyof CommandPayloads]: Readonly<{
    commandId: Id;
    expected: Token;
    type: K;
    payload: CommandPayloads[K];
  }>;
}[keyof CommandPayloads];

export type MigrationIssue = Readonly<{
  source: LegacyRef;
  code: string;
  message: string;
  blocking: boolean;
  choices: readonly string[];
}>;
export type MigrationPreview = Readonly<{
  previewId: Id;
  token: Token;
  sourceFingerprint: string;
  mappingVersion: 1;
  bindings: readonly MigrationBinding[];
  issues: readonly MigrationIssue[];
  upgrade?: Readonly<{ from: 2; to: 3 }> | Readonly<{ from: 3; to: 4 }>;
  targetSummary: Readonly<{
    definitions: number;
    instances: number;
    plans: number;
    facts: number;
    journalEntries: number;
    readonlyItems: number;
  }>;
}>;
/** 2A extends the prototype read shape, adding mixed-zone/legacy projections without exposing storage. */
export type ProductionDayView = DayView &
  Readonly<{
    mode: 'current' | 'legacy-readonly';
    occupancyKnown: boolean;
    legacyItems: readonly Readonly<{
      source: LegacyRef;
      title: string;
      range: Range | null;
      occupancy: 'known' | 'unknown' | 'none';
    }>[];
  }>;
export type QueryInputs = {
  readDay: Readonly<{ date: string; zone: string }>;
  previewPlacement: PlacementQuery;
  previewActual: Readonly<{ token: Token; draft: ActualDraft }>;
  resolveLocal: LocalInput;
};
export type ErrorCode =
  | BaseErrorCode
  | 'LEGACY_READ_ONLY'
  | 'UNKNOWN_FORMAT'
  | 'MIGRATION_BLOCKED'
  | 'BACKUP_REQUIRED'
  | 'BACKUP_STALE'
  | 'DATA_TOO_LARGE'
  | 'DEFINITION_STALE'
  | 'DEFINITION_DISABLED'
  | 'CAPTURE_ALREADY_RESOLVED'
  | 'PAST_OCCURRENCE_LOCKED'
  | 'COPY_EXPIRED'
  | 'COPY_NOT_FOUND'
  | 'REQUIRED_SLOT_EMPTY'
  | 'ENTRY_ARCHIVED'
  | 'ENTRY_STALE'
  | 'UNSUPPORTED_VERSION'
  | 'VERSION_HISTORY_UNAVAILABLE'
  | 'RULE_NOT_ACTIVE'
  | 'RULE_NOT_FOUND'
  | 'DATE_OUTSIDE_RETENTION'
  | 'FUTURE_DATE'
  | 'ACTION_CARD_MISSING'
  | 'ACTION_CARD_INACTIVE';
export type Result<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
      ok: false;
      code: ErrorCode;
      message: string;
      field?: string;
      choices?: readonly Readonly<{ input: LocalInput; instant: Instant }>[];
      retry: 'edit' | 'preview' | 'reload' | 'same-command' | 'none';
    }>;
export type SubmitResult = Result<
  Readonly<{ token: Token; resultRefs: readonly EntityRef[]; replayed: boolean }>
>;
