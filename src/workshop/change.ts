import type {Instant, LocalDate} from '../workspace/index.ts';
import {dateAt, assertInstant} from '../daily/time.ts';
import {validateWorkshopChange, workshopCollections, type WorkshopCatalog, type WorkshopValidation} from './catalog.ts';
import {WorkshopChecks, freezeCopy, sameWorkshopValue} from './validation.ts';

export type WorkshopChangeContext = Readonly<{at: Instant}>;
export type WorkshopRevision = {
  [K in keyof WorkshopCatalog]: Readonly<{
    collection: K;
    before: WorkshopCatalog[K][number] | null;
    after: WorkshopCatalog[K][number];
  }>
}[keyof WorkshopCatalog];
export type PreparedWorkshopChange = Readonly<{
  at: Instant;
  catalog: WorkshopCatalog;
  revisions: readonly WorkshopRevision[];
}>;

/** Host supplies its command instant. This result is a save plan, never a save receipt. */
export function prepareWorkshopChange(before: unknown, after: unknown, context: unknown): WorkshopValidation<PreparedWorkshopChange> {
  const checks = new WorkshopChecks(), input = checks.record(context, 'context');
  if (input) {
    checks.exact(input, ['at'], 'context');
    if (checks.text(input.at, 'context.at')) {
      try {assertInstant(input.at);} catch {checks.issue('INVALID_VALUE', 'context.at', '保存时间须为有效的明确 UTC 时间点');}
    }
  }
  if (checks.issues.length) return {ok: false, issues: checks.issues};
  const result = validateWorkshopChange(before, after);
  if (!result.ok) return result;
  // validateWorkshopChange has validated and copied both catalogs before this projection.
  const previous = before as WorkshopCatalog;
  const revisions: WorkshopRevision[] = [];
  for (const collection of workshopCollections) {
    const originals = new Map(previous[collection].map(item => [item.id, item]));
    for (const item of result.value[collection]) {
      const original = originals.get(item.id) ?? null;
      if (original && sameWorkshopValue(original, item)) continue;
      revisions.push({collection, before: original, after: item} as WorkshopRevision);
    }
  }
  return {ok: true, value: freezeCopy({at: (input as WorkshopChangeContext).at, catalog: result.value, revisions})};
}

/** New versions apply from the save's local day in each rule's frozen zone. */
export function workshopChangeEffectiveDate(change: Pick<PreparedWorkshopChange, 'at'>, ruleZone: string): LocalDate {
  return dateAt(change.at, ruleZone);
}
