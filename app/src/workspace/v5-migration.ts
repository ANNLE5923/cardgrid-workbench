import type { DataV4 } from './contracts-v4.ts';
import type { ActionCard, BookEntry, Pool } from './contracts-v3.ts';
import type {
  ActionCardV5,
  CatalogAlias,
  CatalogEntry,
  DataV5,
  DecisionCard,
  Deck,
  HandCard,
  V06History,
} from './contracts-v06.ts';
import { validateActionData, canonicalJson } from './format.ts';
import { createActionMaterial, renderActionContent } from '../decision/model.ts';
import { dateAt, dayRange, nextDate } from '../daily/time.ts';
import { validateDataV5 } from './v5-format.ts';

import { legacyDecisionId, migrateAction, migrateEntry, migrateDeck } from './v5-catalog.ts';
export { legacyDecisionId, migrateAction, migrateEntry, migrateDeck } from './v5-catalog.ts';

/** Explicit preparation only. Keeps all legacy planner records/history/journal text exactly. */
export function prepareV5Migration(
  old: DataV4,
  options: { workspaceId: string; commandId: string; at: string },
): DataV5 {
  validateActionData(old);
  const { actionCards, bookEntries, pools, version, ...retained } = structuredClone(old);
  const history: V06History[] = [];
  const date = dateAt(options.at, old.settings.zone ?? 'UTC');
  const seed = (
    kind: 'action-card' | 'catalog-entry' | 'deck' | 'decision-card',
    before: any,
    after: any,
  ) =>
    history.push({
      id: `${options.commandId}:seed:${history.length}`,
      commandId: options.commandId,
      at: options.at,
      date,
      type: 'MigrateCatalogV5',
      entity: { kind, id: after.id },
      before,
      after,
    });
  // Existing version chains supply frozen source versions used by old daily copies.
  for (const h of old.planner.history) {
    if (h.entity.kind === 'action-card')
      seed('action-card', h.after, migrateAction(h.after as unknown as ActionCard));
    else if (h.entity.kind === 'book-entry')
      seed('catalog-entry', h.after, migrateEntry(h.after as unknown as BookEntry));
    else if (h.entity.kind === 'pool')
      seed('deck', h.after, migrateDeck(h.after as unknown as Pool));
  }
  const decisionCards: DecisionCard[] = actionCards.flatMap((a) =>
    a.slots.map((s) => ({
      id: legacyDecisionId(a.id, s.id),
      version: a.version,
      question: s.label,
      ownerActionId: a.id,
      deckIds: [s.poolId],
      mappings: [{ fieldId: s.id, entryPath: 'title' }],
      status: a.status,
      source: structuredClone(a.source),
    })),
  );
  if (new Set(decisionCards.map((d) => d.id)).size !== decisionCards.length)
    throw new Error('旧槽位的稳定决策 ID 冲突，迁移已阻止');
  for (const d of decisionCards) {
    const original = actionCards.find((a) => a.id === d.ownerActionId)!;
    seed('decision-card', original, d);
  }
  const catalogAliases: CatalogAlias[] = [
    ...bookEntries.map((b) => ({
      sourceKind: 'book-entry' as const,
      sourceId: b.id,
      targetKind: 'catalog-entry' as const,
      targetId: b.id,
    })),
    ...pools.map((p) => ({
      sourceKind: 'pool' as const,
      sourceId: p.id,
      targetKind: 'deck' as const,
      targetId: p.id,
    })),
    ...actionCards.map((a) => ({
      sourceKind: 'action-card' as const,
      sourceId: a.id,
      targetKind: 'action-card' as const,
      targetId: a.id,
    })),
    ...actionCards.flatMap((a) =>
      a.slots.map((s) => ({
        sourceKind: 'slot' as const,
        sourceId: JSON.stringify([a.id, s.id]),
        targetKind: 'decision-card' as const,
        targetId: legacyDecisionId(a.id, s.id),
      })),
    ),
  ];
  const handCards: HandCard[] = [];
  for (const instance of old.planner.instances) {
    if (
      instance.source.kind !== 'daily-copy' ||
      !instance.daily ||
      instance.source.id !== instance.daily.copyId
    )
      continue;
    const copy = old.dailyCopies.find((c) => c.id === instance.daily!.copyId);
    if (!copy) continue;
    const source = old.planner.history.find(
      (h) =>
        h.entity.kind === 'action-card' &&
        'id' in h.entity &&
        h.entity.id === copy.actionCard.id &&
        (h.after as any)?.version === copy.actionCard.version,
    )?.after as unknown as ActionCard | undefined;
    const rule = old.generationRules.find((r) => r.id === copy.ruleId);
    if (!source || !rule) continue;
    const action = migrateAction(source),
      values = instance.daily.slotSelections.map((s) => ({
        fieldId: s.slotId,
        value: s.entrySnapshot.title,
      }));
    const rendered = renderActionContent(action.content, action.fields, values);
    // Only demonstrably equivalent old accepted content gets a new ownership mapping.
    if (
      canonicalJson(rendered.content) !== canonicalJson(instance.creationSnapshot) ||
      canonicalJson(instance.currentContent) !== canonicalJson(instance.creationSnapshot)
    )
      continue;
    const base = createActionMaterial({
      id: `legacy-material:${JSON.stringify(instance.id)}`,
      at: instance.createdAt,
      action,
      origin: {
        kind: 'daily-copy',
        copy: { id: copy.id, version: 1 },
        sourceDate: copy.sourceDate,
        zone: rule.zone,
        expiresAt: dayRange(nextDate(copy.sourceDate, 7), rule.zone).startAt,
      },
    });
    const card: HandCard = {
      ...base,
      kind: 'composite',
      actionInstanceId: instance.id,
      contentSnapshot: structuredClone(instance.currentContent),
      fieldValues: values,
      state: instance.state === 'withdrawn' ? 'withdrawn' : 'available',
    };
    handCards.push(card);
    history.push({
      id: `${options.commandId}:mapped:${history.length}`,
      commandId: options.commandId,
      at: options.at,
      date,
      type: 'MigrateHandV5',
      entity: { kind: 'hand-card', id: card.id },
      before: null,
      after: card as any,
    });
  }
  const data: DataV5 = {
    ...retained,
    version: 5,
    workspaceId: options.workspaceId,
    actionCards: actionCards.map(migrateAction),
    catalogEntries: bookEntries.map(migrateEntry),
    decks: pools.map(migrateDeck),
    decisionCards,
    planner: { ...retained.planner, history: [...old.planner.history, ...history] },
    handCards,
    referencePlacements: [],
    factReferenceSnapshots: [],
    journalNotes: [],
    catalogAliases,
    archiveIndex: [],
  };
  validateDataV5(data);
  return data;
}
