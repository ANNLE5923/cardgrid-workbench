/**
 * v0.5 (Data v4) incremental contracts — pure types only.
 * Adds the day-keyed journal (diary). No command union/Host/runtime here: a command is
 * added to the production union together with its validation and execution (handled in v4-operations).
 */
import type {Id, Instant, LocalDate} from './contracts.ts';
import type {DataV3} from './contracts-v3.ts';

/**
 * A day-keyed free-text diary entry. The journal is NOT an authoritative record — the
 * system archive log is. It therefore does not follow the "facts read-only, annotations
 * append-only" locking rule and may be rewritten freely; it is still stored in the formal
 * workspace through a named command and included in full backups.
 */
export type JournalEntry = Readonly<{
  id: Id; version: number;
  date: LocalDate; zone: string;
  text: string;
  createdAt: Instant; updatedAt: Instant;
}>;

/** New collection is empty on v3→v4 upgrade; existing collections are untouched. */
export type DataV4 = Omit<DataV3, 'version'> & Readonly<{
  version: 4;
  journalEntries: readonly JournalEntry[];
}>;

export type BackupV4 = Readonly<{
  format: 'cardgrid'; version: 4; kind: 'backup';
  dataFormat: 'action-v4'; data: DataV4;
}>;

/** Data versions that expose the v3 workshop/drawing/planner capabilities; v4 is a strict superset. */
export type V3Capable = DataV3 | DataV4;

/** Whether the data already carries the v3 capabilities. Use this instead of `version === 3` gates. */
export function isV3Capable(data: {readonly version: number} | null | undefined): data is V3Capable {
  const version = data?.version;
  return version === 3 || version === 4;
}
