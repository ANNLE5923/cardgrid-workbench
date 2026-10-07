/** v0.6 P0 DTOs. No migration, storage, command dispatch or production format enablement. */
import type {
  Annotation,
  ConfigV2,
  Content,
  ErrorCode,
  Fact,
  Fixed,
  History,
  Id,
  Instance,
  Instant,
  LocalDate,
  Plan,
  PlannerV2,
  RecordedRange,
  SourceRef,
  Token,
  VersionRef,
} from './contracts.ts';
import type { ArchiveLog, DailyCopy, GenerationRule } from './contracts-v3.ts';
import type { DataV4, JournalEntry } from './contracts-v4.ts';

export type Scalar = string | number | boolean | null;
export type FieldSpec = Readonly<{
  id: Id;
  label: string;
  valueType: 'text' | 'number' | 'boolean';
  required: boolean;
}>;
export type CatalogEntry = Readonly<{
  id: Id;
  version: number;
  title: string;
  attributes: Readonly<Record<string, Scalar>>;
  url: string | null;
  status: 'active' | 'archived';
  source: SourceRef;
}>;
export type Deck = Readonly<{
  id: Id;
  version: number;
  name: string;
  deckKind: 'action' | 'decision' | 'entry';
  parentDeckId: Id | null;
  memberIds: readonly Id[];
  source: SourceRef;
}>;
export type ActionCardV5 = Readonly<{
  id: Id;
  version: number;
  kind: 'action';
  content: Content;
  fields: readonly FieldSpec[];
  status: 'active' | 'paused' | 'archived';
  parentId: Id | null;
  source: SourceRef;
}>;
export type FieldMapping = Readonly<{ fieldId: Id; entryPath: 'title' | `attributes.${string}` }>;
export type DecisionCard = Readonly<{
  id: Id;
  version: number;
  question: string;
  ownerActionId: Id;
  deckIds: readonly Id[];
  mappings: readonly FieldMapping[];
  status: 'active' | 'paused' | 'archived';
  source: SourceRef;
}>;
export type CatalogV06 = Readonly<{
  actionCards: readonly ActionCardV5[];
  catalogEntries: readonly CatalogEntry[];
  decks: readonly Deck[];
  decisionCards: readonly DecisionCard[];
}>;
export type FieldValue = Readonly<{ fieldId: Id; value: Scalar }>;
export type AnswerSnapshot = Readonly<{
  decision: VersionRef;
  question: string;
  ownerAction: VersionRef;
  entry: CatalogEntry;
  sourceDecks: readonly VersionRef[];
  mappings: readonly FieldMapping[];
  fieldValues: readonly FieldValue[];
  selectedAt: Instant;
}>;
export type Provenance =
  | Readonly<{ kind: 'manual'; source: VersionRef }>
  | Readonly<{
      kind: 'daily-copy';
      copy: VersionRef;
      sourceDate: LocalDate;
      zone: string;
      expiresAt: Instant;
    }>
  | Readonly<{ kind: 'answer'; snapshot: AnswerSnapshot }>;
type MaterialBase = Readonly<{
  id: Id;
  version: number;
  state: 'available' | 'consumed' | 'expired' | 'withdrawn';
  createdAt: Instant;
  provenance: readonly Provenance[];
  inputIds: readonly Id[];
  expiresAt: Instant | null;
  consumedBy: Id | null;
}>;
type ActionMaterial = Readonly<{
  actionInstanceId: Id | null;
  ownerAction: VersionRef;
  contentSnapshot: Content;
  fieldSpecs: readonly FieldSpec[];
  fieldValues: readonly FieldValue[];
}>;
/** Discriminants prevent an entry/answer from being mistaken for an executable action. */
export type HandCard = MaterialBase &
  (
    | (Readonly<{ kind: 'action' }> & ActionMaterial)
    | (Readonly<{ kind: 'composite' }> & ActionMaterial)
    | Readonly<{ kind: 'answer'; answer: AnswerSnapshot }>
    | Readonly<{ kind: 'entry'; entrySnapshot: CatalogEntry }>
  );
export type RecordedPoint = Readonly<{
  at: Instant;
  zone: string;
  localTime: string;
  offset: string;
}>;
type ReferenceBase = Readonly<{
  id: Id;
  version: number;
  answerId: Id;
  createdAt: Instant;
  changedAt: Instant;
  state: 'active' | 'returned' | 'expired';
}>;
export type ReferencePlacement = ReferenceBase &
  (
    | Readonly<{ mode: 'attached'; targetInstanceId: Id }>
    | Readonly<{ mode: 'point'; point: RecordedPoint }>
  );
export type FactReferenceSnapshot = Readonly<{ factId: Id; answers: readonly AnswerSnapshot[] }>;
export type JournalNote = Readonly<{
  id: Id;
  version: number;
  kind: 'reflection';
  date: LocalDate;
  zone: string;
  recordedAt: Instant;
  createdAt: Instant;
  updatedAt: Instant;
  text: string;
}>;
export type LegacyJournalBlock = JournalEntry & Readonly<{ kind: 'legacy-block' }>;
export type JournalAutoSegment = Readonly<{
  id: Id;
  sourceKey: string;
  sourceKind: 'plan' | 'fixed' | 'template' | 'fact';
  title: string;
  range: RecordedRange;
  clippedRange: RecordedRange;
  status: 'planned' | 'fixed' | 'confirmed';
  referenceAnswers: readonly AnswerSnapshot[];
}>;
export type V06EntityRef = {
  readonly kind:
    | 'catalog-entry'
    | 'deck'
    | 'action-card'
    | 'decision-card'
    | 'hand-card'
    | 'reference-placement'
    | 'journal-note'
    | 'journal-entry'
    | 'fact'
    | 'instance'
    | 'archive';
  readonly id: Id;
};

export type V06ErrorCode =
  | ErrorCode
  | 'CONTRACT_NOT_IMPLEMENTED'
  | 'MATERIAL_CONSUMED'
  | 'MATERIAL_PLACED'
  | 'MATERIAL_EXPIRED'
  | 'ACTION_OWNER_MISMATCH'
  | 'FIELD_CONFLICT'
  | 'REQUIRED_FIELD_EMPTY'
  | 'ENTRY_UNAVAILABLE'
  | 'POOL_CAPACITY_EXCEEDED'
  | 'ARCHIVE_READ_ONLY'
  | 'ARCHIVE_INVALID'
  | 'ARCHIVE_INCOMPLETE'
  | 'ARCHIVE_CONFLICT'
  | 'ARCHIVE_MISSING'
  | 'ARCHIVE_NOT_VERIFIED'
  | 'ARCHIVE_BUDGET_EXCEEDED';
export type V06Result<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
      ok: false;
      code: V06ErrorCode;
      message: string;
      field?: string;
      retry: 'edit' | 'preview' | 'reload' | 'same-command' | 'none';
    }>;
/** This stamp MUST stay visible to the caller. A test adapter cannot claim formal persistence. */
export type V06PortStamp = Readonly<{
  contractVersion: 'v06-p0-1';
  backend: 'test-adapter' | 'formal';
  release: 'draft' | 'frozen';
}>;
export type LiveView<T> = Readonly<{ access: 'live'; token: Token; data: T }>;
export type SubmitV06Value = Readonly<{
  token: Token;
  resultRefs: readonly V06EntityRef[];
  replayed: boolean;
}>;

export type JournalTimeline = Readonly<{
  date: LocalDate;
  zone: string;
  automatic: readonly JournalAutoSegment[];
  notes: readonly JournalNote[];
  legacyBlocks: readonly LegacyJournalBlock[];
}>;
export type ReadJournalValue =
  | (LiveView<JournalTimeline> & Readonly<{ editable: true }>)
  | Readonly<{ access: 'archive'; editable: false; archiveId: Id; data: JournalTimeline }>;
export type UnifiedHandItem = Readonly<{
  card: HandCard;
  usableInToday: boolean;
  unavailableReason: V06ErrorCode | 'INCOMPLETE' | null;
}>;
export type DecisionPreview = Readonly<{
  previewId: Id;
  token: Token;
  decision: VersionRef;
  ownerAction: VersionRef;
  candidates: readonly CatalogEntry[];
  sourceFingerprint: string;
}>;
export type SelectedAnswer = Readonly<{
  selectionId: Id;
  previewId: Id;
  token: Token;
  answer: AnswerSnapshot;
}>;
export type FieldResolution = Readonly<{ fieldId: Id; choice: 'keep' | 'replace' }>;
export type SynthesisPreview = Readonly<{
  previewId: Id;
  token: Token;
  inputs: readonly [VersionRef, VersionRef];
  sourceFingerprint: string;
  output: Extract<HandCard, { kind: 'action' | 'composite' }>;
  conflicts: readonly Readonly<{ fieldId: Id; previous: Scalar; incoming: Scalar }>[];
  missingFieldIds: readonly Id[];
  ready: boolean;
}>;
export type ReferenceDraft = Readonly<{ answer: VersionRef }> &
  (
    | Readonly<{ mode: 'attached'; instance: VersionRef }>
    | Readonly<{
        mode: 'point';
        local: Readonly<{ date: LocalDate; time: string; zone: string; offset?: string }>;
      }>
  );
export type ReferencePreview = Readonly<{
  previewId: Id;
  token: Token;
  draft: ReferenceDraft;
  point: RecordedPoint | null;
  occupiedMinutes: 0;
}>;

export type MaintenanceEvent = Readonly<{
  eventId: Id;
  epoch: Id;
  at: Instant;
  date: LocalDate;
  zone: string;
  category:
    'navigation' | 'business' | 'decision' | 'journal' | 'url' | 'file' | 'lifecycle' | 'error';
  operation: string;
  stage: 'requested' | 'succeeded' | 'failed' | 'cancelled' | 'replayed';
  commandId: Id | null;
  sourceHistoryIds: readonly Id[];
  entityRefs: readonly V06EntityRef[];
  errorCode: string | null;
  details: Readonly<Record<string, Scalar>>;
}>;
export type OutputKey = Readonly<{
  bindingId: Id;
  connectionVersion: number;
  epoch: Id;
  kind: 'journal' | 'maintenance';
  date: LocalDate;
  zone: string;
}>;
export type TextSourceVersion =
  | Readonly<{ kind: 'journal'; token: Token; inputFingerprint: string }>
  | Readonly<{ kind: 'maintenance'; epoch: Id; dayRevision: number; inputFingerprint: string }>;
export type LastTextSuccess = Readonly<{
  text: string;
  sha256: string;
  source: TextSourceVersion;
  succeededAt: Instant;
}>;
export type TextWriteIntent = Readonly<{
  intentId: Id;
  text: string;
  sha256: string;
  source: TextSourceVersion;
  stage: 'prepared' | 'closed' | 'verified';
}>;
export type TextSyncStatus =
  | 'unsupported'
  | 'disconnected'
  | 'idle'
  | 'pending'
  | 'writing'
  | 'synced'
  | 'permission-required'
  | 'failed'
  | 'conflict-copy-failed'
  | 'reconcile-required'
  | 'paused-after-replace';
export type TextOutputState = Readonly<{
  key: OutputKey;
  status: TextSyncStatus;
  lastSuccess: LastTextSuccess | null;
  pendingSource: TextSourceVersion | null;
  error: string | null;
  externalCopyPath: string | null;
}>;
export type TextConnectionView = Readonly<{
  bindingId: Id;
  connectionVersion: number;
  epoch: Id;
  suffix: 'md' | 'txt';
  status: TextSyncStatus;
  pendingCount: number;
}>;
export type FileResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
      ok: false;
      code:
        | 'UNSUPPORTED'
        | 'PERMISSION_REQUIRED'
        | 'HANDLE_INVALID'
        | 'IO_FAILED'
        | 'EXTERNAL_COPY_FAILED'
        | 'RECONCILE_REQUIRED'
        | 'SOURCE_STALE'
        | 'WORKSPACE_REPLACED';
      message: string;
      retry: 'reconnect' | 'refresh' | 'retry-file' | 'none';
    }>;

/** P0 does not bless a numeric byte gate before the monthly ZIP/Host probes. */
export type CapacityPolicy = Readonly<{
  status: 'provisional' | 'validated';
  maxActiveBackupBytes: number;
  maxInputBytes: number;
  maxArchiveCompressedBytes: number;
  maxArchiveExpandedBytes: number;
  maxArchiveEntries: number;
  maxLoadedArchiveMonths: 1 | 2;
}>;
export type ArchiveRecordCollection =
  | 'instances'
  | 'plans'
  | 'facts'
  | 'annotations'
  | 'fixed'
  | 'history'
  | 'journalEntries'
  | 'journalNotes'
  | 'handCards'
  | 'referencePlacements'
  | 'factReferenceSnapshots'
  | 'dailyCopies'
  | 'archiveLogs';
export type ArchiveRecordRef = Readonly<{ collection: ArchiveRecordCollection; id: Id }>;
export type ArchiveRecordCounts = Readonly<Partial<Record<ArchiveRecordCollection, number>>>;
export type ArchiveFileEntry = Readonly<{ path: 'records.json'; sha256: string; bytes: number }>;
export type MonthlyArchiveManifest = Readonly<{
  format: 'cardgrid-monthly-archive';
  version: 1;
  archiveId: Id;
  workspaceId: Id;
  month: string;
  zone: string;
  createdAt: Instant;
  sourceToken: Token;
  sourceDataFormat: 'action-v5';
  closure: 'self-contained';
  coveredDates: readonly LocalDate[];
  recordCounts: ArchiveRecordCounts;
  files: readonly [ArchiveFileEntry];
}>;
/** Index is small; no decoded objects, file handles or compressed bytes in the main backup. */
export type ArchiveIndexEntry = Readonly<{
  archiveId: Id;
  workspaceId: Id;
  month: string;
  zone: string;
  manifestSha256: string;
  recordsSha256: string;
  coveredDates: readonly LocalDate[];
  recordCounts: ArchiveRecordCounts;
}>;
export type ArchiveView = Readonly<{
  access: 'archive';
  editable: false;
  index: ArchiveIndexEntry;
  catalog: CatalogV06;
  instances: readonly Instance[];
  plans: readonly Plan[];
  facts: readonly Fact[];
  annotations: readonly Annotation[];
  journal: readonly JournalTimeline[];
}>;
export type ArchivePreview = Readonly<{
  previewId: Id;
  token: Token;
  workspaceId: Id;
  month: string;
  zone: string;
  sourceFingerprint: string;
  manifest: MonthlyArchiveManifest;
  selected: readonly ArchiveRecordRef[];
  retained: readonly Readonly<{
    ref: ArchiveRecordRef;
    reason: 'open' | 'cross-month' | 'live-reference' | 'idempotency';
  }>[];
  bytes: number;
  blockingIssues: readonly Readonly<{
    code: V06ErrorCode;
    message: string;
    ref: ArchiveRecordRef | null;
  }>[];
}>;
export type ArchiveExportArtifact = Readonly<{
  exportId: Id;
  previewId: Id;
  token: Token;
  archiveId: Id;
  filename: string;
  compressedBytes: number;
  zip: Blob;
}>;
/** verificationId is a server-issued capability, not a user supplied 'verified: true'. */
export type VerifiedArchiveEvidence = Readonly<{
  verificationId: Id;
  exportId: Id;
  previewId: Id;
  token: Token;
  archiveId: Id;
  manifestSha256: string;
  recordsSha256: string;
  verifiedAt: Instant;
  origin: 'external-reread';
}>;
export type ArchiveImportValue = Readonly<{
  index: ArchiveIndexEntry;
  disposition: 'added' | 'duplicate';
  storedCompressedBytes: number;
}>;
export type ArchiveCacheState = Readonly<{
  loadedArchiveIds: readonly Id[];
  decodedBytes: number;
  maxLoadedMonths: 1 | 2;
}>;
/** Small active-data summary for reminders; no archive is decoded by this query. */
export type ArchivableMonth = Readonly<{
  month: string;
  zone: string;
  eligibleRecords: number;
  retainedRecords: number;
  estimatedBytes: number;
}>;
export type RequiredArchive = Pick<
  ArchiveIndexEntry,
  'archiveId' | 'workspaceId' | 'manifestSha256' | 'recordsSha256'
>;
export type RecoveryCoverage = Readonly<{
  kind: 'active-plus-archives';
  required: readonly RequiredArchive[];
  availableArchiveIds: readonly Id[];
  missing: readonly RequiredArchive[];
  complete: boolean;
}>;

/** Reserved package tags; no current WorkspaceData/EnvelopeV4/Command widening in P0. */
export type ConfigV4 = Readonly<{
  format: 'cardgrid';
  version: 4;
  kind: 'config';
  config: CatalogV06 &
    ConfigV2['config'] &
    Readonly<{ generationRules: readonly GenerationRule[] }>;
}>;
export type V06History = Omit<History, 'entity'> &
  Readonly<{ entity: V06EntityRef | History['entity'] }>;
export type CatalogAlias = Readonly<{
  sourceKind: 'book-entry' | 'pool' | 'action-card' | 'slot';
  sourceId: Id;
  targetKind: 'catalog-entry' | 'deck' | 'action-card' | 'decision-card';
  targetId: Id;
}>;
export type DailyCopyV5 = Omit<DailyCopy, 'slotSpecSnapshot'> &
  Readonly<{
    format: 'v5';
    fieldSpecsSnapshot: readonly FieldSpec[];
    decisionCardsSnapshot: readonly DecisionCard[];
  }>;
export type DailyArchiveLogV5 = Omit<ArchiveLog, 'slotSelectionsSnapshot'> &
  Readonly<{ format: 'v5'; acceptedFieldValuesSnapshot: readonly FieldValue[] }>;
export type DataV5 = Omit<
  DataV4,
  | 'version'
  | 'planner'
  | 'actionCards'
  | 'bookEntries'
  | 'pools'
  | 'commandReceipts'
  | 'dailyCopies'
  | 'archiveLogs'
> &
  CatalogV06 &
  Readonly<{
    version: 5;
    workspaceId: Id;
    planner: Omit<PlannerV2, 'history'> & Readonly<{ history: readonly V06History[] }>;
    commandReceipts: readonly Readonly<{
      commandId: Id;
      type: string;
      payloadFingerprint: string;
      resultRefs: readonly (V06EntityRef | History['entity'])[];
    }>[];
    dailyCopies: readonly (DailyCopy | DailyCopyV5)[];
    archiveLogs: readonly (ArchiveLog | DailyArchiveLogV5)[];
    handCards: readonly HandCard[];
    referencePlacements: readonly ReferencePlacement[];
    factReferenceSnapshots: readonly FactReferenceSnapshot[];
    journalNotes: readonly JournalNote[];
    catalogAliases: readonly CatalogAlias[];
    archiveIndex: readonly ArchiveIndexEntry[];
  }>;
/** Full history coverage now requires the listed monthly archives alongside this active backup. */
export type BackupV5 = Readonly<{
  format: 'cardgrid';
  version: 5;
  kind: 'backup';
  dataFormat: 'action-v5';
  coverage: 'active-plus-archives';
  requiredArchives: readonly RequiredArchive[];
  data: DataV5;
}>;
export type ArchiveRecordsV1 = Readonly<{
  format: 'cardgrid-monthly-records';
  version: 1;
  catalogSnapshot: CatalogV06;
  settings: DataV4['settings'];
  catalogAliases: readonly CatalogAlias[];
  definitions: PlannerV2['definitions'];
  templates: PlannerV2['templates'];
  rules: PlannerV2['rules'];
  generationRules: readonly GenerationRule[];
  legacySources: DataV4['legacySources'];
  migrationBindings: DataV4['migrationBindings'];
  records: Readonly<{
    instances: readonly Instance[];
    plans: readonly Plan[];
    facts: readonly Fact[];
    annotations: readonly Annotation[];
    fixed: readonly Fixed[];
    history: readonly V06History[];
    journalEntries: readonly JournalEntry[];
    journalNotes: readonly JournalNote[];
    handCards: readonly HandCard[];
    referencePlacements: readonly ReferencePlacement[];
    factReferenceSnapshots: readonly FactReferenceSnapshot[];
    dailyCopies: readonly (DailyCopy | DailyCopyV5)[];
    archiveLogs: readonly (ArchiveLog | DailyArchiveLogV5)[];
  }>;
}>;
