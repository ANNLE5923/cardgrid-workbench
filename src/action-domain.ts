import type { Content, DataV2, Day, EntityRef, ErrorCode, Fixed, Instance, Json, LegacyRef, Range, RecordedRange, Rule, Settings, Template, VersionRef } from './action-contract.ts';
import { assertDate, assertInstant, assertPlannedRange, assertPresetMinutes, assertRecordedRange, dateAt, elapsedMinutes, intersectRanges } from './action-time.ts';

export class ActionDomainError extends Error {
  readonly code: ErrorCode;
  readonly field?: string;
  constructor(code: ErrorCode, message: string, field?: string) {
    super(message); this.name = 'ActionDomainError'; this.code = code; this.field = field;
  }
}
function requireThat(condition: unknown, message: string, code: ErrorCode = 'INVALID_INPUT', field?: string): asserts condition {
  if (!condition) throw new ActionDomainError(code, message, field);
}
/** Object key order is irrelevant; array order and field presence remain significant. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameValue(v, b[i]));
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}
function unique(values: readonly string[], field: string): void {
  requireThat(values.every(id => typeof id === 'string' && id.trim()), '标识不能为空', 'INVALID_INPUT', field);
  requireThat(new Set(values).size === values.length, '标识重复', 'INVALID_INPUT', field);
}
export function assertContent(content: Content): void {
  requireThat(typeof content.title === 'string' && content.title.trim(), '标题不能为空');
  requireThat(typeof content.criteria === 'string' && typeof content.minimum === 'boolean', '内容字段无效');
  requireThat(/^#[\da-f]{6}$/i.test(content.color), '颜色须为六位十六进制');
  assertPresetMinutes(content.presetMinutes);
  unique(content.projectIds, 'projectIds'); unique(content.goalIds, 'goalIds');
  for (const [ids, labels] of [[content.projectIds, content.projectLabels], [content.goalIds, content.goalLabels]] as const) {
    unique(labels.map(label => label.id), 'labels');
    requireThat(ids.length === labels.length && ids.every(id => labels.some(label => label.id === id && typeof label.label === 'string')), '关联标签快照不完整');
  }
  requireThat(content.categoryId === null ? content.categoryLabel === null : typeof content.categoryLabel === 'string', '分类标签快照不完整');
}
function prefixUnchanged(before: readonly unknown[], after: readonly unknown[], message: string): void {
  requireThat(after.length >= before.length && before.every((item, i) => sameValue(item, after[i])), message, 'FACT_LOCKED');
}
/** Semantic checks for already-shaped action data; not a replacement for the 2A.4 import validator. */
export function assertActionState(data: DataV2): void {
  const p = data.planner;
  for (const name of ['definitions', 'instances', 'plans', 'facts', 'annotations', 'fixed', 'templates', 'rules', 'occurrences', 'captures', 'refs', 'goals', 'history'] as const)
    unique(p[name].map(item => item.id), name);
  unique(p.days.map(day => day.date), 'days');
  for (const item of [...p.definitions, ...p.instances, ...p.plans, ...p.fixed, ...p.templates, ...p.rules, ...p.captures, ...p.days])
    requireThat(Number.isSafeInteger(item.version) && item.version > 0, '对象版本无效');
  for (const definition of p.definitions) {
    assertContent(definition.content);
    const seen = new Set<string>([definition.id]);
    let parent = definition.parentDefinitionId;
    while (parent !== null) {
      const found = p.definitions.find(item => item.id === parent);
      requireThat(found && !seen.has(parent), '定义来源缺失或形成循环');
      seen.add(parent); parent = found.parentDefinitionId;
    }
  }
  for (const instance of p.instances) {
    assertContent(instance.creationSnapshot); assertContent(instance.currentContent); assertInstant(instance.createdAt);
    if (instance.targetDate !== null) assertDate(instance.targetDate);
    requireThat(instance.state === 'open' || instance.state === 'withdrawn', '实例状态无效');
    if (instance.definition) requireThat(p.definitions.some(d => d.id === instance.definition!.id && d.version >= instance.definition!.version), '定义引用无效');
    if (instance.occurrenceId) requireThat(p.occurrences.some(o => o.id === instance.occurrenceId && o.instanceId === instance.id), '例行实例关联无效');
    const makeup = instance.makeupOf;
    if (makeup?.kind === 'occurrence') requireThat(p.occurrences.some(o => o.id === makeup.id), '补做来源不存在');
  }
  const active = p.plans.filter(plan => plan.status === 'active');
  unique(active.map(plan => plan.instanceId), 'active plans');
  unique(p.facts.map(fact => fact.instanceId), 'facts per instance');
  for (const plan of p.plans) {
    requireThat(p.instances.some(instance => instance.id === plan.instanceId), '计划实例不存在');
    requireThat(['active', 'retracted', 'confirmed'].includes(plan.status), '计划状态无效');
    assertContent(plan.contentSnapshot); assertRecordedRange(plan.range); assertInstant(plan.createdAt); assertInstant(plan.changedAt);
    if (plan.status === 'active') {
      requireThat(p.instances.some(i => i.id === plan.instanceId && i.state === 'open') && !p.facts.some(f => f.instanceId === plan.instanceId), '活动计划不能属于已退出或已确认实例');
      assertPlannedRange(plan.range, p.instances.find(i => i.id === plan.instanceId)!.currentContent.presetMinutes);
    } else assertPlannedRange(plan.range, elapsedMinutes(plan.range));
    if (plan.status === 'confirmed') requireThat(p.facts.some(f => f.instanceId === plan.instanceId && f.plannedSnapshot?.planId === plan.id), '封存计划缺少对应事实');
  }
  for (const fact of p.facts) {
    requireThat(p.instances.some(instance => instance.id === fact.instanceId && instance.state === 'open'), '事实实例不存在或已退出');
    assertContent(fact.contentSnapshot); assertRecordedRange(fact.actualRange); assertInstant(fact.confirmedAt);
    if (fact.plannedSnapshot) {
      const snapshot = fact.plannedSnapshot;
      const plan = p.plans.find(item => item.id === snapshot.planId);
      requireThat(plan && plan.instanceId === fact.instanceId && plan.status === 'confirmed' && plan.version === snapshot.planVersion + 1 &&
        sameValue(plan.range, snapshot.range) && sameValue(plan.contentSnapshot, snapshot.content), '事实计划对照无效');
    }
  }
  for (const annotation of p.annotations) {
    requireThat(p.facts.some(fact => fact.id === annotation.factId), '批注事实不存在');
    requireThat(typeof annotation.text === 'string' && annotation.text.trim(), '批注不能为空'); assertInstant(annotation.createdAt);
  }
  for (const fixed of p.fixed) { assertPlannedRange(fixed.range, elapsedMinutes(fixed.range)); assertDate(fixed.ownerDate); }
  unique(p.occurrences.map(o => `${o.ruleId}\u0000${o.date}`), 'rule/date');
  unique(p.instances.filter(i => i.makeupOf !== null).map(i => i.makeupOf!.kind === 'legacy'
    ? JSON.stringify([i.makeupOf!.sourceId, i.makeupOf!.path]) : i.makeupOf!.id), 'makeupOf');
  for (const occurrence of p.occurrences) {
    assertDate(occurrence.date);
    requireThat(p.rules.some(rule => rule.id === occurrence.ruleId) && p.instances.some(i => i.id === occurrence.instanceId && i.occurrenceId === occurrence.id), '例行规则或原实例不存在');
  }
  const expectedHand = p.instances.filter(i => i.state === 'open' && !active.some(plan => plan.instanceId === i.id) && !p.facts.some(f => f.instanceId === i.id)).map(i => i.id);
  unique(p.handOrder, 'handOrder');
  requireThat(p.handOrder.length === expectedHand.length && p.handOrder.every(id => expectedHand.includes(id)), '手牌必须恰好覆盖所有可持有实例');
  requireThat(p.refs.filter(ref => ref.status === 'active').length <= 3, '进行中的项目最多三个');
  for (const day of p.days) {
    assertDate(day.date);
    const refs = day.top3.map(ref => ref.kind === 'instance' ? ref.id : JSON.stringify([ref.sourceId, ref.path]));
    unique(refs, 'top3'); requireThat(refs.length <= 3, '重点任务最多三个');
    for (const ref of day.top3) if (ref.kind === 'instance') requireThat(p.instances.some(i => i.id === ref.id), '重点任务不存在');
  }
}
/** Ordinary business transitions only. Explicit restore/clear have separate lifecycle rules. */
export function assertActionTransition(before: DataV2, after: DataV2): void {
  prefixUnchanged(before.planner.facts, after.planner.facts, '原事实永久锁定');
  prefixUnchanged(before.planner.annotations, after.planner.annotations, '已有批注只能保留并追加');
  prefixUnchanged(before.planner.history, after.planner.history, '已有历史不可改写');
  for (const instance of before.planner.instances) {
    const next = after.planner.instances.find(item => item.id === instance.id);
    requireThat(next, '不能删除既有实例');
    for (const field of ['creationSnapshot', 'source', 'createdAt', 'definition', 'occurrenceId', 'makeupOf'] as const)
      requireThat(sameValue(instance[field], next[field]), '实例创建来源快照不可改变', 'FACT_LOCKED', field);
    if (before.planner.facts.some(f => f.instanceId === instance.id)) requireThat(sameValue(instance, next), '已确认实例不可修改', 'FACT_LOCKED');
  }
  for (const plan of before.planner.plans) {
    const next = after.planner.plans.find(item => item.id === plan.id);
    requireThat(next, '撤回须保留旧计划');
    if (plan.status !== 'active') requireThat(sameValue(plan, next), '封存计划不可修改', 'FACT_LOCKED');
    requireThat(next.instanceId === plan.instanceId && next.createdAt === plan.createdAt && sameValue(next.contentSnapshot, plan.contentSnapshot), '计划身份和原内容快照不可改变');
  }
  assertActionState(after);
}

export type Occupancy = Readonly<{ kind: 'plan' | 'fixed' | 'fact' | 'legacy'; id: string; title: string; range: Range }>;
export type Overlap = Occupancy & Readonly<{ overlap: Range }>;
export type CompatibilityOccupancy = Readonly<{ items: readonly Occupancy[]; unknown: boolean }>;
export function occupancy(data: DataV2, compatibility?: CompatibilityOccupancy): readonly Occupancy[] {
  requireThat(!compatibility?.unknown && (data.legacySources.length === 0 || compatibility !== undefined), '旧占用尚未完整解释，不能作为空闲', 'MIGRATION_BLOCKED');
  return [
    ...data.planner.fixed.filter(f => !f.cancelled).map(f => ({ kind: 'fixed' as const, id: f.id, title: f.title, range: f.range })),
    ...data.planner.plans.filter(p => p.status === 'active').map(p => ({ kind: 'plan' as const, id: p.id, title: p.contentSnapshot.title, range: p.range })),
    ...data.planner.facts.map(f => ({ kind: 'fact' as const, id: f.id, title: f.contentSnapshot.title, range: f.actualRange })),
    ...(compatibility?.items ?? [])
  ];
}
export function overlaps(data: DataV2, range: Range, exclude?: Pick<Occupancy, 'kind' | 'id'>, compatibility?: CompatibilityOccupancy): readonly Overlap[] {
  return occupancy(data, compatibility).flatMap(item => {
    if (exclude?.kind === item.kind && exclude.id === item.id) return [];
    const overlap = intersectRanges(range, item.range);
    return overlap ? [{ ...item, overlap }] : [];
  }).sort((a, b) => `${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : `${a.kind}:${a.id}` > `${b.kind}:${b.id}` ? 1 : 0);
}
type OverlapInput = Readonly<{ acknowledgedOverlaps?: readonly Overlap[] }>;
type FixedUnlock = Readonly<{ id: string; version: number }>;
/** Internal resolved operations. The 2A.3 command layer must authenticate previews, unlocks and tokens. */
export type ActionOperation =
  | Readonly<{ type: 'CreateLegacyMakeup'; occurrence: LegacyRef; content: Content; instanceId: string; targetDate: string }>
  | Readonly<{ type: 'UseExistingLegacy'; reference: LegacyRef }>
  | Readonly<{ type: 'SaveSettings'; settings: Settings }>
  | Readonly<{ type: 'CreateCapture'; captureId: string; text: string; source: string }>
  | Readonly<{ type: 'SetCaptureStatus'; capture: VersionRef; status: 'archived' | 'discarded' }>
  | Readonly<{ type: 'UpdateDay'; date: string; version: number; minimum: boolean; top3: Day['top3'] }>
  | Readonly<{ type: 'SaveTemplate'; template: Template; expectedVersion: number | null }>
  | Readonly<{ type: 'SaveRule'; rule: Rule; expectedVersion: number | null }>
  | Readonly<{ type: 'SaveProject'; project: DataV2['planner']['refs'][number] }>
  | Readonly<{ type: 'SaveGoal'; goal: DataV2['planner']['goals'][number] }>
  | Readonly<{ type: 'ApplyCalendar'; day: Day; fixed: readonly Fixed[]; instances: readonly Instance[]; occurrences: DataV2['planner']['occurrences'] }>
  | Readonly<{ type: 'ImportDefinitions'; settings: Settings; definitions: DataV2['planner']['definitions']; templates: readonly Template[]; rules: readonly Rule[] }>
  | Readonly<{ type: 'SaveDefinition'; id: string; expectedVersion: number | null; content: Content; enabled: boolean; parentDefinitionId: string | null }>
  | Readonly<{ type: 'AcceptDefinition'; definition: VersionRef; instanceId: string; targetDate: string | null }>
  | Readonly<{ type: 'CreateManualInstance'; instanceId: string; content: Content; targetDate: string | null }>
  | Readonly<{ type: 'ResolveCapture'; capture: VersionRef; instanceId: string; content: Content; targetDate: string | null }>
  | Readonly<{ type: 'UpdateInstance'; instance: VersionRef; content: Content; targetDate: string | null; replacementRange?: RecordedRange }> & OverlapInput
  | Readonly<{ type: 'ReorderHand'; instanceIds: readonly string[] }>
  | Readonly<{ type: 'WithdrawInstance' | 'ReturnToHand'; instance: VersionRef }>
  | Readonly<{ type: 'PlaceInstance'; instance: VersionRef; planId: string; range: RecordedRange }> & OverlapInput
  | Readonly<{ type: 'MovePlan'; plan: VersionRef; range: RecordedRange }> & OverlapInput
  | Readonly<{ type: 'RetractPlan'; plan: VersionRef }>
  | Readonly<{ type: 'ConfirmActual'; instance: VersionRef; expectedPlan: VersionRef | null; factId: string; range: RecordedRange }> & OverlapInput
  | Readonly<{ type: 'AppendAnnotation'; factId: string; annotationId: string; text: string }>
  | Readonly<{ type: 'MoveFixed'; fixed: VersionRef; unlock: FixedUnlock | null; range: RecordedRange }> & OverlapInput
  | Readonly<{ type: 'CancelFixed'; fixed: VersionRef; unlock: FixedUnlock | null }>
  | Readonly<{ type: 'CreateMakeup'; occurrenceId: string; instanceId: string; targetDate: string }>;
export type TransitionContext = Readonly<{ commandId: string; historyId: string; at: string; date: string; compatibility?: CompatibilityOccupancy }>;
type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
function json(value: unknown): Json { return structuredClone(value) as Json; }

export function applyAction(data: DataV2, operation: ActionOperation, context: TransitionContext): Readonly<{ data: DataV2; resultRefs: readonly EntityRef[]; changed: boolean }> {
  assertActionState(data); assertDate(context.date); assertInstant(context.at);
  unique([context.commandId], 'commandId'); unique([context.historyId], 'historyId');
  const next = structuredClone(data) as Mutable<DataV2>;
  const p = next.planner;
  let ref: EntityRef = { kind: 'day', id: context.date };
  let before: Json = null, after: Json = null;
  const versioned = <T extends { id: string; version: number }>(items: T[], expected: VersionRef): T => {
    const item = items.find(value => value.id === expected.id);
    requireThat(item, '对象不存在');
    requireThat(item.version === expected.version, '对象版本已改变', 'REVISION_CONFLICT');
    return item;
  };
  const editable = (expected: VersionRef): Mutable<Instance> => {
    const instance = versioned(p.instances, expected);
    requireThat(!p.facts.some(fact => fact.instanceId === instance.id), '事实已确认并锁定', 'FACT_LOCKED');
    if (instance.occurrenceId) {
      const occurrence = p.occurrences.find(o => o.id === instance.occurrenceId)!;
      const rule = p.rules.find(r => r.id === occurrence.ruleId)!;
      requireThat(occurrence.date >= dateAt(context.at, rule.zone) && occurrence.disposition === 'generated', '过去例行或已结束例行须另建补做实例', 'PAST_OCCURRENCE_LOCKED');
    }
    return instance;
  };
  const makeInstance = (id: string, content: Content, targetDate: string | null, source: Instance['source'], definition: VersionRef | null = null, makeupOf: Instance['makeupOf'] = null) => {
    requireThat(!p.instances.some(i => i.id === id), '实例标识已存在'); assertContent(content);
    if (targetDate !== null) assertDate(targetDate);
    const instance: Instance = { id, version: 1, definition, creationSnapshot: structuredClone(content), currentContent: structuredClone(content), source,
      createdAt: context.at, targetDate, state: 'open', occurrenceId: null, makeupOf };
    p.instances.push(structuredClone(instance) as Mutable<Instance>); p.handOrder.push(id);
    ref = { kind: 'instance', id }; after = json(instance);
  };
  const acknowledge = (range: Range, input: OverlapInput, exclude?: Pick<Occupancy, 'kind' | 'id'>) => {
    const current = overlaps(data, range, exclude, context.compatibility);
    if (input.acknowledgedOverlaps !== undefined) requireThat(sameValue(input.acknowledgedOverlaps, current), '重叠集合已改变，请重新预览', 'PREVIEW_STALE');
    else requireThat(current.length === 0, '请明确确认全部重叠区间', 'OVERLAP_CONFIRMATION_REQUIRED');
  };
  const activePlan = (instanceId: string) => p.plans.find(plan => plan.instanceId === instanceId && plan.status === 'active');
  switch (operation.type) {
    case 'UseExistingLegacy': return { data, resultRefs: [operation.reference], changed: false };
    case 'CreateLegacyMakeup': {
      const existing = p.instances.find(i => sameValue(i.makeupOf, operation.occurrence));
      if (existing) return { data, resultRefs: [{ kind: 'instance', id: existing.id }], changed: false };
      makeInstance(operation.instanceId, operation.content, operation.targetDate, operation.occurrence, null, operation.occurrence); break;
    }
    case 'SaveSettings': before = json(next.settings); next.settings = structuredClone(operation.settings) as Mutable<Settings>; after = json(next.settings); ref = { kind: 'settings', id: 'workspace' }; break;
    case 'CreateCapture': {
      requireThat(operation.text.trim() && !p.captures.some(c => c.id === operation.captureId), '捕获内容或标识无效');
      const capture = { id: operation.captureId, version: 1, text: operation.text, createdAt: context.at, source: operation.source, status: 'unprocessed' as const, target: null };
      p.captures.push(capture); ref = { kind: 'capture', id: capture.id }; after = json(capture); break;
    }
    case 'SetCaptureStatus': {
      const capture = versioned(p.captures, operation.capture);
      requireThat(capture.status === 'unprocessed' || (capture.status === 'discarded' && operation.status === 'archived'), '捕获已转换或归档', 'CAPTURE_ALREADY_RESOLVED');
      before = json(capture); capture.status = operation.status; capture.version++; after = json(capture); ref = { kind: 'capture', id: capture.id }; break;
    }
    case 'UpdateDay': {
      const day = p.days.find(d => d.date === operation.date);
      requireThat(day && day.version === operation.version, '请先准备日期或重新载入', 'REVISION_CONFLICT');
      before = json(day); day.minimum = operation.minimum; day.top3 = structuredClone(operation.top3) as Mutable<Day['top3']>; day.version++; after = json(day); ref = { kind: 'day', id: day.date }; break;
    }
    case 'SaveTemplate': case 'SaveRule': {
      if (operation.type === 'SaveTemplate') {
        const existing = p.templates.find(t => t.id === operation.template.id);
        requireThat(existing ? existing.version === operation.expectedVersion : operation.expectedVersion === null, '模板已改变', 'REVISION_CONFLICT');
        before = json(existing ?? null); const value = { ...structuredClone(operation.template), version: existing ? existing.version + 1 : 1 } as Mutable<Template>;
        if (existing) p.templates[p.templates.indexOf(existing)] = value; else p.templates.push(value); ref = { kind: 'template', id: value.id }; after = json(value);
      } else {
        const existing = p.rules.find(r => r.id === operation.rule.id);
        requireThat(existing ? existing.version === operation.expectedVersion : operation.expectedVersion === null, '例行规则已改变', 'REVISION_CONFLICT');
        before = json(existing ?? null); const value = { ...structuredClone(operation.rule), version: existing ? existing.version + 1 : 1 } as Mutable<Rule>;
        if (existing) p.rules[p.rules.indexOf(existing)] = value; else p.rules.push(value); ref = { kind: 'rule', id: value.id }; after = json(value);
      } break;
    }
    case 'SaveProject': case 'SaveGoal': {
      if (operation.type === 'SaveProject') { const old = p.refs.find(r => r.id === operation.project.id); before = json(old ?? null); if (old) Object.assign(old, operation.project); else p.refs.push(structuredClone(operation.project)); ref = { kind: 'project', id: operation.project.id }; after = json(operation.project); }
      else { const old = p.goals.find(g => g.id === operation.goal.id); before = json(old ?? null); if (old) Object.assign(old, operation.goal); else p.goals.push(structuredClone(operation.goal)); ref = { kind: 'goal', id: operation.goal.id }; after = json(operation.goal); } break;
    }
    case 'ApplyCalendar': {
      const existing = p.days.find(d => d.date === operation.day.date);
      before = json(existing ?? null);
      if (existing) p.days[p.days.indexOf(existing)] = structuredClone(operation.day) as Mutable<Day>; else p.days.push(structuredClone(operation.day) as Mutable<Day>);
      for (const value of operation.fixed) {
        const old = p.fixed.find(f => f.id === value.id);
        requireThat(!old?.manuallyOverridden || sameValue(old, value), '模板不能覆盖手动例外', 'FIXED_LOCKED');
        if (old) p.fixed[p.fixed.indexOf(old)] = structuredClone(value) as Mutable<Fixed>; else p.fixed.push(structuredClone(value) as Mutable<Fixed>);
      }
      p.instances.push(...structuredClone(operation.instances) as Mutable<Instance>[]); p.handOrder.push(...operation.instances.map(i => i.id));
      p.occurrences.push(...structuredClone(operation.occurrences) as Mutable<DataV2['planner']['occurrences']>);
      ref = { kind: 'day', id: operation.day.date }; after = json(operation.day);
      if (sameValue(data, next)) return { data, resultRefs: [ref], changed: false }; break;
    }
    case 'ImportDefinitions': {
      before = json({ settings: next.settings, definitions: p.definitions, templates: p.templates, rules: p.rules });
      next.settings = structuredClone(operation.settings) as Mutable<Settings>; p.definitions = structuredClone(operation.definitions) as Mutable<DataV2['planner']['definitions']>;
      p.templates = structuredClone(operation.templates) as Mutable<Template>[]; p.rules = structuredClone(operation.rules) as Mutable<Rule>[];
      after = json({ settings: next.settings, definitions: p.definitions, templates: p.templates, rules: p.rules }); ref = { kind: 'settings', id: 'workspace' }; break;
    }
    case 'SaveDefinition': {
      assertContent(operation.content);
      const existing = p.definitions.find(d => d.id === operation.id);
      requireThat(existing ? existing.version === operation.expectedVersion : operation.expectedVersion === null, '定义版本已改变', 'DEFINITION_STALE');
      before = json(existing ?? null);
      const definition = { id: operation.id, version: existing ? existing.version + 1 : 1, content: structuredClone(operation.content) as Mutable<Content>,
        enabled: operation.enabled, parentDefinitionId: operation.parentDefinitionId, source: existing?.source ?? { kind: 'manual' as const } };
      if (existing) p.definitions[p.definitions.indexOf(existing)] = definition; else p.definitions.push(definition);
      ref = { kind: 'definition', id: definition.id }; after = json(definition); break;
    }
    case 'AcceptDefinition': {
      const definition = p.definitions.find(d => d.id === operation.definition.id);
      requireThat(definition && definition.version === operation.definition.version, '定义版本已改变', 'DEFINITION_STALE');
      requireThat(definition.enabled, '定义已停用', 'DEFINITION_DISABLED');
      makeInstance(operation.instanceId, definition.content, operation.targetDate, { kind: 'definition', id: definition.id }, operation.definition); break;
    }
    case 'CreateManualInstance': makeInstance(operation.instanceId, operation.content, operation.targetDate, { kind: 'manual' }); break;
    case 'ResolveCapture': {
      const capture = versioned(p.captures, operation.capture);
      requireThat(capture.status === 'unprocessed' && capture.target === null, '捕获已处理', 'CAPTURE_ALREADY_RESOLVED');
      before = json(capture);
      makeInstance(operation.instanceId, operation.content, operation.targetDate, { kind: 'capture', id: capture.id });
      capture.status = 'resolved'; capture.target = { kind: 'instance', id: operation.instanceId }; capture.version++;
      after = json({ capture, instance: after }); break;
    }
    case 'UpdateInstance': {
      const instance = editable(operation.instance); assertContent(operation.content);
      requireThat(instance.state === 'open', '只有持有中的实例可编辑');
      if (operation.targetDate !== null) assertDate(operation.targetDate);
      const plan = activePlan(instance.id); before = json({ instance, plan: plan ?? null });
      if (plan && (instance.currentContent.presetMinutes !== operation.content.presetMinutes || operation.replacementRange)) {
        requireThat(operation.replacementRange, '活动计划改时长须提供完整排期预览');
        assertPlannedRange(operation.replacementRange, operation.content.presetMinutes);
        acknowledge(operation.replacementRange, operation, { kind: 'plan', id: plan.id });
        plan.range = structuredClone(operation.replacementRange); plan.version++; plan.changedAt = context.at;
      } else requireThat(!operation.replacementRange, '无活动计划时不能夹带排期');
      instance.currentContent = structuredClone(operation.content) as Mutable<Content>; instance.targetDate = operation.targetDate; instance.version++;
      ref = { kind: 'instance', id: instance.id }; after = json({ instance, plan: plan ?? null }); break;
    }
    case 'ReorderHand': {
      unique(operation.instanceIds, 'instanceIds');
      requireThat(operation.instanceIds.length === p.handOrder.length && operation.instanceIds.every(id => p.handOrder.includes(id)), '排序须包含全部当前手牌且不重复');
      if (sameValue(operation.instanceIds, p.handOrder)) return { data, resultRefs: [], changed: false };
      before = json(p.handOrder); p.handOrder = [...operation.instanceIds]; after = json(p.handOrder);
      ref = { kind: 'instance', id: p.handOrder[0] }; break;
    }
    case 'WithdrawInstance': case 'ReturnToHand': {
      const instance = editable(operation.instance);
      requireThat(!activePlan(instance.id), '请先撤回活动计划', 'ALREADY_PLANNED'); before = json(instance);
      requireThat(instance.state === (operation.type === 'WithdrawInstance' ? 'open' : 'withdrawn'), '实例状态已改变');
      instance.state = operation.type === 'WithdrawInstance' ? 'withdrawn' : 'open'; instance.version++;
      p.handOrder = operation.type === 'WithdrawInstance' ? p.handOrder.filter(id => id !== instance.id) : [...p.handOrder, instance.id];
      ref = { kind: 'instance', id: instance.id }; after = json(instance); break;
    }
    case 'PlaceInstance': {
      const instance = editable(operation.instance);
      requireThat(instance.state === 'open', '已退出实例不能安排');
      requireThat(!activePlan(instance.id), '实例已有活动计划', 'ALREADY_PLANNED');
      requireThat(!p.plans.some(plan => plan.id === operation.planId), '计划标识不可复用');
      assertPlannedRange(operation.range, instance.currentContent.presetMinutes); acknowledge(operation.range, operation);
      const plan = { id: operation.planId, version: 1, instanceId: instance.id, range: structuredClone(operation.range),
        contentSnapshot: structuredClone(instance.currentContent), status: 'active' as const, createdAt: context.at, changedAt: context.at };
      p.plans.push(plan); p.handOrder = p.handOrder.filter(id => id !== instance.id);
      ref = { kind: 'plan', id: plan.id }; after = json(plan); break;
    }
    case 'MovePlan': case 'RetractPlan': {
      const plan = versioned(p.plans, operation.plan);
      requireThat(plan.status === 'active', '计划已封存', 'FACT_LOCKED');
      const stored = p.instances.find(i => i.id === plan.instanceId)!;
      const instance = editable(stored); before = json(plan);
      if (operation.type === 'MovePlan') {
        assertPlannedRange(operation.range, instance.currentContent.presetMinutes);
        acknowledge(operation.range, operation, { kind: 'plan', id: plan.id }); plan.range = structuredClone(operation.range);
      } else { plan.status = 'retracted'; p.handOrder.push(instance.id); }
      plan.version++; plan.changedAt = context.at; ref = { kind: 'plan', id: plan.id }; after = json(plan); break;
    }
    case 'ConfirmActual': {
      requireThat(!p.facts.some(f => f.instanceId === operation.instance.id), '该实例已经确认', 'ALREADY_CONFIRMED');
      const instance = editable(operation.instance);
      requireThat(instance.state === 'open', '已退出实例不能确认');
      requireThat(!p.facts.some(f => f.id === operation.factId), '事实标识已存在');
      const plan = activePlan(instance.id);
      requireThat(plan ? operation.expectedPlan?.id === plan.id && operation.expectedPlan.version === plan.version : operation.expectedPlan === null, '关联计划已改变', 'PREVIEW_STALE');
      assertRecordedRange(operation.range); acknowledge(operation.range, operation, plan ? { kind: 'plan', id: plan.id } : undefined);
      const plannedSnapshot = plan ? { planId: plan.id, planVersion: plan.version, range: structuredClone(plan.range), content: structuredClone(plan.contentSnapshot) } : null;
      before = json(plan ?? null);
      const fact = { id: operation.factId, instanceId: instance.id, contentSnapshot: structuredClone(instance.currentContent), actualRange: structuredClone(operation.range),
        plannedSnapshot, confirmedAt: context.at, source: structuredClone(instance.source) };
      p.facts.push(fact);
      if (plan) { plan.status = 'confirmed'; plan.version++; plan.changedAt = context.at; }
      p.handOrder = p.handOrder.filter(id => id !== instance.id);
      ref = { kind: 'fact', id: fact.id }; after = json(fact); break;
    }
    case 'AppendAnnotation': {
      requireThat(p.facts.some(f => f.id === operation.factId), '事实不存在');
      requireThat(!p.annotations.some(a => a.id === operation.annotationId), '批注标识已存在');
      requireThat(typeof operation.text === 'string' && operation.text.trim(), '批注不能为空');
      const annotation = { id: operation.annotationId, factId: operation.factId, text: operation.text, createdAt: context.at };
      p.annotations.push(annotation); ref = { kind: 'annotation', id: annotation.id }; after = json(annotation); break;
    }
    case 'MoveFixed': case 'CancelFixed': {
      const fixed = versioned(p.fixed, operation.fixed);
      requireThat(operation.unlock?.id === fixed.id && operation.unlock.version === fixed.version, '请显式解锁当前固定安排', 'FIXED_LOCKED');
      requireThat(!fixed.cancelled, '固定安排已取消'); before = json(fixed);
      if (operation.type === 'MoveFixed') {
        assertPlannedRange(operation.range, elapsedMinutes(operation.range));
        acknowledge(operation.range, operation, { kind: 'fixed', id: fixed.id }); fixed.range = structuredClone(operation.range);
      } else fixed.cancelled = true;
      fixed.manuallyOverridden = true; fixed.version++;
      const day = p.days.find(d => d.date === fixed.ownerDate);
      if (day && fixed.templateEntryId !== null) {
        day.overrides = [...day.overrides.filter(o => o.entryId !== fixed.templateEntryId),
          { entryId: fixed.templateEntryId, fixedId: fixed.id, kind: operation.type === 'CancelFixed' ? 'cancelled' : 'edited', at: context.at }];
        day.version++;
      }
      ref = { kind: 'fixed', id: fixed.id }; after = json(fixed); break;
    }
    case 'CreateMakeup': {
      const occurrence = p.occurrences.find(o => o.id === operation.occurrenceId);
      requireThat(occurrence, '原例行不存在');
      const existing = p.instances.find(i => i.makeupOf?.kind === 'occurrence' && i.makeupOf.id === occurrence.id);
      if (existing) return { data, resultRefs: [{ kind: 'instance', id: existing.id }], changed: false };
      const original = p.instances.find(i => i.id === occurrence.instanceId)!;
      const rule = p.rules.find(r => r.id === occurrence.ruleId)!;
      requireThat(!p.facts.some(f => f.instanceId === original.id) && (occurrence.disposition !== 'generated' || occurrence.date < dateAt(context.at, rule.zone)), '该例行尚不需要补做');
      makeInstance(operation.instanceId, original.currentContent, operation.targetDate, { kind: 'makeup', id: occurrence.id }, original.definition, { kind: 'occurrence', id: occurrence.id }); break;
    }
  }
  p.history.push({ id: context.historyId, commandId: context.commandId, at: context.at, date: context.date, type: operation.type, entity: ref, before, after } as Mutable<DataV2>['planner']['history'][number]);
  assertActionTransition(data, next);
  return { data: next, resultRefs: [ref], changed: true };
}
