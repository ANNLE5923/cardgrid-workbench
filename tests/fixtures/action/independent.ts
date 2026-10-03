// 2B: literal contract fixtures. No domain transition, migration, or time adapter builds the oracle.
import type { Content, DataV2, EnvelopeV4, RecordedRange } from '../../../src/workspace/contracts.ts';

export const AT = '2026-09-28T02:00:00Z';
export function content(minutes: number | null = 30): Content {
  return { title: '独立合成行动', criteria: '完成一个可核对结果', presetMinutes: minutes, minimum: false,
    color: '#336699', categoryId: null, categoryLabel: null, projectIds: [], goalIds: [], projectLabels: [], goalLabels: [] };
}
export function blank(): DataV2 {
  return { version: 2, settings: { zone: 'Asia/Shanghai', preferences: { theme: 'paper', density: 'comfortable', startHour: 8, endHour: 23, defaultMinutes: 15 }, categories: [] },
    planner: { version: 2, definitions: [], instances: [], handOrder: [], plans: [], facts: [], annotations: [], fixed: [], templates: [], days: [], rules: [], occurrences: [], captures: [], refs: [], goals: [], history: [] },
    legacySources: [], migrationBindings: [], commandReceipts: [] };
}
export function shanghai(start = '09:00', minutes = 30, date = '2026-09-28'): RecordedRange {
  const startAt = new Date(`${date}T${start}:00+08:00`), endAt = new Date(startAt.getTime() + minutes * 60000);
  const utc = (value: Date) => value.toISOString().replace('.000Z', 'Z');
  const local = (value: Date) => new Date(value.getTime() + 8 * 3600000).toISOString().slice(0, 16);
  return { startAt: utc(startAt), endAt: utc(endAt), zone: 'Asia/Shanghai', localStart: local(startAt), localEnd: local(endAt), startOffset: '+08:00', endOffset: '+08:00' };
}
export function hand(): DataV2 {
  const data = blank();
  return { ...data, planner: { ...data.planner,
    instances: [{ id: 'i', version: 7, definition: null, creationSnapshot: content(), currentContent: content(), source: { kind: 'manual' }, createdAt: AT, targetDate: null, state: 'open', occurrenceId: null, makeupOf: null }], handOrder: ['i'] } };
}
export function planned(): DataV2 {
  const data = hand();
  return { ...data, planner: { ...data.planner, handOrder: [], plans: [{ id: 'p', version: 4, instanceId: 'i', range: shanghai(), contentSnapshot: content(), status: 'active', createdAt: AT, changedAt: AT }] } };
}
export function confirmed(): DataV2 {
  const data = planned();
  return { ...data, planner: { ...data.planner, plans: [{ ...data.planner.plans[0], status: 'confirmed', version: 5 }],
    facts: [{ id: 'f', instanceId: 'i', contentSnapshot: content(), actualRange: shanghai('09:20', 40), confirmedAt: AT, source: { kind: 'manual' },
      plannedSnapshot: { planId: 'p', planVersion: 4, range: shanghai(), content: content() } }],
    annotations: [{ id: 'a', factId: 'f', text: '第一条说明', createdAt: AT }] } };
}
export function fixed(): DataV2 {
  const data = hand();
  return { ...data, planner: { ...data.planner, fixed: [
    { id: 'x', version: 3, title: '固定甲', range: shanghai('09:15', 30), cancelled: false, ownerDate: '2026-09-28', template: null, templateEntryId: null, manuallyOverridden: false, source: { kind: 'manual' } },
    { id: 'y', version: 2, title: '固定乙', range: shanghai('10:00', 30), cancelled: false, ownerDate: '2026-09-28', template: null, templateEntryId: null, manuallyOverridden: false, source: { kind: 'manual' } }
  ] } };
}
export function envelope(data = blank(), epoch = 'independent-epoch', revision = 10): EnvelopeV4 {
  return { schemaVersion: 4, epoch, revision, mode: 'current', dataFormat: 'action-v2', data, lifecycleReceipt: null };
}
export function old() {
  return { config: { preferences: { theme: 'paper', density: 'comfortable', startHour: 8, endHour: 23, defaultMinutes: 15 }, categories: [],
    cards: [{ id: 'd', title: '旧定义', kind: 'temporary', minutes: 30, categoryId: null, parentId: null, steps: '原标准', enabled: true }], schedules: [] }, legacyArchives: [],
    planner: { version: 1, legacyImported: false, tasks: [
      { id: 't', title: '旧未完成', date: '2026-09-27', status: 'planned', criteria: '原标准', minimum: false, projects: [], goals: [], source: 'manual', occurrence: '', makeupOf: '' },
      { id: 'done', title: '旧已完成', date: '2026-09-27', status: 'done', criteria: '', minimum: false, projects: [], goals: [], source: 'manual', occurrence: '', makeupOf: '' }
    ], rules: [], occurrences: [], templates: [], days: [{ date: '2026-09-27', template: '', name: '原日', minimum: true, top3: ['t', 'done'], overrides: [],
      blocks: [{ id: 'b', title: '旧未完成', start: 540, end: 570, kind: 'flexible', task: 't', cancelled: false }] }], captures: [], history: [], refs: [], goals: [] } };
}
