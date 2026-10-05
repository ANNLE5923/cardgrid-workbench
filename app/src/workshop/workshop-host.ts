import type {
  ActionCard, BookEntry, GenerationRule, Pool,
} from '../workspace/index.ts';
import type { WorkshopContext, WorkshopIssue } from './model.ts';

export type SaveOutcome<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: string; message: string; issues?: readonly WorkshopIssue[] }>;

/** Port the workshop UI depends on. The real IndexedDB-backed host is implemented in B3. */
export type WorkshopHost = Readonly<{
  load: () => Promise<SaveOutcome<WorkshopContext>>;
  saveActionCard: (draft: ActionCard) => Promise<SaveOutcome<ActionCard>>;
  saveBookEntry: (draft: BookEntry) => Promise<SaveOutcome<BookEntry>>;
  savePool: (draft: Pool) => Promise<SaveOutcome<Pool>>;
  saveGenerationRule: (draft: GenerationRule) => Promise<SaveOutcome<GenerationRule>>;
}>;
