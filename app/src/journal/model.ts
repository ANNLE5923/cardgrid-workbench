/** v0.6 B3 pure projections and edits; no Host, React, storage or file writes. */
export {
  projectJournalTimeline,
  type JournalProjection,
  type JournalRow,
  type JournalProjectionInput,
} from './timeline.ts';
export {
  prepareJournalNote,
  prepareLegacyJournalEdit,
  toLegacyJournalBlock,
  type JournalEditDraft,
  type JournalEditContext,
} from './records.ts';
export { renderJournalText, prepareJournalText } from './text.ts';
