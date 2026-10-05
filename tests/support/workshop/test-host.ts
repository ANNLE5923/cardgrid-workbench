/**
 * In-memory test adapter for A2. It is NOT a real save: state is lost on reload and
 * it must never be presented as persisted. The UI labels it explicitly; B3 supplies
 * the IndexedDB host implementing the same WorkshopHost port.
 */
import type {
  ActionCard, BookEntry, GenerationRule, Pool,
} from '../../../src/workspace/index.ts';
import {
  EMPTY_CONTEXT, bumpVersion,
  validateActionDraft, validateBookDraft, validatePoolDraft, validateRuleDraft,
  type WorkshopContext, type WorkshopIssue,
} from '../../../src/workshop/model.ts';
import type { SaveOutcome, WorkshopHost } from '../../../src/workshop/index.ts';

const rejected = (issues: readonly WorkshopIssue[]): SaveOutcome<never> => ({
  ok: false, code: 'VALIDATION_FAILED', message: issues.map(i => i.message).join('；'), issues,
});

export type TestWorkshopHost = WorkshopHost & Readonly<{
  snapshot: () => WorkshopContext;
  readonly adapter: 'in-memory-test';
}>;

export function createTestWorkshopHost(seed: WorkshopContext = EMPTY_CONTEXT): TestWorkshopHost {
  let state: WorkshopContext = structuredClone(seed);

  const apply = <T extends { id: string; version: number }>(list: readonly T[], draft: T): readonly T[] => {
    const existing = list.find(item => item.id === draft.id);
    return existing
      ? list.map(item => (item.id === draft.id ? { ...draft, version: bumpVersion(existing.version) } : item))
      : [...list, draft];
  };
  const asSaved = <T extends { id: string; version: number }>(list: readonly T[], draft: T): T => {
    const existing = list.find(item => item.id === draft.id);
    return existing ? { ...draft, version: bumpVersion(existing.version) } : draft;
  };

  const host: TestWorkshopHost = {
    adapter: 'in-memory-test',
    snapshot: () => structuredClone(state),
    load: async () => ({ ok: true, value: structuredClone(state) }),

    saveBookEntry: async draft => {
      const issues = validateBookDraft(draft);
      if (issues.length) return rejected(issues);
      const saved = asSaved(state.bookEntries, draft);
      state = { ...state, bookEntries: apply(state.bookEntries, draft) };
      return { ok: true, value: saved };
    },
    saveActionCard: async draft => {
      const issues = validateActionDraft(draft, state);
      if (issues.length) return rejected(issues);
      const saved = asSaved(state.actionCards, draft);
      state = { ...state, actionCards: apply(state.actionCards, draft) };
      return { ok: true, value: saved };
    },
    savePool: async draft => {
      const issues = validatePoolDraft(draft, state);
      if (issues.length) return rejected(issues);
      const saved = asSaved(state.pools, draft);
      state = { ...state, pools: apply(state.pools, draft) };
      return { ok: true, value: saved };
    },
    saveGenerationRule: async draft => {
      const issues = validateRuleDraft(draft, state);
      if (issues.length) return rejected(issues);
      const saved = asSaved(state.rules, draft);
      state = { ...state, rules: apply(state.rules, draft) };
      return { ok: true, value: saved };
    },
  };
  return host;
}
