/**
 * B1 pure generation rules (no hand Instance, no IndexedDB).
 * Produces deterministic daily copies + ledger entries for B3 to commit.
 */
import type {
  ActionCard, DailyCopy, GenerationLedger, GenerationLedgerEntry, GenerationRule, Id, Instant, LocalDate,
} from '../workspace/index.ts';
import { dateAt, nextDate, weekday } from '../daily/time.ts';

export type B1ErrorCode =
  | 'RULE_NOT_FOUND' | 'RULE_NOT_ACTIVE' | 'ACTION_CARD_MISSING'
  | 'DATE_OUTSIDE_RETENTION' | 'FUTURE_DATE' | 'ACTION_CARD_INACTIVE';

export type RuleResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: B1ErrorCode; message: string }>;

export type SkipReason =
  | 'rule-inactive' | 'schedule-miss' | 'already-generated' | 'action-card-missing' | 'action-card-inactive';
export type SkipEntry = Readonly<{ ruleId: Id; sourceDate: LocalDate; reason: SkipReason }>;

export type GenerationOutcome = Readonly<{
  copies: readonly DailyCopy[];
  ledgerEntries: readonly GenerationLedgerEntry[];
  skipped: readonly SkipEntry[];
}>;

export type GenerationInput = Readonly<{
  rules: readonly GenerationRule[];
  actionCards: readonly ActionCard[];
  ledger: GenerationLedger;
  /** Explicit coordination instant (UTC). Source dates resolve in each rule's frozen zone. */
  at: Instant;
  newId: () => Id;
}>;

export type ManualTarget = Readonly<{ ruleId: Id; date: LocalDate }>;

const EMPTY_OUTCOME: GenerationOutcome = { copies: [], ledgerEntries: [], skipped: [] };

function ok<T>(value: T): RuleResult<T> { return { ok: true, value }; }
function fail<T>(code: B1ErrorCode, message: string): RuleResult<T> { return { ok: false, code, message }; }

/** weekday() uses 0=Sunday … 6=Saturday (see daily/time.weekday). */
function scheduleHits(rule: GenerationRule, sourceDate: LocalDate): boolean {
  if (sourceDate < rule.startDate) return false;
  if (rule.schedule.mode === 'daily') return true;
  return rule.schedule.weekdays.includes(weekday(sourceDate));
}

function isGenerated(ledger: GenerationLedger, ruleId: Id, sourceDate: LocalDate): boolean {
  return ledger.some(entry => entry.ruleId === ruleId && entry.sourceDate === sourceDate);
}

function makeCopy(rule: GenerationRule, card: ActionCard, sourceDate: LocalDate, at: Instant, newId: () => Id)
  : Readonly<{ copy: DailyCopy; ledgerEntry: GenerationLedgerEntry }> {
  const copyId = newId();
  const copy: DailyCopy = {
    id: copyId, version: 1,
    ruleId: rule.id, ruleVersion: rule.version,
    actionCard: { id: card.id, version: card.version },
    sourceDate, generatedAt: at,
    contentSnapshot: structuredClone(card.content), slotSpecSnapshot: structuredClone(card.slots),
    status: 'active', acceptedInstanceIds: [],
  };
  return { copy, ledgerEntry: { ruleId: rule.id, sourceDate, copyId, at } };
}

/** Automatic: only the current day in each active rule's zone. Never back-fills missing days. */
export function runDailyGeneration(input: GenerationInput): GenerationOutcome {
  const copies: DailyCopy[] = [];
  const ledgerEntries: GenerationLedgerEntry[] = [];
  const skipped: SkipEntry[] = [];
  for (const rule of input.rules) {
    if (rule.status !== 'active') {
      skipped.push({ ruleId: rule.id, sourceDate: dateAt(input.at, rule.zone), reason: 'rule-inactive' });
      continue;
    }
    const sourceDate = dateAt(input.at, rule.zone);
    if (!scheduleHits(rule, sourceDate)) { skipped.push({ ruleId: rule.id, sourceDate, reason: 'schedule-miss' }); continue; }
    if (isGenerated(input.ledger, rule.id, sourceDate)) { skipped.push({ ruleId: rule.id, sourceDate, reason: 'already-generated' }); continue; }
    const card = input.actionCards.find(candidate => candidate.id === rule.actionCardId);
    if (!card) { skipped.push({ ruleId: rule.id, sourceDate, reason: 'action-card-missing' }); continue; }
    if (card.status !== 'active') { skipped.push({ruleId: rule.id, sourceDate, reason: 'action-card-inactive'}); continue; }
    const made = makeCopy(rule, card, sourceDate, input.at, input.newId);
    copies.push(made.copy); ledgerEntries.push(made.ledgerEntry);
  }
  return { copies, ledgerEntries, skipped };
}

/**
 * Manual back-fill of one explicitly requested date, using the same idempotency.
 * The retention window is today-6 … today; future dates and dates older than the
 * window are rejected outright (no "generate then delete").
 */
export function runManualGeneration(input: GenerationInput, target: ManualTarget): RuleResult<GenerationOutcome> {
  const rule = input.rules.find(candidate => candidate.id === target.ruleId);
  if (!rule) return fail('RULE_NOT_FOUND', '生成规则不存在');
  if (rule.status !== 'active') return fail('RULE_NOT_ACTIVE', '规则已暂停或归档，不能补生成');

  const today = dateAt(input.at, rule.zone);
  const earliest = nextDate(today, -6);
  if (target.date > today) return fail('FUTURE_DATE', '不能补生成未来日期');
  if (target.date < earliest) return fail('DATE_OUTSIDE_RETENTION', '超出七天保留期，不能补生成');

  if (!scheduleHits(rule, target.date))
    return ok({ copies: [], ledgerEntries: [], skipped: [{ ruleId: rule.id, sourceDate: target.date, reason: 'schedule-miss' }] });
  if (isGenerated(input.ledger, rule.id, target.date))
    return ok({ copies: [], ledgerEntries: [], skipped: [{ ruleId: rule.id, sourceDate: target.date, reason: 'already-generated' }] });

  const card = input.actionCards.find(candidate => candidate.id === rule.actionCardId);
  if (!card) return fail('ACTION_CARD_MISSING', '规则引用的行动原卡不存在');
  if (card.status !== 'active') return fail('ACTION_CARD_INACTIVE', '行动原卡已暂停或归档');

  const made = makeCopy(rule, card, target.date, input.at, input.newId);
  return ok({ copies: [made.copy], ledgerEntries: [made.ledgerEntry], skipped: [] });
}

export { EMPTY_OUTCOME };
