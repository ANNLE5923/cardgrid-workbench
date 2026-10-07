/** Exact legacy catalog conversions, shared by migration preparation and package validation. */
import type { ActionCard, BookEntry, Pool } from './contracts-v3.ts';
import type { ActionCardV5, CatalogEntry, Deck } from './contracts-v06.ts';
// JSON tuple encoding remains injective even for legacy IDs containing lone UTF-16 surrogates.
export const legacyDecisionId = (actionId: string, slotId: string) =>
  `legacy-decision:${JSON.stringify([actionId, slotId])}`;
export const migrateAction = (a: ActionCard): ActionCardV5 => {
  const { slots, ...rest } = structuredClone(a);
  return {
    ...rest,
    fields: slots.map((s) => ({
      id: s.id,
      label: s.label,
      valueType: 'text',
      required: s.required,
    })),
  };
};
export const migrateEntry = (b: BookEntry): CatalogEntry => ({
  id: b.id,
  version: b.version,
  title: b.title,
  attributes: Object.hasOwn(b, 'author') ? { author: b.author } : {},
  url: null,
  status: b.status,
  source: structuredClone(b.source),
});
export const migrateDeck = (p: Pool): Deck => ({
  id: p.id,
  version: p.version,
  name: p.name,
  deckKind: p.poolKind === 'book' ? 'entry' : 'action',
  parentDeckId: p.parentPoolId,
  memberIds: [...p.memberIds],
  source: structuredClone(p.source),
});
