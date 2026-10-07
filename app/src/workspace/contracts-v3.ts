/**
 * v0.3 (Data v3) incremental contracts — pure types only.
 * No command union, no Host, no runtime: adding a command to the production Command
 * union requires shipping its validation and execution (handled in B3), so that is
 * intentionally NOT done here.
 */
import type {
  Content,
  Id,
  Instant,
  LocalDate,
  SourceRef as SourceRefV2,
  VersionRef,
  DataV2,
  ConfigV2,
} from './contracts.ts';

export type SlotId = Id;

/** Daily-copy provenance extends the v2 SourceRef union. */
export type SourceRefV3 = SourceRefV2 | Readonly<{ kind: 'daily-copy'; id: Id }>;

export type WorkshopEntityStatus = 'active' | 'paused' | 'archived';

/** A slot binds to one preset pool. v0.3 slots reference concrete entries only (no recursion). */
export type SlotSpec = Readonly<{
  id: SlotId;
  label: string;
  poolId: Id;
  required: boolean;
  valueKind: 'entry';
}>;

/** Action source card maintained in the workshop. */
export type ActionCard = Readonly<{
  id: Id;
  version: number;
  kind: 'action';
  content: Content;
  slots: readonly SlotSpec[];
  status: WorkshopEntityStatus;
  parentId: Id | null;
  source: SourceRefV3;
}>;

/** Book entry: title required, author optional. Resident (not generated daily). */
export type BookEntry = Readonly<{
  id: Id;
  version: number;
  kind: 'book';
  title: string;
  author: string | null;
  status: 'active' | 'archived';
  source: SourceRefV3;
}>;

export type PoolKind = 'action' | 'book';
/** Pools are isolated by kind; parent/child ids express navigation layers. */
export type Pool = Readonly<{
  id: Id;
  version: number;
  name: string;
  poolKind: PoolKind;
  parentPoolId: Id | null;
  memberIds: readonly Id[];
  source: SourceRefV3;
}>;

export type GenerationSchedule =
  Readonly<{ mode: 'daily' }> | Readonly<{ mode: 'weekdays'; weekdays: readonly number[] }>;

export type GenerationRule = Readonly<{
  id: Id;
  version: number;
  name: string;
  actionCardId: Id;
  schedule: GenerationSchedule;
  startDate: LocalDate;
  zone: string;
  status: WorkshopEntityStatus;
  source: SourceRefV3;
}>;

/** A concrete slot choice frozen at acceptance. Required slots always carry an entry. */
export type SlotSelection = Readonly<{
  slotId: SlotId;
  entryId: Id;
  entrySnapshot: BookEntry;
  selectedAt: Instant;
}>;

/** Attached to an Instance only when it originates from a daily copy. */
export type DailyAcceptance = Readonly<{
  copyId: Id;
  sourceDate: LocalDate;
  slotSelections: readonly SlotSelection[];
}>;

export type DailyCopyStatus = 'active' | 'archived';

/** Daily copy: independent identity; stock status is separate from hand status. */
export type DailyCopy = Readonly<{
  id: Id;
  version: number;
  ruleId: Id;
  ruleVersion: number;
  actionCard: VersionRef;
  sourceDate: LocalDate;
  generatedAt: Instant;
  contentSnapshot: Content;
  slotSpecSnapshot: readonly SlotSpec[];
  status: DailyCopyStatus;
  acceptedInstanceIds: readonly Id[];
}>;

/**
 * Candidates are not exhaustible and acceptance has no upper bound, so there is no
 * defined "all accepted" state. Disposition is therefore binary.
 */
export type ArchiveDisposition = 'accepted' | 'none-accepted';

export type ArchiveLog = Readonly<{
  id: Id;
  version: number;
  copyId: Id;
  ruleId: Id;
  actionCard: VersionRef;
  sourceDate: LocalDate;
  contentSnapshot: Content;
  slotSelectionsSnapshot: readonly SlotSelection[];
  acceptedInstanceIds: readonly Id[];
  disposition: ArchiveDisposition;
  archivedAt: Instant;
}>;

/** Generation bookkeeping: a (ruleId, sourceDate) is generated once it is recorded
 * here, regardless of whether the copy later survives — this prevents regeneration. */
export type GenerationLedgerEntry = Readonly<{
  ruleId: Id;
  sourceDate: LocalDate;
  copyId: Id;
  at: Instant;
}>;
export type GenerationLedger = readonly GenerationLedgerEntry[];

/** In-session combo draft; cancelling creates no action. */
export type ComboSelection = Readonly<{
  slotId: SlotId;
  mode: 'random' | 'manual';
  entryId: Id | null;
}>;
export type ComboDraft = Readonly<{
  copyId: Id;
  selections: readonly ComboSelection[];
  composedText: string;
}>;

/** New collections are empty on explicit v2 upgrade; version history lives in planner.history. */
export type DataV3 = Omit<DataV2, 'version'> &
  Readonly<{
    version: 3;
    actionCards: readonly ActionCard[];
    bookEntries: readonly BookEntry[];
    pools: readonly Pool[];
    generationRules: readonly GenerationRule[];
    dailyCopies: readonly DailyCopy[];
    archiveLogs: readonly ArchiveLog[];
    generationLedger: GenerationLedger;
  }>;
export type BackupV3 = Readonly<{
  format: 'cardgrid';
  version: 3;
  kind: 'backup';
  dataFormat: 'action-v3';
  data: DataV3;
}>;
export type ConfigV3 = Omit<ConfigV2, 'version' | 'config'> &
  Readonly<{
    version: 3;
    config: ConfigV2['config'] &
      Pick<DataV3, 'actionCards' | 'bookEntries' | 'pools' | 'generationRules'>;
  }>;
