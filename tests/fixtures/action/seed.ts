import type { Content, DataV2, RecordedRange } from '../../../src/action-contract.ts';
import { plannedRange } from '../../../src/action-time.ts';
import type { TransitionContext } from '../../../src/action-domain.ts';

export function content(presetMinutes: number | null = 15): Content {
  return { title: '合成行动', criteria: '完成一项合成结果', presetMinutes, color: '#248866', minimum: false,
    categoryId: null, categoryLabel: null, projectIds: [], goalIds: [], projectLabels: [], goalLabels: [] };
}
export function empty(): DataV2 {
  return { version: 2, settings: { zone: null, preferences: { theme: 'paper', density: 'comfortable', startHour: 8, endHour: 23, defaultMinutes: 15 }, categories: [] },
    planner: { version: 2, definitions: [], instances: [], handOrder: [], plans: [], facts: [], annotations: [], fixed: [], templates: [], days: [], rules: [], occurrences: [], captures: [], refs: [], goals: [], history: [] },
    legacySources: [], migrationBindings: [], commandReceipts: [] };
}
export function context(id: string, at = '2026-09-26T01:30:00Z'): TransitionContext {
  return { commandId: `command-${id}`, historyId: `history-${id}`, at, date: '2026-09-26' };
}
export function range(time = '09:00', minutes = 15, date = '2026-09-26', zone = 'Asia/Shanghai'): RecordedRange {
  return plannedRange({ date, time, zone }, minutes);
}
