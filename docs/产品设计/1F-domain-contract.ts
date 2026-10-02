/** 1F-contract-1. Design contract only; 2A implements validators and transactions in src. */
import type { ActualDraft, DayView, ErrorCode as PrototypeErrorCode, LocalInput, PlacementQuery, Range, Token } from './1C-prototype-contract.ts';

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Id = string;
export type VersionRef = Readonly<{ id: Id; version: number }>;
export type LegacyRef = Readonly<{ kind: 'legacy'; sourceId: Id; path: string }>;
export type EntityRef = LegacyRef | Readonly<{
  kind: 'definition' | 'instance' | 'plan' | 'fact' | 'annotation' | 'fixed' | 'template' | 'rule' | 'occurrence' | 'capture' | 'project' | 'goal' | 'day'; id: Id;
}>;
export type SourceRef = LegacyRef | Readonly<{ kind: 'manual' }> | Readonly<{ kind: 'definition' | 'capture' | 'occurrence' | 'makeup'; id: Id }>;
export type Content = Readonly<{
  title: string; criteria: string; presetMinutes: number | null; color: string;
  categoryId: Id | null; categoryLabel: string | null; minimum: boolean;
  projectIds: readonly Id[]; goalIds: readonly Id[];
  projectLabels: readonly Readonly<{ id: Id; label: string }>[];
  goalLabels: readonly Readonly<{ id: Id; label: string }>[];
}>;
export type RecordedRange = Range & Readonly<{
  localStart: string; localEnd: string; startOffset: string; endOffset: string;
}>;
export type Definition = Readonly<{
  id: Id; version: number; content: Content; enabled: boolean;
  parentDefinitionId: Id | null; source: SourceRef;
}>;
export type Instance = Readonly<{
  id: Id; version: number; definition: VersionRef | null; creationSnapshot: Content;
  currentContent: Content; source: SourceRef; createdAt: string;
  targetDate: string | null; state: 'open' | 'withdrawn';
  occurrenceId: Id | null;
  makeupOf: Readonly<{ kind: 'occurrence'; id: Id }> | LegacyRef | null;
}>;
export type Plan = Readonly<{
  id: Id; version: number; instanceId: Id; range: RecordedRange;
  contentSnapshot: Content; status: 'active' | 'retracted' | 'confirmed';
  createdAt: string; changedAt: string;
}>;
export type PlannedSnapshot = Readonly<{ planId: Id; planVersion: number; range: RecordedRange; content: Content }>;
export type Fact = Readonly<{
  id: Id; instanceId: Id; contentSnapshot: Content; actualRange: RecordedRange;
  plannedSnapshot: PlannedSnapshot | null; confirmedAt: string; source: SourceRef;
}>;
export type Annotation = Readonly<{ id: Id; factId: Id; text: string; createdAt: string }>;
export type Fixed = Readonly<{
  id: Id; version: number; title: string; range: RecordedRange; cancelled: boolean;
  ownerDate: string; template: VersionRef | null; templateEntryId: Id | null;
  manuallyOverridden: boolean; source: SourceRef;
}>;
export type TemplateEntry = Readonly<{
  id: Id; title: string; start: string; elapsedMinutes: number;
  definitionId: Id | null; // a reference for display; applying a template does not accept an action
}>;
export type Template = Readonly<{
  id: Id; version: number; name: string; weekdays: readonly number[];
  entries: readonly TemplateEntry[]; source: SourceRef;
}>;
export type Day = Readonly<{
  date: string; zone: string; version: number; name: string; template: VersionRef | null;
  minimum: boolean; top3: readonly (Readonly<{ kind: 'instance'; id: Id }> | LegacyRef)[];
  overrides: readonly Readonly<{ entryId: Id; fixedId: Id | null; kind: 'edited' | 'cancelled'; at: string }>[];
}>;
export type Rule = Readonly<{
  id: Id; version: number; name: string; definitionId: Id; weekdays: readonly number[];
  startDate: string; zone: string; status: 'active' | 'paused' | 'archived'; source: SourceRef;
}>;
export type Occurrence = Readonly<{
  id: Id; ruleId: Id; date: string; instanceId: Id;
  disposition: 'generated' | 'skipped' | 'missed' | 'cancelled';
  // completion is derived from the instance's unique Fact, never a second mutable done flag
}>;
export type Capture = Readonly<{
  id: Id; version: number; text: string; createdAt: string; source: string;
  status: 'unprocessed' | 'resolved' | 'archived' | 'discarded';
  target: Readonly<{ kind: 'instance'; id: Id }> | LegacyRef | null;
}>;
export type History = Readonly<{
  id: Id; commandId: Id; at: string; date: string; type: string;
  entity: EntityRef; before: Json; after: Json;
}>;
export type LegacyFormat = 'cardgrid-v1-p1a' | 'cardgrid-v1-pre-planner' | 'envelope-v1' | 'legacy-archive';
export type LegacySource = Readonly<{ id: Id; format: LegacyFormat; fingerprint: string; importedAt: string; raw: Json }>;
export type MigrationBinding = Readonly<{
  sourceId: Id; path: string; sourceFingerprint: string; mappingVersion: 1;
  target: EntityRef; disposition: 'converted' | 'readonly';
  // readonly target must equal the source reference, and resolves through the legacy adapter
}>;
export type Receipt = Readonly<{ commandId: Id; type: string; payloadFingerprint: string; resultRefs: readonly EntityRef[] }>;
export type Settings = Readonly<{
  zone: string | null;
  preferences: Readonly<{ theme: 'paper' | 'night'; density: 'comfortable' | 'compact'; startHour: number; endHour: number; defaultMinutes: number }>;
  categories: readonly Readonly<{ id: Id; name: string; color: string }>[];
}>;
export type PlannerV2 = Readonly<{
  version: 2; definitions: readonly Definition[]; instances: readonly Instance[];
  handOrder: readonly Id[]; plans: readonly Plan[]; facts: readonly Fact[];
  annotations: readonly Annotation[]; fixed: readonly Fixed[]; templates: readonly Template[];
  days: readonly Day[]; rules: readonly Rule[]; occurrences: readonly Occurrence[];
  captures: readonly Capture[]; refs: readonly Readonly<{ id: Id; name: string; status: 'active' | 'paused' | 'archived' | 'completed' }>[];
  goals: readonly Readonly<{ id: Id; name: string }>[]; history: readonly History[];
}>;
export type DataV2 = Readonly<{
  version: 2; settings: Settings; planner: PlannerV2;
  legacySources: readonly LegacySource[]; migrationBindings: readonly MigrationBinding[];
  commandReceipts: readonly Receipt[];
}>;
export type LifecycleReceipt = Readonly<{
  commandId: Id; payloadFingerprint: string; previousToken: Token; resultToken: Token;
  type: 'RestoreWorkspace' | 'ClearWorkspace' | 'CommitMigration';
}>;
export type EnvelopeV4 = Readonly<{ schemaVersion: 4; epoch: string; revision: number; lifecycleReceipt: LifecycleReceipt | null }> & (
  | Readonly<{ mode: 'current'; dataFormat: 'action-v2'; data: DataV2 }>
  | Readonly<{ mode: 'legacy-readonly'; dataFormat: Exclude<LegacyFormat, 'legacy-archive'>; data: Json }>
);
export type BackupV2 = Readonly<{ format: 'cardgrid'; version: 2; kind: 'backup' }> & (
  | Readonly<{ dataFormat: 'action-v2'; data: DataV2 }>
  | Readonly<{ dataFormat: 'envelope-v1'; data: Json }>
);
/** Existing backup v1 is exported unchanged in legacy-readonly mode, without filling missing fields. */
export type LegacyBackupV1 = Readonly<{ format: 'cardgrid'; version: 1; kind: 'backup'; data: Json }>;
export type ConfigV2 = Readonly<{
  format: 'cardgrid'; version: 2; kind: 'config';
  config: Readonly<{ settings: Settings; definitions: readonly Definition[]; templates: readonly Template[]; rules: readonly Rule[] }>;
}>;

export type BackupEvidence = Readonly<{ token: Token; dataFingerprint: string; fileSavedConfirmed: true }>;
export type CommandPayloads = {
  SaveDefinition: Readonly<{ id: Id | null; expectedVersion: number | null; content: Content; enabled: boolean; parentDefinitionId: Id | null }>;
  ArchiveDefinition: Readonly<{ definition: VersionRef }>;
  AcceptOffer: Readonly<{ definition: VersionRef; targetDate: string | null }>;
  ResolveCaptureToAction: Readonly<{ capture: VersionRef; content: Content; targetDate: string | null }>;
  UpdateOpenInstance: Readonly<{ instance: VersionRef; content: Content; targetDate: string | null; placementPreviewId: Id | null; acknowledgedOverlap: Id | null }>;
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
  CreateMakeup: Readonly<{ occurrence: Readonly<{ kind: 'occurrence'; id: Id }> | LegacyRef; targetDate: string }>;
  ImportDefinitions: Readonly<{ previewId: Id; mode: 'merge' | 'replace'; backup: BackupEvidence }>;
  RestoreWorkspace: Readonly<{ previewId: Id; backup: BackupEvidence; discardDraftsConfirmed: true }>;
  ClearWorkspace: Readonly<{ backup: BackupEvidence; discardDraftsConfirmed: true }>;
  CommitMigration: Readonly<{ previewId: Id; backup: BackupEvidence; discardDraftsConfirmed: true }>;
};
export type Command = { [K in keyof CommandPayloads]: Readonly<{ commandId: Id; expected: Token; type: K; payload: CommandPayloads[K] }> }[keyof CommandPayloads];

export type MigrationIssue = Readonly<{ source: LegacyRef; code: string; message: string; blocking: boolean; choices: readonly string[] }>;
export type MigrationPreview = Readonly<{
  previewId: Id; token: Token; sourceFingerprint: string; mappingVersion: 1;
  bindings: readonly MigrationBinding[]; issues: readonly MigrationIssue[];
  targetSummary: Readonly<{ definitions: number; instances: number; plans: number; facts: 0; readonlyItems: number }>;
}>;
/** 2A extends the prototype read shape, adding mixed-zone/legacy projections without exposing storage. */
export type ProductionDayView = DayView & Readonly<{
  mode: 'current' | 'legacy-readonly';
  legacyItems: readonly Readonly<{ source: LegacyRef; title: string; range: Range | null; occupancy: 'known' | 'unknown' | 'none' }>[];
}>;
export type QueryInputs = {
  readDay: Readonly<{ date: string; zone: string }>;
  previewPlacement: PlacementQuery;
  previewActual: Readonly<{ token: Token; draft: ActualDraft }>;
  resolveLocal: LocalInput;
};
export type ErrorCode = PrototypeErrorCode | 'LEGACY_READ_ONLY' | 'UNKNOWN_FORMAT' | 'MIGRATION_BLOCKED'
  | 'BACKUP_REQUIRED' | 'BACKUP_STALE' | 'DATA_TOO_LARGE' | 'DEFINITION_STALE'
  | 'DEFINITION_DISABLED' | 'CAPTURE_ALREADY_RESOLVED' | 'PAST_OCCURRENCE_LOCKED';
export type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{
  ok: false; code: ErrorCode; message: string; field?: string;
  retry: 'edit' | 'preview' | 'reload' | 'same-command' | 'none';
}>;
export type SubmitResult = Result<Readonly<{ token: Token; resultRefs: readonly EntityRef[]; replayed: boolean }>>;
