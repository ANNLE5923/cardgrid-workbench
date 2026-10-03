import type { Content, DataV2, EntityRef, Json, LegacyFormat, LegacyRef, MigrationIssue, MigrationPreview, Range, RecordedRange } from './contracts.ts';
import type { Data, Config } from './legacy/domain.ts';
import type { Planner, Block, Task } from './legacy/planner.ts';
import { ActionDomainError, sameValue, type ActionOperation, type CompatibilityOccupancy } from '../daily/model.ts';
import { actualRange, assertDate, assertZone, dateAt, elapsedMinutes, legacyInstant, nextDate } from '../daily/time.ts';
import { backupBytes, emptyActionData, fingerprint, MAX_BACKUP_BYTES, resolveLegacyPath, sourcePathPart, validateActionData, validateLegacyData, validateLegacyEnvelope, validateLegacyArchive } from './format.ts';

type Mutable<T> = T extends readonly (infer U)[] ? Mutable<U>[] : T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
export type MigrationChoices = Readonly<{ zone: string | null; readonlyPaths?: readonly string[]; offsets?: Readonly<Record<string, Readonly<{ start?: string; end?: string }>>> }>;
export type MigrationSource = Readonly<{ id?: string; format: LegacyFormat; raw: Json }>;
export type MigrationTarget = Readonly<{ data: DataV2; report: Omit<MigrationPreview, 'previewId' | 'token'> }>;
const keyed = (base: string, id: string) => `${base}/${sourcePathPart(id)}`;
const minuteText = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
function oldRange(date: string, block: Pick<Block, 'start' | 'end'>, zone: string, offsets?: { start?: string; end?: string }): RecordedRange {
  return actualRange({ date, time: minuteText(block.start), zone, ...(offsets?.start ? { offset: offsets.start } : {}) },
    { date: block.end === 1440 ? nextDate(date) : date, time: block.end === 1440 ? '00:00' : minuteText(block.end), zone, ...(offsets?.end ? { offset: offsets.end } : {}) });
}
function rawData(source: MigrationSource): Partial<Data> {
  return source.format === 'legacy-archive' ? {} : source.raw as unknown as Data;
}
function reportChoices(data: DataV2, sourceId: string): MigrationChoices | null {
  const entry = [...data.planner.history].reverse().find(h => h.type === 'MigrationCommitted' && h.entity.kind === 'legacy' && h.entity.sourceId === sourceId);
  return entry ? (entry.after as unknown as { choices: MigrationChoices }).choices : null;
}
export function legacyProjection(data: DataV2): Readonly<{ items: readonly { source: LegacyRef; title: string; range: Range | null; occupancy: 'known' | 'unknown' | 'none' }[]; occupancy: CompatibilityOccupancy }> {
  const items: { source: LegacyRef; title: string; range: Range | null; occupancy: 'known' | 'unknown' | 'none' }[] = [];
  for (const source of data.legacySources) {
    const old = rawData(source), choices = reportChoices(data, source.id);
    const add = (path: string, title: string, timed?: { date: string; block: Pick<Block, 'start' | 'end'> }) => {
      if (data.migrationBindings.some(b => b.sourceId === source.id && b.path === path && b.disposition === 'converted' && (!timed || b.target.kind === 'plan' || b.target.kind === 'fixed'))) return;
      let range: Range | null = null, status: 'known' | 'unknown' | 'none' = timed ? 'unknown' : 'none';
      if (timed && choices?.zone) try { range = oldRange(timed.date, timed.block, choices.zone, choices.offsets?.[path]); status = 'known'; } catch { /* explicit unknown, never free */ }
      items.push({ source: { kind: 'legacy', sourceId: source.id, path }, title, range, occupancy: status });
    };
    for (const task of old.planner?.tasks ?? []) add(keyed('/planner/tasks', task.id), task.title);
    for (const day of old.planner?.days ?? []) for (const block of day.blocks) if (!block.cancelled)
      add(keyed(keyed('/planner/days', day.date) + '/blocks', block.id), block.title, { date: day.date, block });
    // A saved old day takes precedence over current templates. Pre-planner days keep their own overrides.
    if (!old.planner) for (const day of old.days ?? []) {
      const template = old.config?.schedules.find(s => s.id === day.scheduleId);
      for (const [i, entry] of (template?.entries ?? []).entries()) {
        const override = day.overrides?.[entry.cardId], clock = (override?.start ?? entry.start).split(':').map(Number), start = clock[0] * 60 + clock[1];
        add(keyed('/days', day.date), old.config!.cards.find(c => c.id === entry.cardId)?.title ?? `旧时段 ${i + 1}`, { date: day.date, block: { start, end: start + (override?.minutes ?? entry.minutes) } });
      }
    }
    if (source.format === 'legacy-archive' || (old.legacyArchives?.length ?? 0) > 0) add('/', '旧版档案（原文保留）');
  }
  return { items, occupancy: { unknown: items.some(i => i.occupancy === 'unknown'), items: items.flatMap((i, index) => i.range ? [{ kind: 'legacy' as const, id: `${i.source.sourceId}:${i.source.path}:${index}`, title: i.title, range: i.range }] : []) } };
}

/** Pure target preparation except SHA-256; all parsing/choices run before any IDB transaction. */
export async function prepareMigration(base: DataV2, source: MigrationSource, choices: MigrationChoices, at: string, commandId: string): Promise<MigrationTarget> {
  if (source.format === 'envelope-v1') validateLegacyEnvelope(source.raw);
  else if (source.format === 'legacy-archive') validateLegacyArchive(source.raw, '$');
  else validateLegacyData(source.raw);
  if (choices.zone !== null) assertZone(choices.zone);
  const sourceFingerprint = await fingerprint(source.raw), sourceId = source.id ?? `legacy-${sourceFingerprint}`;
  const found = base.legacySources.find(s => s.id === sourceId);
  const issues: MigrationIssue[] = [];
  const ref = (path: string): LegacyRef => ({ kind: 'legacy', sourceId, path });
  const issue = (path: string, code: string, message: string, blocking: boolean, options: readonly string[] = []) => issues.push({ source: ref(path), code, message, blocking, choices: options });
  if (found) {
    if (found.fingerprint !== sourceFingerprint) issue('/', 'SOURCE_CHANGED', '同一来源原文已改变，请审查来源差异并使用新的来源身份', true);
    const bindings = base.migrationBindings.filter(b => b.sourceId === sourceId);
    return { data: base, report: { sourceFingerprint, mappingVersion: 1, bindings, issues, targetSummary: { definitions: 0, instances: 0, plans: 0, facts: 0, readonlyItems: bindings.filter(b => b.disposition === 'readonly').length } } };
  }
  const next = structuredClone(base) as Mutable<DataV2>, p = next.planner, old = rawData(source);
  next.legacySources.push({ id: sourceId, format: source.format, fingerprint: sourceFingerprint, importedAt: at, raw: structuredClone(source.raw) as Mutable<Json> });
  const id = (path: string) => `${sourceId}:${path}`;
  const bind = (path: string, target: EntityRef = ref(path)) => {
    const value = { sourceId, path, sourceFingerprint, mappingVersion: 1 as const, target, disposition: target.kind === 'legacy' ? 'readonly' as const : 'converted' as const };
    const index = next.migrationBindings.findIndex(b => b.sourceId === sourceId && b.path === path);
    if (index < 0) next.migrationBindings.push(value); else next.migrationBindings[index] = value;
  };
  const walk = (value: unknown, path: string) => {
    if (!value || typeof value !== 'object') return;
    bind(path);
    if (Array.isArray(value)) value.forEach(v => { if (v && typeof v === 'object' && ('id' in v || 'date' in v)) walk(v, keyed(path === '/' ? '' : path, String(v.id ?? v.date))); });
    else Object.entries(value).forEach(([key, v]) => walk(v, `${path === '/' ? '' : path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`));
  };
  walk(source.raw, '/');
  const config = old.config;
  const content = (title: string, criteria: string, minutes: number | null, minimum = false, projects: string[] = [], goals: string[] = []): Content => ({ title, criteria, presetMinutes: minutes, color: '#3c745f', categoryId: null, categoryLabel: null, minimum,
    projectIds: projects.map(x => id(keyed('/planner/refs', x))), goalIds: goals.map(x => id(keyed('/planner/goals', x))),
    projectLabels: projects.map(x => ({ id: id(keyed('/planner/refs', x)), label: old.planner!.refs.find(r => r.id === x)!.name })),
    goalLabels: goals.map(x => ({ id: id(keyed('/planner/goals', x)), label: old.planner!.goals.find(r => r.id === x)!.name })) });
  const legalCard = (cardId: string, seen = new Set<string>()): boolean => {
    if (seen.has(cardId)) return false; seen.add(cardId);
    const card = config?.cards.find(c => c.id === cardId);
    return !!card && card.minutes % 5 === 0 && (!card.parentId || legalCard(card.parentId, seen));
  };
  if (config) {
    if (sameValue(base, emptyActionData())) next.settings = { zone: choices.zone, preferences: structuredClone(config.preferences), categories: [] };
    next.settings.categories.push(...config.categories.map(c => ({ ...c, id: id(keyed('/config/categories', c.id)) })));
    for (const card of config.cards) {
      const path = keyed('/config/cards', card.id);
      if (!legalCard(card.id)) { issue(path, 'LEGACY_GRID', '旧时长或父定义不适用新网格，原文保留只读', false); continue; }
      const category = config.categories.find(c => c.id === card.categoryId);
      p.definitions.push({ id: id(path), version: 1, content: { ...content(card.title, card.steps, card.minutes), categoryId: card.categoryId ? id(keyed('/config/categories', card.categoryId)) : null, categoryLabel: category?.name ?? null, color: category?.color ?? '#3c745f' } as Mutable<Content>, enabled: card.enabled,
        parentDefinitionId: card.parentId ? id(keyed('/config/cards', card.parentId)) : null, source: ref(path) }); bind(path, { kind: 'definition', id: id(path) });
    }
    for (const template of config.schedules) {
      const path = keyed('/config/schedules', template.id);
      if (template.entries.some(e => e.minutes % 5 || Number(e.start.slice(3)) % 5)) { issue(path, 'LEGACY_GRID', '旧模板保留精确原文，不自动取整', false); continue; }
      p.templates.push({ id: id(path), version: 1, name: template.name, weekdays: [], source: ref(path), entries: template.entries.map((e, i) => ({ id: `${id(path)}:entry-${i}`, title: config.cards.find(c => c.id === e.cardId)!.title, start: e.start, elapsedMinutes: e.minutes, definitionId: legalCard(e.cardId) ? id(keyed('/config/cards', e.cardId)) : null })) }); bind(path, { kind: 'template', id: id(path) });
    }
  }
  const planner = old.planner;
  if (!planner) {
    for (const project of old.projects ?? []) { const path = keyed('/projects', project.id); p.refs.push({ ...project, id: id(path) }); bind(path, { kind: 'project', id: id(path) }); }
    for (const capture of old.inbox ?? []) {
      const path = keyed('/inbox', capture.id);
      p.captures.push({ id: id(path), version: 1, text: capture.text, createdAt: legacyInstant(capture.createdAt), source: 'legacy', status: capture.status === 'inbox' ? 'unprocessed' : capture.status === 'converted' ? 'resolved' : 'discarded', target: capture.status === 'converted' ? ref(keyed('/config/cards', capture.targetId!)) : null }); bind(path, { kind: 'capture', id: id(path) });
    }
    for (const rule of old.routines ?? []) {
      const path = keyed('/routines', rule.id);
      if (!legalCard(rule.cardId)) { issue(path, 'LEGACY_GRID', '旧例行的定义不符合网格，保留只读', false); continue; }
      if (!choices.zone) { issue(path, 'ZONE_REQUIRED', '例行规则需要明确来源时区', true, ['选择时区']); continue; }
      p.rules.push({ id: id(path), version: 1, name: rule.title, definitionId: id(keyed('/config/cards', rule.cardId)), weekdays: [...rule.weekdays], startDate: dateAt(at, choices.zone), zone: choices.zone, status: rule.enabled ? 'active' : 'paused', source: ref(path) }); bind(path, { kind: 'rule', id: id(path) });
      issue(path, 'ROUTINE_START', '旧规则未记录起始日；新规则从本次升级日开始，旧日期保留原文', false);
    }
    for (const day of old.days ?? []) {
      const path = keyed('/days', day.date);
      if (!choices.zone) { issue(path, 'ZONE_REQUIRED', '日期快照需要明确来源时区', true, ['选择时区']); continue; }
      if (p.days.some(d => d.date === day.date)) { issue(path, 'DAY_COLLISION', '目标日期已存在，不能覆盖已有快照', true); continue; }
      p.days.push({ date: day.date, zone: choices.zone, version: 1, name: config?.schedules.find(s => s.id === day.scheduleId)?.name ?? '', template: null, minimum: day.minimumMode ?? false, top3: (day.top3 ?? []).map(cardId => ref(keyed('/config/cards', cardId))), overrides: [] }); bind(path, { kind: 'day', id: day.date });
    }
  }
  if (planner) {
    for (const project of planner.refs) { const path = keyed('/planner/refs', project.id); p.refs.push({ ...project, id: id(path) }); bind(path, { kind: 'project', id: id(path) }); }
    for (const goal of planner.goals) { const path = keyed('/planner/goals', goal.id); p.goals.push({ ...goal, id: id(path) }); bind(path, { kind: 'goal', id: id(path) }); }
    for (const template of planner.templates) {
      const path = keyed('/planner/templates', template.id);
      if (template.blocks.some(b => b.start % 5 || (b.end - b.start) % 5)) { issue(path, 'LEGACY_GRID', '旧模板保留只读', false); continue; }
      if (config?.schedules.some(t => t.name === template.name)) issue(path, 'DUPLICATE_TEMPLATE_NAME', '同名模板保留独立来源，不按名称合并', false);
      p.templates.push({ id: id(path), version: 1, name: template.name, weekdays: [...template.weekdays], source: ref(path), entries: template.blocks.filter(b => !b.cancelled).map(b => ({ id: b.id, title: b.title, start: minuteText(b.start), elapsedMinutes: b.end - b.start, definitionId: null })) }); bind(path, { kind: 'template', id: id(path) });
    }
    for (const rule of planner.rules) {
      const path = keyed('/planner/rules', rule.id);
      if (!choices.zone) { issue(path, 'ZONE_REQUIRED', '例行规则需要明确来源时区', true, ['选择时区']); continue; }
      const definitionId = `${id(path)}:definition`;
      p.definitions.push({ id: definitionId, version: 1, content: content(rule.title, rule.criteria, null, rule.minimum, rule.projects, rule.goals) as Mutable<Content>, enabled: true, parentDefinitionId: null, source: ref(path) });
      p.rules.push({ id: id(path), version: 1, name: rule.name, definitionId, weekdays: [...rule.weekdays], startDate: rule.start, zone: choices.zone, status: rule.status, source: ref(path) }); bind(path, { kind: 'rule', id: id(path) });
    }
    const completed = new Set(planner.occurrences.filter(o => o.status === 'completed').map(o => o.task));
    for (const task of planner.tasks) {
      const path = keyed('/planner/tasks', task.id);
      if (task.status === 'done' || completed.has(task.id) || task.occurrence || choices.readonlyPaths?.includes(path)) continue;
      const blocks = planner.days.flatMap(day => day.blocks.filter(b => b.task === task.id && !b.cancelled).map(block => ({ day, block, path: keyed(keyed('/planner/days', day.date) + '/blocks', block.id) })));
      if (blocks.length > 1) { issue(path, 'MULTIPLE_BLOCKS', '一个行动有多个旧时段，请明确选择保留只读', true, ['保留只读']); continue; }
      let range: RecordedRange | null = null;
      if (blocks.length) {
        const value = blocks[0];
        if (!choices.zone) { issue(value.path, 'ZONE_REQUIRED', '时段需要明确来源时区', true, ['选择时区']); continue; }
        try { range = oldRange(value.day.date, value.block, choices.zone, choices.offsets?.[value.path]); }
        catch (error) { issue(value.path, 'TIME_UNRESOLVED', (error as Error).message, true, ['选择起止偏移']); continue; }
        if (value.block.start % 5 || elapsedMinutes(range) % 5 || elapsedMinutes(range) > 1440) { issue(path, 'LEGACY_GRID', '旧排期不符合新网格，行动与区间保持只读', false); continue; }
      }
      const currentContent = content(task.title, task.criteria, range ? elapsedMinutes(range) : null, task.minimum, task.projects, task.goals);
      const instanceId = id(path), withdrawn = ['skipped', 'cancelled'].includes(task.status);
      p.instances.push({ id: instanceId, version: 1, definition: null, creationSnapshot: structuredClone(currentContent) as Mutable<Content>, currentContent: currentContent as Mutable<Content>, source: ref(path), createdAt: at, targetDate: task.date || null, state: withdrawn ? 'withdrawn' : 'open', occurrenceId: null,
        makeupOf: task.makeupOf ? ref(keyed('/planner/occurrences', task.makeupOf)) : null }); bind(path, { kind: 'instance', id: instanceId });
      if (range && !withdrawn) { const planId = id(blocks[0].path); p.plans.push({ id: planId, version: 1, instanceId, range, contentSnapshot: structuredClone(currentContent) as Mutable<Content>, status: 'active', createdAt: at, changedAt: at }); bind(blocks[0].path, { kind: 'plan', id: planId }); }
      else if (!withdrawn) p.handOrder.push(instanceId);
    }
    const taskRef = (taskId: string) => next.migrationBindings.find(b => b.sourceId === sourceId && b.path === keyed('/planner/tasks', taskId))!.target as { kind: 'instance'; id: string } | LegacyRef;
    for (const capture of planner.captures) { const path = keyed('/planner/captures', capture.id); p.captures.push({ id: id(path), version: 1, text: capture.text, createdAt: legacyInstant(capture.at), source: capture.source, status: capture.status, target: capture.status === 'resolved' ? taskRef(capture.target) : null }); bind(path, { kind: 'capture', id: id(path) }); }
    for (const day of planner.days) {
      const path = keyed('/planner/days', day.date);
      if (!choices.zone) { issue(path, 'ZONE_REQUIRED', '日期快照需要明确来源时区', true, ['选择时区']); continue; }
      if (p.days.some(d => d.date === day.date)) { issue(path, 'DAY_COLLISION', '目标日期已存在，不能覆盖已有日期快照', true); continue; }
      p.days.push({ date: day.date, zone: choices.zone, version: 1, name: day.name, template: null, minimum: day.minimum, top3: day.top3.map(taskRef), overrides: [] }); bind(path, { kind: 'day', id: day.date });
    }
  }
  // Interpretation is separate from immutable source JSON and survives export/restore.
  p.history.push({ id: `${commandId}:migration`, commandId, at, date: at.slice(0, 10), type: 'MigrationCommitted', entity: ref('/'), before: null,
    after: { sourceFingerprint, mappingVersion: 1, choices: structuredClone(choices) } as unknown as Mutable<Json> });
  const projection = legacyProjection(next);
  for (const item of projection.items.filter(i => i.source.sourceId === sourceId && i.occupancy === 'unknown')) issue(item.source.path, 'UNKNOWN_OCCUPANCY', '旧占用无法完整解释；先解决来源时间再升级', true, ['选择时区或起止偏移']);
  try { validateActionData(next); } catch (error) { issue('/', 'INVALID_TARGET', (error as Error).message, true); }
  if (backupBytes(next) > MAX_BACKUP_BYTES) issue('/', 'DATA_TOO_LARGE', '迁移后完整备份超过 5 MiB', true);
  const bindings = next.migrationBindings.filter(b => b.sourceId === sourceId);
  return { data: next, report: { sourceFingerprint, mappingVersion: 1, bindings, issues,
    targetSummary: { definitions: p.definitions.length - base.planner.definitions.length, instances: p.instances.length - base.planner.instances.length, plans: p.plans.length - base.planner.plans.length, facts: 0, readonlyItems: bindings.filter(b => b.disposition === 'readonly').length } } };
}

export function oldOccurrenceExists(data: DataV2, rule: DataV2['planner']['rules'][number], date: string): boolean {
  if (rule.source.kind !== 'legacy') return false;
  const sourceRef = rule.source, source = data.legacySources.find(s => s.id === sourceRef.sourceId);
  if (!source) return false;
  const old = rawData(source), original = resolveLegacyPath(source.raw, sourceRef.path) as { id: string };
  return !!old.planner?.occurrences.some(o => o.rule === original.id && o.date === date) || !!old.occurrences?.some(o => o.routineId === original.id && o.plannedDate === date);
}

export function legacyMakeup(data: DataV2, ref: LegacyRef, targetDate: string, at: string, instanceId: string): ActionOperation {
  assertDate(targetDate);
  const source = data.legacySources.find(s => s.id === ref.sourceId), choices = reportChoices(data, ref.sourceId);
  if (!source || !choices?.zone || !/^\/(planner\/)?occurrences\/@/.test(ref.path)) throw new ActionDomainError('MIGRATION_BLOCKED', '旧例行的来源或原时区尚未解释');
  const occurrence = resolveLegacyPath(source.raw, ref.path) as { id: string; date?: string; plannedDate?: string; task?: string; cardId?: string; status: string };
  const date = occurrence.date ?? occurrence.plannedDate!;
  if (!date || date >= dateAt(at, choices.zone) || ['done', 'completed'].includes(occurrence.status)) throw new ActionDomainError('PAST_OCCURRENCE_LOCKED', '只能为过去未完成例行另建补做，原结果保持只读');
  const old = source.raw as unknown as Partial<Data>, task = old.planner?.tasks.find(t => t.id === occurrence.task), card = old.config?.cards.find(c => c.id === occurrence.cardId);
  const existingTask = old.planner?.tasks.find(t => t.makeupOf === occurrence.id), existingOccurrence = old.occurrences?.find(o => o.makeupOf === occurrence.id);
  if (existingTask && !data.planner.instances.some(i => sameValue(i.makeupOf, ref))) return { type: 'UseExistingLegacy', reference: { kind: 'legacy', sourceId: ref.sourceId, path: keyed('/planner/tasks', existingTask.id) } };
  if (existingOccurrence && !data.planner.instances.some(i => sameValue(i.makeupOf, ref))) return { type: 'UseExistingLegacy', reference: { kind: 'legacy', sourceId: ref.sourceId, path: keyed('/occurrences', existingOccurrence.id) } };
  if (!task && !card) throw new ActionDomainError('MIGRATION_BLOCKED', '旧例行内容不存在');
  const projectIds = (task?.projects ?? []).map(id => `${ref.sourceId}:${keyed('/planner/refs', id)}`), goalIds = (task?.goals ?? []).map(id => `${ref.sourceId}:${keyed('/planner/goals', id)}`);
  return { type: 'CreateLegacyMakeup', occurrence: ref, instanceId, targetDate, content: { title: task?.title ?? card!.title, criteria: task?.criteria ?? card!.steps, presetMinutes: card && card.minutes % 5 === 0 ? card.minutes : null, color: '#3c745f', categoryId: null, categoryLabel: null, minimum: task?.minimum ?? false, projectIds, goalIds,
    projectLabels: projectIds.map(id => ({ id, label: data.planner.refs.find(r => r.id === id)!.name })), goalLabels: goalIds.map(id => ({ id, label: data.planner.goals.find(g => g.id === id)!.name })) } };
}
