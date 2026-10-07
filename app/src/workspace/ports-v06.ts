/** P0 interface candidates. Implementations ship in B1-B11; no fake Host success. */
import type { Id, LocalDate, Token, VersionRef } from './contracts.ts';
import type {
  ActionCardV5,
  AnswerSnapshot,
  ArchivableMonth,
  ArchiveCacheState,
  ArchiveExportArtifact,
  ArchiveImportValue,
  ArchiveIndexEntry,
  ArchivePreview,
  ArchiveView,
  CapacityPolicy,
  CatalogEntry,
  CatalogV06,
  DecisionCard,
  DecisionPreview,
  Deck,
  FieldResolution,
  FileResult,
  JournalTimeline,
  LiveView,
  MaintenanceEvent,
  OutputKey,
  ReadJournalValue,
  RecoveryCoverage,
  ReferenceDraft,
  ReferencePreview,
  SelectedAnswer,
  SubmitV06Value,
  SynthesisPreview,
  TextConnectionView,
  TextOutputState,
  UnifiedHandItem,
  V06PortStamp,
  V06Result,
  VerifiedArchiveEvidence,
} from './contracts-v06.ts';

export type V06CommandPayloads = {
  SaveCatalogEntry: Readonly<{ entry: CatalogEntry; expectedVersion: number | null }>;
  SaveDeck: Readonly<{ deck: Deck; expectedVersion: number | null }>;
  SaveActionCardV5: Readonly<{ actionCard: ActionCardV5; expectedVersion: number | null }>;
  SaveDecisionCard: Readonly<{ decision: DecisionCard; expectedVersion: number | null }>;
  MoveDeckMember: Readonly<{
    entry: VersionRef;
    from: VersionRef;
    to: VersionRef;
    targetIndex: number;
  }>;
  TakeActionMaterial: Readonly<{ action: VersionRef }>;
  TakeEntryMaterial: Readonly<{ entry: VersionRef }>;
  AcceptDecisionAnswer: Readonly<{ selectionId: Id; alsoTakeAction: boolean }>;
  ConfirmSynthesis: Readonly<{ previewId: Id }>;
  ReorderUnifiedHand: Readonly<{ cardIds: readonly Id[] }>;
  CommitReferencePlacement: Readonly<{ previewId: Id }>;
  RetractReference: Readonly<{ reference: VersionRef }>;
  SaveJournalNote: Readonly<{
    id: Id | null;
    expectedVersion: number | null;
    date: LocalDate;
    zone: string;
    text: string;
  }>;
  SaveLegacyJournalBlock: Readonly<{ entry: VersionRef; text: string }>;
  ImportCatalogV4: Readonly<{ previewId: Id; mode: 'merge' | 'replace'; backupEvidenceId: Id }>;
  CommitMonthlyArchive: Readonly<{
    previewId: Id;
    verificationId: Id;
    clearPreviewId: Id;
    removalConfirmed: true;
  }>;
};
/** Separate discriminator: this cannot be sent to createWorkspaceClient.submit. */
export type V06Command = {
  [K in keyof V06CommandPayloads]: Readonly<{
    contractVersion: 'v06-p0-1';
    commandId: Id;
    expected: Token;
    type: K;
    payload: V06CommandPayloads[K];
  }>;
}[keyof V06CommandPayloads];

export type ImportCatalogPreview = Readonly<{
  previewId: Id;
  token: Token;
  format: 'config-v4';
  sourceFingerprint: string;
  catalog: CatalogV06;
  changes: readonly Readonly<{
    kind: 'create' | 'update' | 'pause';
    entityId: Id;
    entityKind: 'action' | 'entry' | 'deck' | 'decision';
  }>[];
  bytes: number;
  issues: readonly Readonly<{ code: string; path: string; message: string; blocking: boolean }>[];
}>;
export interface CatalogPort {
  readCatalog(input: Readonly<{ token: Token }>): Promise<V06Result<LiveView<CatalogV06>>>;
  readDeck(
    input: Readonly<{ token: Token; deckId: Id }>,
  ): Promise<
    V06Result<
      LiveView<
        Readonly<{ deck: Deck; members: readonly (ActionCardV5 | DecisionCard | CatalogEntry)[] }>
      >
    >
  >;
  previewCatalogImport(
    input: Readonly<{ token: Token; text: string }>,
  ): Promise<V06Result<ImportCatalogPreview>>;
}
export interface DecisionPort {
  previewDecision(
    input: Readonly<{ token: Token; decision: VersionRef; deckIds: readonly Id[] }>,
  ): Promise<V06Result<DecisionPreview>>;
  selectDecisionEntry(
    input: Readonly<{
      token: Token;
      previewId: Id;
      choice: Readonly<{ mode: 'random' }> | Readonly<{ mode: 'manual'; entry: VersionRef }>;
    }>,
  ): Promise<V06Result<SelectedAnswer>>;
  previewSynthesis(
    input: Readonly<{
      token: Token;
      inputs: readonly [VersionRef, VersionRef];
      resolutions: readonly FieldResolution[];
    }>,
  ): Promise<V06Result<SynthesisPreview>>;
}
export interface HandPort {
  readUnifiedHand(
    input: Readonly<{ token: Token }>,
  ): Promise<V06Result<LiveView<readonly UnifiedHandItem[]>>>;
  previewReference(
    input: Readonly<{ token: Token; draft: ReferenceDraft }>,
  ): Promise<V06Result<ReferencePreview>>;
}
export interface JournalPort {
  readJournalTimeline(
    input: Readonly<{
      date: LocalDate;
      zone: string;
      source:
        Readonly<{ kind: 'live'; token: Token }> | Readonly<{ kind: 'archive'; archiveId: Id }>;
    }>,
  ): Promise<V06Result<ReadJournalValue>>;
  readJournalDates(
    input: Readonly<{ year: number; month: number }>,
  ): Promise<
    V06Result<Readonly<{ liveDates: readonly LocalDate[]; archiveDates: readonly LocalDate[] }>>
  >;
}
export interface V06BusinessPort extends CatalogPort, DecisionPort, HandPort, JournalPort {
  readonly stamp: V06PortStamp;
  readonly capacityPolicy: CapacityPolicy;
  submit(command: V06Command): Promise<V06Result<SubmitV06Value>>;
  /** Cancels session capabilities only. Must not retract an accepted card or create a receipt. */
  cancelPreview(
    input: Readonly<{ token: Token; previewId: Id }>,
  ): Promise<V06Result<Readonly<{ cancelled: true }>>>;
}
export interface MaintenancePort {
  readonly stamp: V06PortStamp;
  recordMaintenance(
    event: MaintenanceEvent,
  ): Promise<V06Result<Readonly<{ eventId: Id; replayed: boolean; dayRevision: number }>>>;
  readMaintenanceDay(
    input: Readonly<{ epoch: Id; date: LocalDate; zone: string }>,
  ): Promise<
    V06Result<
      Readonly<{ events: readonly MaintenanceEvent[]; dayRevision: number; hasGaps: boolean }>
    >
  >;
}
/** Browser handles remain private to the adapter, never present in UI DTOs/main JSON. */
export interface TextFilePort {
  readonly stamp: V06PortStamp;
  connectTextDirectory(
    input: Readonly<{ epoch: Id; suffix: 'md' | 'txt' }>,
  ): Promise<FileResult<TextConnectionView>>;
  readTextSyncState(
    input: Readonly<{ bindingId: Id }>,
  ): Promise<
    FileResult<Readonly<{ connection: TextConnectionView; outputs: readonly TextOutputState[] }>>
  >;
  refreshTextFiles(
    input: Readonly<{ bindingId: Id; connectionVersion: number; epoch: Id }>,
  ): Promise<FileResult<TextConnectionView>>;
  retryTextOutput(input: Readonly<{ key: OutputKey }>): Promise<FileResult<TextOutputState>>;
  disconnectTextDirectory(
    input: Readonly<{ bindingId: Id; connectionVersion: number }>,
  ): Promise<FileResult<Readonly<{ disconnected: true }>>>;
}
export type ArchiveClearPreview = Readonly<{
  clearPreviewId: Id;
  token: Token;
  archiveId: Id;
  verificationId: Id;
  removableCount: number;
  retainedCount: number;
  sourceFingerprint: string;
}>;
export interface MonthlyArchivePort {
  readonly stamp: V06PortStamp;
  readArchivableMonths(
    input: Readonly<{ token: Token; zone: string }>,
  ): Promise<V06Result<LiveView<readonly ArchivableMonth[]>>>;
  previewMonthlyArchive(
    input: Readonly<{ token: Token; month: string; zone: string }>,
  ): Promise<V06Result<ArchivePreview>>;
  exportMonthlyArchive(
    input: Readonly<{ token: Token; previewId: Id }>,
  ): Promise<V06Result<ArchiveExportArtifact>>;
  /** The adapter must reread the external saved file. Bytes from its export buffer are insufficient. */
  verifySavedArchive(
    input: Readonly<{ token: Token; exportId: Id }>,
  ): Promise<V06Result<VerifiedArchiveEvidence>>;
  previewArchiveClear(
    input: Readonly<{ token: Token; previewId: Id; verificationId: Id }>,
  ): Promise<V06Result<ArchiveClearPreview>>;
  importArchive(
    input: Readonly<{ zip: Blob; filename: string }>,
  ): Promise<V06Result<ArchiveImportValue>>;
  readArchiveIndex(): Promise<V06Result<readonly ArchiveIndexEntry[]>>;
  readArchive(input: Readonly<{ archiveId: Id }>): Promise<V06Result<ArchiveView>>;
  releaseArchive(input: Readonly<{ archiveId: Id }>): Promise<V06Result<ArchiveCacheState>>;
  readArchiveCacheState(): Promise<V06Result<ArchiveCacheState>>;
  readRecoveryCoverage(): Promise<V06Result<RecoveryCoverage>>;
}
/** No archive mutation port: historical files cannot be edited through the viewer. */
export type V06Ports = Readonly<{
  business: V06BusinessPort;
  maintenance: MaintenancePort;
  files: TextFilePort;
  archives: MonthlyArchivePort;
}>;

// Type anchors used by A/B consumers; no runtime factories are exported here.
export type DecisionSelectionView = AnswerSnapshot;
export type JournalViewV06 = JournalTimeline;
