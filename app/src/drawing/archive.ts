/**
 * B1 pure retention/archive rules (no hand Instance, no IndexedDB).
 * Produces ArchiveLog drafts + the copy/instance references B3 must apply in one
 * transaction: write logs -> retract unfinished schedules -> move hand out of the
 * active read model -> delete active copies.
 */
import type {
  ArchiveLog, DailyCopy, GenerationRule, Id, Instant,
} from '../workspace/index.ts';
import { dateAt, nextDate } from '../daily/time.ts';

export type ArchivePlan = Readonly<{
  logs: readonly ArchiveLog[];
  dueCopyIds: readonly Id[];
  /** Accepted instances: retract their unfinished schedules and leave the active read model. */
  instanceIdsToRelease: readonly Id[];
}>;

export type ArchiveInput = Readonly<{
  copies: readonly DailyCopy[];
  /** Needed only to resolve each copy's "today" in the rule's frozen zone. */
  rules: readonly GenerationRule[];
  asOf: Instant;
  newId: () => Id;
}>;

function makeArchiveLog(copy: DailyCopy, at: Instant, logId: Id): ArchiveLog {
  return {
    id: logId, version: 1,
    copyId: copy.id, ruleId: copy.ruleId, actionCard: copy.actionCard,
    sourceDate: copy.sourceDate,
    contentSnapshot: copy.contentSnapshot,
    // B1 does not read the hand; B3 gathers per-instance slot selections when committing.
    slotSelectionsSnapshot: [],
    acceptedInstanceIds: copy.acceptedInstanceIds,
    disposition: copy.acceptedInstanceIds.length > 0 ? 'accepted' : 'none-accepted',
    archivedAt: at,
  };
}

/**
 * Source dates D … D+6 are retained; a copy is due once its sourceDate is today-7
 * or earlier in its rule zone. Idempotency is by copyId: after B3 deletes the copy
 * it no longer appears here, so no duplicate log is produced.
 */
export function planArchive(input: ArchiveInput): ArchivePlan {
  const logs: ArchiveLog[] = [];
  const dueCopyIds: Id[] = [];
  const instanceIdsToRelease: Id[] = [];
  for (const copy of input.copies) {
    if (copy.status !== 'active') continue;
    const rule = input.rules.find(candidate => candidate.id === copy.ruleId);
    const today = dateAt(input.asOf, rule?.zone ?? 'UTC');
    const retainFrom = nextDate(today, -6); // sourceDate >= retainFrom is kept
    if (copy.sourceDate >= retainFrom) continue;

    logs.push(makeArchiveLog(copy, input.asOf, input.newId()));
    dueCopyIds.push(copy.id);
    instanceIdsToRelease.push(...copy.acceptedInstanceIds);
  }
  return { logs, dueCopyIds, instanceIdsToRelease };
}
