/**
 * A1 generic catalog model: pure referential validation for the v0.6 catalog.
 * It covers the cross-entity integrity that the per-DTO shape validator in
 * workspace/v06-validation does not: duplicate ids, broken member / parent /
 * owner / deck references, parent-deck cycles, field-mapping resolution and
 * ambiguities. Unbound lists and shared candidates are explicitly allowed.
 * Pure functions only: no React, no storage, and no runtime workspace import.
 */
import type {
  ActionCardV5,
  CatalogEntry,
  CatalogV06,
  DecisionCard,
  Deck,
  Scalar,
} from '../workspace/v06.ts';

export const MAX_DECK_MEMBERS = 100;

export type CatalogIssueCode =
  | 'DUPLICATE_ID'
  | 'CAPACITY_EXCEEDED'
  | 'DUPLICATE_MEMBER'
  | 'BROKEN_MEMBER_REF'
  | 'BROKEN_PARENT_REF'
  | 'PARENT_CYCLE'
  | 'BROKEN_OWNER_REF'
  | 'BROKEN_DECK_REF'
  | 'CANDIDATE_DECK_KIND'
  | 'DUPLICATE_DECK_REF'
  | 'MAPPING_FIELD_UNKNOWN'
  | 'DUPLICATE_MAPPING'
  | 'MAPPING_PATH_UNRESOLVABLE'
  | 'MAPPING_TYPE_MISMATCH';

export type CatalogIssue = Readonly<{ code: CatalogIssueCode; path: string; message: string }>;
export type CatalogValidation = Readonly<{ valid: boolean; issues: readonly CatalogIssue[] }>;

const make = (code: CatalogIssueCode, path: string, message: string): CatalogIssue => ({
  code,
  path,
  message,
});

const deckKindLabel = (kind: Deck['deckKind']): string =>
  kind === 'entry' ? '资源' : kind === 'action' ? '行动' : '决策';

/** Builds an id index and flags ids that repeat within the same collection. */
function index<T extends { id: string }>(
  items: readonly T[],
  collection: string,
  issues: CatalogIssue[],
): Map<string, T> {
  const map = new Map<string, T>();
  items.forEach((item, i) => {
    if (map.has(item.id))
      issues.push(make('DUPLICATE_ID', `${collection}[${i}]`, `ID「${item.id}」在该集合内重复`));
    else map.set(item.id, item);
  });
  return map;
}

/** Whether a JSON scalar satisfies the value type a FieldSpec declares. */
function scalarMatchesType(value: Scalar, valueType: 'text' | 'number' | 'boolean'): boolean {
  if (value === null) return false;
  if (valueType === 'text') return typeof value === 'string';
  if (valueType === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === 'boolean';
}

/** Ids of decks that sit on a parent cycle (self reference included), each once. */
function detectParentCycles(decks: readonly Deck[], byId: Map<string, Deck>): Set<string> {
  const cyclic = new Set<string>();
  for (const start of decks) {
    const pathIds: string[] = [];
    const inPath = new Set<string>();
    let current: Deck | undefined = start;
    while (current) {
      if (inPath.has(current.id)) {
        const begin = pathIds.indexOf(current.id);
        for (let k = begin; k < pathIds.length; k++) cyclic.add(pathIds[k]);
        break;
      }
      inPath.add(current.id);
      pathIds.push(current.id);
      current = current.parentDeckId === null ? undefined : byId.get(current.parentDeckId);
    }
  }
  return cyclic;
}

export function validateCatalogV06(catalog: CatalogV06): CatalogValidation {
  const issues: CatalogIssue[] = [];

  const actions = index(catalog.actionCards, 'actionCards', issues);
  const entries = index(catalog.catalogEntries, 'catalogEntries', issues);
  const decks = index(catalog.decks, 'decks', issues);
  const decisions = index(catalog.decisionCards, 'decisionCards', issues);

  // --- Decks: members and hierarchy ----------------------------------------
  for (const deck of catalog.decks) {
    const dp = `decks[${deck.id}]`;

    if (deck.memberIds.length > MAX_DECK_MEMBERS)
      issues.push(
        make(
          'CAPACITY_EXCEEDED',
          `${dp}.memberIds`,
          `牌堆最多 ${MAX_DECK_MEMBERS} 个直接成员，当前 ${deck.memberIds.length} 个`,
        ),
      );

    const seenMembers = new Set<string>();
    deck.memberIds.forEach((memberId, i) => {
      const mp = `${dp}.memberIds[${i}]`;
      if (seenMembers.has(memberId))
        issues.push(make('DUPLICATE_MEMBER', mp, `成员「${memberId}」在牌堆内重复`));
      seenMembers.add(memberId);

      const exists =
        deck.deckKind === 'entry'
          ? entries.has(memberId)
          : deck.deckKind === 'action'
            ? actions.has(memberId)
            : decisions.has(memberId);
      if (!exists)
        issues.push(
          make(
            'BROKEN_MEMBER_REF',
            mp,
            `成员「${memberId}」不存在，或不是${deckKindLabel(deck.deckKind)}类型`,
          ),
        );
    });

    if (deck.parentDeckId !== null && !decks.has(deck.parentDeckId))
      issues.push(
        make('BROKEN_PARENT_REF', `${dp}.parentDeckId`, `父牌堆「${deck.parentDeckId}」不存在`),
      );
  }

  for (const id of detectParentCycles(catalog.decks, decks))
    issues.push(make('PARENT_CYCLE', `decks[${id}].parentDeckId`, '牌堆层级不能形成循环'));

  // --- Decisions: owner, candidate decks, mappings --------------------------
  for (const decision of catalog.decisionCards) {
    const dcp = `decisionCards[${decision.id}]`;

    const owner = actions.get(decision.ownerActionId);
    if (!owner)
      issues.push(
        make(
          'BROKEN_OWNER_REF',
          `${dcp}.ownerActionId`,
          `归属行动「${decision.ownerActionId}」不存在`,
        ),
      );

    const seenDecks = new Set<string>();
    const candidateEntries: CatalogEntry[] = [];
    decision.deckIds.forEach((deckId, i) => {
      const path = `${dcp}.deckIds[${i}]`;
      if (seenDecks.has(deckId))
        issues.push(make('DUPLICATE_DECK_REF', path, `候选牌堆「${deckId}」重复`));
      seenDecks.add(deckId);
      const deck = decks.get(deckId);
      if (!deck) {
        issues.push(make('BROKEN_DECK_REF', path, `候选牌堆「${deckId}」不存在`));
        return;
      }
      if (deck.deckKind !== 'entry') {
        issues.push(
          make('CANDIDATE_DECK_KIND', path, `决策候选牌堆「${deckId}」必须是资源（entry）类型`),
        );
        return;
      }
      for (const memberId of deck.memberIds) {
        const entry = entries.get(memberId);
        if (entry) candidateEntries.push(entry);
      }
    });

    const seenFields = new Set<string>();
    decision.mappings.forEach((mapping, i) => {
      const mp = `${dcp}.mappings[${i}]`;
      if (seenFields.has(mapping.fieldId))
        issues.push(
          make(
            'DUPLICATE_MAPPING',
            `${mp}.fieldId`,
            `字段「${mapping.fieldId}」有多条映射，存在歧义`,
          ),
        );
      seenFields.add(mapping.fieldId);

      const field = owner ? owner.fields.find((f) => f.id === mapping.fieldId) : undefined;
      if (!field)
        issues.push(
          make(
            'MAPPING_FIELD_UNKNOWN',
            `${mp}.fieldId`,
            `映射字段「${mapping.fieldId}」不在归属行动的字段定义中`,
          ),
        );

      // An empty candidate set is legal (empty / no decks): runtime shows an
      // empty state, so a mapping cannot be declared unresolvable here.
      if (candidateEntries.length === 0) return;

      if (mapping.entryPath === 'title') {
        if (field && field.valueType !== 'text')
          issues.push(make('MAPPING_TYPE_MISMATCH', mp, '标题只能映射到文本字段'));
        return;
      }

      const attrKey = mapping.entryPath.slice('attributes.'.length);
      const holders = candidateEntries.filter((e) => Object.hasOwn(e.attributes, attrKey));
      if (holders.length === 0) {
        issues.push(
          make('MAPPING_PATH_UNRESOLVABLE', `${mp}.entryPath`, `候选资源都没有属性「${attrKey}」`),
        );
        return;
      }
      if (field && !holders.some((e) => scalarMatchesType(e.attributes[attrKey], field.valueType)))
        issues.push(
          make(
            'MAPPING_TYPE_MISMATCH',
            `${mp}.entryPath`,
            `属性「${attrKey}」的值类型与字段「${field.id}」不匹配`,
          ),
        );
    });
  }

  return { valid: issues.length === 0, issues };
}

/** Convenience guard for editors / import previews: throws on invalid catalogs. */
export class CatalogV06Error extends Error {
  readonly issues: readonly CatalogIssue[];
  constructor(issues: readonly CatalogIssue[]) {
    super(issues[0] ? `${issues[0].path}: ${issues[0].message}` : 'invalid catalog');
    this.name = 'CatalogV06Error';
    this.issues = issues;
  }
}

export function assertValidCatalogV06(catalog: CatalogV06): void {
  const result = validateCatalogV06(catalog);
  if (!result.valid) throw new CatalogV06Error(result.issues);
}
