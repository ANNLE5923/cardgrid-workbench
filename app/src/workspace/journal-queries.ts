import type {WorkspaceSnapshot} from './commands.ts';
import type {Result} from './contracts.ts';
import type {JournalEntry} from './contracts-v4.ts';
import {commandFailure} from './commands.ts';

export type JournalView = Readonly<{
  entry: JournalEntry | null;
  /** Set when the loaded entry's zone differs from the requested zone (cross-zone fallback). */
  fallbackZone: string | null;
}>;

const hasText = (entry: JournalEntry): boolean => entry.text.trim().length > 0;

/** Read-only journal projections. Browsing and switching dates never create data. */
export function journalQueries(read: () => Promise<WorkspaceSnapshot>) {
  const run = async <T>(fn: (entries: readonly JournalEntry[]) => T): Promise<Result<T>> => {
    try {
      const snapshot = await read();
      const entries = snapshot.data?.version === 4 ? snapshot.data.journalEntries : [];
      return {ok: true, value: structuredClone(fn(entries))};
    } catch (error) { return commandFailure(error); }
  };
  return {
    /** Prefer the exact (date, zone) entry; otherwise the newest entry on that date (any zone). */
    readJournal(input: {date: string; zone: string}) {
      return run(entries => {
        const match = entries.find(e => e.date === input.date && e.zone === input.zone) ?? null;
        if (match) return {entry: match, fallbackZone: null};
        const sameDate = entries.filter(e => e.date === input.date)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const fallback = sameDate[0] ?? null;
        return {entry: fallback, fallbackZone: fallback ? fallback.zone : null};
      });
    },
    /** Nearest dated entries with non-blank text on either side; blank days are skipped. */
    readJournalNeighbors(input: {date: string}) {
      return run(entries => {
        const dates = [...new Set(entries.filter(hasText).map(e => e.date))].sort();
        let prev: string | null = null, next: string | null = null;
        for (const d of dates) { if (d < input.date) prev = d; if (d > input.date && next === null) next = d; }
        return {prev, next};
      });
    },
    /** Distinct dates carrying non-blank text in the given month, for calendar dots. */
    readJournalMonth(input: {year: number; month: number}) {
      return run(entries => {
        const prefix = `${input.year}-${String(input.month).padStart(2, '0')}-`;
        const dates = [...new Set(entries.filter(e => hasText(e) && e.date.startsWith(prefix)).map(e => e.date))];
        return {dates};
      });
    },
  };
}
