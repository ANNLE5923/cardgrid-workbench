import type {
  ActionCardV5,
  AnswerSnapshot,
  CatalogEntry,
  CatalogV06,
  DecisionCard,
  Deck,
  Scalar,
} from '../workspace/v06.ts';
import type { VersionRef } from '../workspace/index.ts';
import { validateV06Dto } from '../workspace/v06.ts';
import { assertInstant } from '../daily/time.ts';
import { selectCandidate } from '../drawing/selection.ts';
import { fail, id, ref, scalarMatches, uniqueEntity, validateAction } from './rule-checks.ts';

export type DecisionCandidate = Readonly<{
  entry: CatalogEntry;
  sourceDecks: readonly VersionRef[];
}>;
export type DecisionCandidates = Readonly<{
  decision: DecisionCard;
  ownerAction: ActionCardV5;
  candidates: readonly DecisionCandidate[];
}>;
export type AnswerChoice =
  | Readonly<{ mode: 'manual'; entry: VersionRef }>
  | Readonly<{ mode: 'random'; nextUint32: () => number }>;
type CandidateInput = Readonly<{
  catalog: CatalogV06;
  decision: VersionRef;
  deckIds?: readonly string[];
  grandfatheredDecks?: readonly Deck[];
}>;

/** Selected deck order, then direct member order. Shared entries appear once. */
export function collectDecisionCandidates(input: CandidateInput): DecisionCandidates {
  ref(input.decision, 'decision');
  const decision = uniqueEntity(input.catalog.decisionCards, input.decision.id, 'decision');
  validateV06Dto('decision', decision);
  if (decision.version !== input.decision.version)
    fail('ENTRY_STALE', 'decision.version', '决策版本已变化，请重新预览');
  const owner = uniqueEntity(input.catalog.actionCards, decision.ownerActionId, 'ownerActionId');
  validateAction(owner);
  if (decision.status !== 'active' || owner.status !== 'active')
    fail('ENTRY_UNAVAILABLE', 'decision', '决策或归属行动已停用');
  const mapped = new Set<string>();
  for (const mapping of decision.mappings) {
    if (mapped.has(mapping.fieldId) || !owner.fields.some((f) => f.id === mapping.fieldId))
      fail('INVALID_INPUT', 'mappings', '映射字段未知或重复');
    mapped.add(mapping.fieldId);
  }
  const deckIds = input.deckIds ?? decision.deckIds;
  if (new Set(deckIds).size !== deckIds.length)
    fail('INVALID_INPUT', 'deckIds', '不能重复选择牌堆');
  const candidates = new Map<string, DecisionCandidate>();
  for (const deckId of deckIds) {
    id(deckId, 'deckIds');
    if (!decision.deckIds.includes(deckId))
      fail('INVALID_INPUT', 'deckIds', '牌堆不属于该决策的候选来源');
    const deck = uniqueEntity(input.catalog.decks, deckId, 'deckIds');
    if (
      deck.memberIds.length > 100 &&
      input.grandfatheredDecks?.some(
        (original) => JSON.stringify(original) === JSON.stringify(deck),
      )
    ) {
      // Host supplies the exact retained migration snapshot; validate every member, never truncate.
      validateV06Dto('deck', { ...deck, memberIds: [] });
      for (const member of deck.memberIds) id(member, 'memberIds');
      if (new Set(deck.memberIds).size !== deck.memberIds.length)
        fail('INVALID_INPUT', 'memberIds', '成员不能重复');
    } else validateV06Dto('deck', deck);
    if (deck.deckKind !== 'entry') fail('INVALID_INPUT', 'deckIds', '决策候选只能来自收纳条目牌堆');
    for (const entryId of deck.memberIds) {
      const entry = uniqueEntity(input.catalog.catalogEntries, entryId, 'memberIds');
      validateV06Dto('entry', entry);
      if (entry.status !== 'active') continue;
      const existing = candidates.get(entryId),
        source = { id: deck.id, version: deck.version };
      candidates.set(entryId, { entry, sourceDecks: [...(existing?.sourceDecks ?? []), source] });
    }
  }
  return structuredClone({ decision, ownerAction: owner, candidates: [...candidates.values()] });
}

/** One explicit selection creates a detached answer snapshot; no card or fact is persisted. */
export function selectDecisionAnswer(
  input: CandidateInput & Readonly<{ choice: AnswerChoice; at: string }>,
): AnswerSnapshot {
  assertInstant(input.at);
  const pool = collectDecisionCandidates(input);
  const choice = input.choice;
  let candidate: DecisionCandidate | undefined | null;
  if (choice.mode === 'manual') {
    ref(choice.entry, 'choice.entry');
    candidate = pool.candidates.find((c) => c.entry.id === choice.entry.id);
    if (candidate && candidate.entry.version !== choice.entry.version)
      fail('ENTRY_STALE', 'choice.entry.version', '条目版本已变化，请重选');
  } else if (choice.mode === 'random') {
    candidate = selectCandidate(pool.candidates, () => {
      const value = choice.nextUint32();
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
        fail('INVALID_INPUT', 'nextUint32', '随机源须返回 uint32');
      return value;
    });
  } else return fail('INVALID_INPUT', 'choice.mode', '不支持该选择方式');
  if (!candidate) fail('ENTRY_UNAVAILABLE', 'choice', '未选牌堆、没有可用候选或指定条目不可用');
  const fieldValues = [];
  for (const mapping of pool.decision.mappings) {
    let value: Scalar;
    if (mapping.entryPath === 'title') value = candidate.entry.title;
    else {
      const key = mapping.entryPath.slice('attributes.'.length);
      if (!Object.hasOwn(candidate.entry.attributes, key)) continue; // Missing and explicit null stay distinct.
      value = candidate.entry.attributes[key];
    }
    const field = pool.ownerAction.fields.find((f) => f.id === mapping.fieldId)!;
    scalarMatches(value, field, `mappings.${mapping.fieldId}`);
    fieldValues.push({ fieldId: mapping.fieldId, value });
  }
  return structuredClone({
    decision: { id: pool.decision.id, version: pool.decision.version },
    question: pool.decision.question,
    ownerAction: { id: pool.ownerAction.id, version: pool.ownerAction.version },
    entry: candidate.entry,
    sourceDecks: candidate.sourceDecks,
    mappings: pool.decision.mappings,
    fieldValues,
    selectedAt: input.at,
  });
}
