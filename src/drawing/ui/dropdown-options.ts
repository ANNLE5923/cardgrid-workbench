import {shuffleCandidates} from '../selection.ts';

export const DROPDOWN_CAPACITY = 10;

/** Display sampling never selects a book or changes the full drawing pool. */
export function sampleDropdownIds(ids: readonly string[], limit: number, random: () => number): readonly string[] {
  return ids.length <= limit ? [...ids] : shuffleCandidates(ids, random).slice(0, limit);
}

/** A choice from the full pool remains visible without expanding the menu. */
export function dropdownOptions<T extends Readonly<{id: string}>>(
  candidates: readonly T[], sampledIds: readonly string[], selectedId: string | undefined,
): readonly T[] {
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const result = sampledIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
  const selected = selectedId ? byId.get(selectedId) : undefined;
  if (selected && !result.some(candidate => candidate.id === selected.id)) {
    if (result.length === sampledIds.length && result.length) result[result.length - 1] = selected;
    else result.push(selected);
  }
  return result;
}
