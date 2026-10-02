import type { DataV2, ProductionDayView, Range, Segment } from './action-contract.ts';
import type { WorkspaceSnapshot } from './action-commands.ts';
import { ActionDomainError, occupancy, type Occupancy } from './action-domain.ts';
import { compareInstants, dateAt, dayRange, displayInstant, elapsedMinutes, freeRanges, intersectRanges, nextDate, plannedRange, splitRangeForDay, weekday } from './action-time.ts';
import { emptyActionData, exportWorkspace } from './workspace-format.ts';
import { legacyProjection } from './workspace-migration.ts';
import type { Data } from './domain.ts';
import type { Planner } from './planner.ts';

/** Disposable read model for retained P1A components. Never accepted by a save method. */
export function compatibilityView(snapshot: WorkspaceSnapshot): Data {
  const emptyPlanner: Planner = { version: 1, tasks: [], rules: [], occurrences: [], templates: [], days: [], captures: [], history: [], refs: [], goals: [], legacyImported: false };
  const blank: Data = { config: { preferences: { ...emptyActionData().settings.preferences }, categories: [], cards: [], schedules: [] }, legacyArchives: [], projects: [], inbox: [], routines: [], occurrences: [], days: [], events: [], planner: emptyPlanner };
  if (!snapshot.data) {
    const pack = exportWorkspace(snapshot.raw);
    const source = pack.data as unknown as Partial<Data>;
    return structuredClone({ ...blank, ...source, planner: source.planner ?? emptyPlanner });
  }
  const data = snapshot.data, p = data.planner;
  blank.config.preferences = structuredClone(data.settings.preferences); blank.config.categories = structuredClone(data.settings.categories) as Data['config']['categories'];
  blank.planner.tasks = p.instances.map(i => ({ id: i.id, title: i.currentContent.title, date: i.targetDate ?? '', status: p.facts.some(f => f.instanceId === i.id) ? 'done' : i.state === 'withdrawn' ? 'cancelled' : 'planned', criteria: i.currentContent.criteria, minimum: i.currentContent.minimum, goals: [...i.currentContent.goalIds], projects: [...i.currentContent.projectIds], source: i.source.kind, occurrence: '', makeupOf: '' }));
  blank.planner.days = p.days.map(d => ({ date: d.date, template: '', name: d.name, blocks: [], top3: d.top3.flatMap(r => r.kind === 'instance' ? [r.id] : []), minimum: d.minimum, overrides: [] }));
  blank.planner.captures = p.captures.map(c => ({ id: c.id, text: c.text, at: c.createdAt, source: c.source, status: c.status, target: c.target?.kind === 'instance' ? c.target.id : '' }));
  blank.planner.refs = structuredClone(p.refs) as Planner['refs']; blank.planner.goals = structuredClone(p.goals) as Planner['goals'];
  return blank;
}

export function segmentsFor(range: Range, date: string, zone: string, sourceId: string | null, kind: Segment['kind'], title: string, locked: boolean): readonly Segment[] {
  return splitRangeForDay(range, date, zone).map((slice, i) => {
    const start = displayInstant(slice.range.startAt, zone), minute = start.minute - slice.half * 720;
    const endMinute = minute + elapsedMinutes(slice.range), absoluteEnd = endMinute + slice.half * 720;
    const endLabel = `${String(Math.floor(absoluteEnd / 60)).padStart(2, '0')}:${String(Math.round(absoluteEnd % 60)).padStart(2, '0')}`;
    return { id: `${kind}:${sourceId ?? 'free'}:${slice.range.startAt}:${i}`, sourceId, kind, title, sourceRange: range, clippedRange: slice.range, startDate: dateAt(range.startAt, range.zone), half: slice.half,
      startMinuteOfHalf: minute, endMinuteOfHalf: endMinute, label: `${start.time}—${endLabel}`, offsetLabel: slice.offset, locked, continuesBefore: slice.continuesBefore, continuesAfter: slice.continuesAfter };
  });
}
export function projectedTemplates(data: DataV2, date: string, zone: string): readonly Occupancy[] {
  if (data.planner.days.some(d => d.date === date)) return [];
  const matches = data.planner.templates.filter(t => t.weekdays.includes(weekday(date)));
  if (matches.length > 1) throw new ActionDomainError('AMBIGUOUS_DAY_TEMPLATE', '当天有多个未保存模板，请明确选择后准备日期');
  return (matches[0]?.entries ?? []).map(entry => ({ kind: 'legacy' as const, id: `template-projection:${date}:${matches[0].id}:${entry.id}`, title: `${entry.title}（未保存模板）`, range: plannedRange({ date, time: entry.start, zone }, entry.elapsedMinutes) }));
}
export function compatibilityFor(data: DataV2, range?: Range) {
  const legacy = legacyProjection(data).occupancy;
  if (!range) return legacy;
  const zone = data.settings.zone;
  // No implicit device zone: unresolved template occupancy remains explicit.
  if (!zone) return { ...legacy, unknown: legacy.unknown || data.planner.templates.some(t => t.weekdays.length > 0) };
  const templates: Occupancy[] = [];
  const end = dateAt(range.endAt, zone);
  for (let date = nextDate(dateAt(range.startAt, zone), -1); date <= end; date = nextDate(date)) templates.push(...projectedTemplates(data, date, zone).filter(t => intersectRanges(range, t.range)));
  return { unknown: legacy.unknown, items: [...legacy.items, ...templates] };
}
export function projectDay(snapshot: WorkspaceSnapshot, input: { date: string; zone: string }, now: string): ProductionDayView {
  const range = dayRange(input.date, input.zone);
  let data = snapshot.data;
  if (!data) {
    const pack = exportWorkspace(snapshot.raw), blank = emptyActionData();
    data = { ...blank, legacySources: [{ id: snapshot.token.epoch, format: pack.version === 2 ? 'envelope-v1' : Object.hasOwn(pack.data as object, 'planner') ? 'cardgrid-v1-p1a' : 'cardgrid-v1-pre-planner', fingerprint: snapshot.rawKey, importedAt: now, raw: pack.data as DataV2['legacySources'][number]['raw'] }] };
  }
  const p = data.planner, legacy = legacyProjection(data), compatibility = compatibilityFor(data, range);
  const templateItems = compatibility.items.filter(x => x.id.startsWith('template-projection:'));
  const all = compatibility.unknown ? [] : occupancy(data, compatibility);
  const free = compatibility.unknown ? [] : freeRanges(range, all.map(v => v.range));
  const facts = p.facts.filter(f => intersectRanges(range, f.actualRange) || (f.plannedSnapshot && intersectRanges(range, f.plannedSnapshot.range)));
  const plans = p.plans.filter(plan => plan.status === 'active' && intersectRanges(range, plan.range));
  const fixed = p.fixed.filter(f => !f.cancelled && intersectRanges(range, f.range));
  const segments = [
    ...plans.flatMap(plan => segmentsFor(plan.range, input.date, input.zone, plan.id, 'plan', plan.contentSnapshot.title, false)),
    ...fixed.flatMap(f => segmentsFor(f.range, input.date, input.zone, f.id, 'fixed', f.title, true)),
    ...templateItems.flatMap(f => segmentsFor(f.range, input.date, input.zone, f.id, 'fixed', f.title, true)),
    ...facts.flatMap(f => [...segmentsFor(f.actualRange, input.date, input.zone, f.id, 'fact', f.contentSnapshot.title, true), ...(f.plannedSnapshot ? segmentsFor(f.plannedSnapshot.range, input.date, input.zone, f.id, 'plan-reference', `${f.contentSnapshot.title} · 原计划对照`, true) : [])]),
    ...(compareInstants(now, range.endAt) >= 0 ? free.flatMap(r => segmentsFor(r, input.date, input.zone, null, 'empty', '空时间（自动重算）', true)) : [])
  ];
  return { token: snapshot.token, mode: snapshot.mode === 'legacy-readonly' ? 'legacy-readonly' : 'current', occupancyKnown: !compatibility.unknown, date: input.date, zone: input.zone, now, dayRange: range,
    hand: p.handOrder.map(id => { const instance = p.instances.find(i => i.id === id)!; return { instanceId: id, version: instance.version, title: instance.currentContent.title, criteria: instance.currentContent.criteria, presetMinutes: instance.currentContent.presetMinutes, color: instance.currentContent.color, targetDate: instance.targetDate }; }),
    segments, facts: facts.map(f => ({ factId: f.id, instanceId: f.instanceId, title: f.contentSnapshot.title, criteria: f.contentSnapshot.criteria, actualRange: f.actualRange, plannedRange: f.plannedSnapshot?.range ?? null, confirmedAt: f.confirmedAt, annotations: p.annotations.filter(a => a.factId === f.id) })),
    plans: plans.map(plan => ({ planId: plan.id, version: plan.version, instanceId: plan.instanceId, instanceVersion: p.instances.find(i => i.id === plan.instanceId)!.version, range: plan.range })),
    fixed: fixed.map(f => ({ commitmentId: f.id, version: f.version, range: f.range })), freeRanges: free,
    legacyItems: legacy.items.filter(i => !i.range || intersectRanges(range, i.range)),
    policies: { status: 'user-decided', actualPrecision: 'minute', allowFutureActualEnd: true, confirmedOccupancy: 'actual-only', dayEnd: 'automatic-recompute', placementOverlap: 'explicit-acknowledgement' } };
}
