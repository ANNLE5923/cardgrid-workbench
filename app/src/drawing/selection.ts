import type { Definition } from '../workspace/index.ts';

export type DefinitionFilter = Readonly<{ categoryId?: string | null; minimum?: boolean }>;

/** Candidate selection is read-only. Acceptance remains a separate workspace command. */
export function suggestDefinition(
  definitions: readonly Definition[],
  filter: DefinitionFilter,
  random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0],
): Definition | null {
  const eligible = definitions.filter(
    (d) =>
      d.enabled &&
      (filter.categoryId === undefined || d.content.categoryId === filter.categoryId) &&
      (!filter.minimum || d.content.minimum),
  );
  return selectCandidate(eligible, random);
}
/** Both action and book pools use the existing uint32 rejection sampler. */
export function selectCandidate<T>(
  eligible: readonly T[],
  random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0],
): T | null {
  if (!eligible.length) return null;
  return eligible[randomIndex(eligible.length, random)];
}
function randomIndex(length: number, random: () => number): number {
  // Preserve the existing rejection sampler: modulo bias must not favor a candidate.
  const bound = Math.floor(0x100000000 / length) * length;
  let value: number;
  do {
    value = random();
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new Error('随机源须返回 uint32');
  } while (value >= bound);
  return value % length;
}

/** Shuffle positions once on entry, never when a card is stopped or revealed. */
export function shuffleCandidates<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, random);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
