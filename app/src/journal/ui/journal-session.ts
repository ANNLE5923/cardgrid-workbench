// A6 timeline-journal session port. The UI reads a projected timeline (B3
// projectJournalTimeline) for the viewed date and writes independent
// reflections through this port; a test adapter is used first, the real
// note/file sessions are wired in A7. The UI never stores its own copy of the
// automatic segments (they are projected from the dial) and never invents
// timestamps.
import type { Id, Token } from '../../workspace/index.ts';
import type { JournalNote } from '../../workspace/v06.ts';
import type { JournalProjection } from '../model.ts';

export type JournalResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: string; message: string }>;

/** Simplified file-output state; the full reconcile plan is B9 (shown in A7). */
export type JournalFileStatus = 'synced' | 'pending' | 'error' | 'permission-required';
export type JournalFileState = Readonly<{
  status: JournalFileStatus;
  lastSuccessAt: string | null;
  message: string;
}>;

/** A viewed date: live and editable, or a read-only monthly archive. */
export type JournalTimelineView = Readonly<{
  access: 'live' | 'archive';
  editable: boolean;
  date: string;
  zone: string;
  projection: JournalProjection;
}>;

export type SaveNoteRequest = Readonly<{
  id: Id | null;
  date: string;
  zone: string;
  text: string;
  expectedVersion: number | null;
}>;
export type SaveNoteValue = Readonly<{
  note: JournalNote;
  token: Token;
  operation: 'create' | 'update' | 'clear' | 'unchanged';
}>;

export type JournalSessionStamp = Readonly<{
  contractVersion: 'v06-p0-1';
  backend: 'test-adapter' | 'formal';
  release: 'draft' | 'frozen';
}>;

export interface JournalSessionPort {
  readonly stamp: JournalSessionStamp;
  readTimeline(
    input: Readonly<{ date: string; zone: string }>,
  ): Promise<JournalResult<JournalTimelineView>>;
  saveNote(input: SaveNoteRequest): Promise<JournalResult<SaveNoteValue>>;
  readFileState(
    input: Readonly<{ date: string; zone: string }>,
  ): Promise<JournalResult<JournalFileState>>;
  writeFileNow(
    input: Readonly<{ date: string; zone: string }>,
  ): Promise<JournalResult<JournalFileState>>;
  retryFile(
    input: Readonly<{ date: string; zone: string }>,
  ): Promise<JournalResult<JournalFileState>>;
  reauthorizeFile(
    input: Readonly<{ date: string; zone: string }>,
  ): Promise<JournalResult<JournalFileState>>;
}
