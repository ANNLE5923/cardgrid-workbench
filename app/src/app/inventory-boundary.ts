import type { WorkspaceData } from '../workspace/index.ts';
import { isV3Capable } from '../workspace/contracts-v4.ts';
import { dateAt, dayRange } from '../daily/time.ts';

/** One foreground day-boundary wake-up, using each rule's frozen zone, never the browsed date. */
export function inventoryBoundary(data: WorkspaceData | null, at: string): string | null {
  if (!isV3Capable(data)) return null;
  const zones = new Set(
    data.generationRules
      .filter(
        (rule) =>
          rule.status === 'active' || data.dailyCopies.some((copy) => copy.ruleId === rule.id),
      )
      .map((rule) => rule.zone),
  );
  const boundaries = [...zones].map((zone) => dayRange(dateAt(at, zone), zone).endAt).sort();
  return boundaries[0] ?? null;
}
