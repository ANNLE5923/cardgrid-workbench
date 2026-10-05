import type {BookEntry, DailyCopy, Pool, SlotSelection} from '../workspace/index.ts';
import {ActionDomainError, sameValue} from '../daily/model.ts';
import {assertInstant, compareInstants} from '../daily/time.ts';

export type ComboPreview = Readonly<{
  copy: DailyCopy;
  composedText: string;
  selections: readonly SlotSelection[];
  missingSlotIds: readonly string[];
  ready: boolean;
  slots: readonly Readonly<{id: string; label: string; required: boolean; candidates: readonly BookEntry[]}>[];
}>;
/** Concrete choices only. Previewing or composing never consumes randomness. */
export function composeDailyCopy(copy: DailyCopy, selections: readonly SlotSelection[], books: readonly BookEntry[], pools: readonly Pool[], at: string): ComboPreview {
  assertInstant(at);
  const seen = new Set<string>();
  for (const selection of selections) {
    const slot = copy.slotSpecSnapshot.find(s => s.id === selection.slotId);
    if (!slot || seen.has(selection.slotId)) throw new ActionDomainError('INVALID_INPUT', '槽位未知或重复');
    seen.add(selection.slotId);
    const pool = pools.find(p => p.id === slot.poolId && p.poolKind === 'book');
    const book = books.find(b => b.id === selection.entryId);
    if (!book || book.status !== 'active') throw new ActionDomainError('ENTRY_ARCHIVED', '已选书目被归档或不存在，请重选');
    if (!pool?.memberIds.includes(book.id)) throw new ActionDomainError('ENTRY_STALE', '书目已不属于槽位绑定的牌堆，请重选');
    if (selection.entrySnapshot.id !== book.id || !sameValue(selection.entrySnapshot, book)) throw new ActionDomainError('ENTRY_STALE', '书目版本已变化，请核对后重选');
    assertInstant(selection.selectedAt);
    if (compareInstants(selection.selectedAt, at) > 0 || compareInstants(selection.selectedAt, copy.generatedAt) < 0)
      throw new ActionDomainError('INVALID_INPUT', '词条选择时间无效');
  }
  const slots = copy.slotSpecSnapshot.map(slot => {
    const pool = pools.find(p => p.id === slot.poolId && p.poolKind === 'book');
    return {...slot, candidates: books.filter(book => book.status === 'active' && pool?.memberIds.includes(book.id))};
  });
  const missingSlotIds = slots.filter(slot => slot.required && !selections.some(s => s.slotId === slot.id)).map(s => s.id);
  const byLabel = new Map<string, typeof copy.slotSpecSnapshot[number]>();
  for (const slot of copy.slotSpecSnapshot) {
    if (byLabel.has(slot.label)) throw new ActionDomainError('INVALID_INPUT', '槽位文字标签重复，无法确定合成文字');
    byLabel.set(slot.label, slot);
  }
  // One pass avoids treating braces inside a book title as another template instruction.
  const composedText = copy.contentSnapshot.title.replace(/\{([^{}]+)\}/g, (original, label: string) => {
    const slot = byLabel.get(label);
    if (!slot) return original;
    return selections.find(s => s.slotId === slot.id)?.entrySnapshot.title ?? '';
  });
  return {copy: structuredClone(copy), composedText, selections: structuredClone(selections), missingSlotIds, ready: missingSlotIds.length === 0, slots};
}
