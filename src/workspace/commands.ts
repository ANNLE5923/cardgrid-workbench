import type { ActualDraft, ActualPreview, Command, Content, DataV2, Day, EnvelopeV4, ErrorCode, Fixed, Instance, LocalInput, PlacementPreview, PlacementQuery, Range, Result, SubmitResult, Token, VersionRef } from './contracts.ts';
import { ActionDomainError, applyAction, assertActionState, overlaps, sameValue, type ActionOperation, type CompatibilityOccupancy, type Occupancy, type Overlap } from '../daily/model.ts';
import { ActionTimeError, actualRange, assertDate, assertZone, dateAt, elapsedMinutes, intersectRanges, nextDate, plannedRange, weekday } from '../daily/time.ts';
import { backupBytes, canonicalJson, emptyActionData, fingerprint, inspectEnvelope, MAX_BACKUP_BYTES, validateActionData, validateCommandPayload, validateSourceFingerprints, validateWorkspace, WorkspaceFormatError } from './format.ts';
import { legacyMakeup, oldOccurrenceExists } from './migration.ts';
import { compatibilityFor, projectedTemplates, segmentsFor } from '../daily/projection.ts';
import type { WorkspaceStore } from './store.ts';

export type WorkspaceSnapshot = Readonly<{ mode: 'uninitialized' | 'current' | 'legacy-readonly'; token: Token; data: DataV2 | null; raw: unknown; rawKey: string }>;
export async function inspectSnapshot(raw: unknown): Promise<WorkspaceSnapshot> {
  const inspection = inspectEnvelope(raw);
  validateWorkspace(raw);
  if (inspection.kind === 'uninitialized') return { mode: 'uninitialized', token: { epoch: 'uninitialized', revision: 0 }, data: emptyActionData(), raw, rawKey: 'uninitialized' };
  if (inspection.kind === 'current') {
    const envelope = raw as EnvelopeV4 & { mode: 'current' };
    await validateSourceFingerprints(envelope.data);
    return { mode: 'current', token: { epoch: envelope.epoch, revision: envelope.revision }, data: envelope.data, raw, rawKey: canonicalJson(raw) };
  }
  const envelope = raw as { schemaVersion: number; epoch?: string; revision: number };
  return { mode: 'legacy-readonly', token: { epoch: envelope.schemaVersion === 4 ? envelope.epoch! : `legacy:${await fingerprint(raw)}`, revision: envelope.revision }, data: null, raw, rawKey: canonicalJson(raw) };
}
export function checkToken(current: Token, expected: Token, revision = true): void {
  if (current.epoch !== expected.epoch) throw new ActionDomainError('WORKSPACE_REPLACED', '工作区已被替换，请重新载入');
  if (revision && current.revision !== expected.revision) throw new ActionDomainError('REVISION_CONFLICT', '另一窗口已更新数据，本次没有覆盖');
}
export function commandFailure(error: unknown): Exclude<Result<never>, { ok: true }> {
  const known = error instanceof ActionDomainError || error instanceof ActionTimeError;
  const code: ErrorCode = known ? error.code : error instanceof WorkspaceFormatError ? 'UNKNOWN_FORMAT' : 'STORAGE_FAILED';
  const retry = code === 'WORKSPACE_REPLACED' || code === 'REVISION_CONFLICT' ? 'reload' :
    ['PREVIEW_STALE', 'OVERLAP_CONFIRMATION_REQUIRED', 'FIXED_LOCKED'].includes(code) ? 'preview' : code === 'STORAGE_FAILED' ? 'same-command' : 'edit';
  return { ok: false, code, message: error instanceof Error ? error.message : String(error),
    ...(known && error.field ? { field: error.field } : error instanceof WorkspaceFormatError ? { field: error.path } : {}),
    ...(error instanceof ActionTimeError && error.choices.length ? { choices: error.choices } : {}), retry };
}
function need(condition: unknown, code: ErrorCode, message: string): asserts condition { if (!condition) throw new ActionDomainError(code, message); }
export function assertCommand(command: Command): void {
  need(command && typeof command === 'object' && Object.keys(command).sort().join(',') === 'commandId,expected,payload,type', 'INVALID_INPUT', '命令字段无效');
  need(typeof command.commandId === 'string' && command.commandId.trim() && typeof command.expected?.epoch === 'string' && command.expected.epoch && Number.isSafeInteger(command.expected.revision) && command.expected.revision >= 0 && Object.keys(command.expected).sort().join(',') === 'epoch,revision', 'INVALID_INPUT', '请求标识或令牌无效');
  const fields: Record<Command['type'], string> = {
    SaveSettings: 'settings', CreateCapture: 'text,source', SetCaptureStatus: 'capture,status', UpdateDay: 'date,version,minimum,top3', SaveTemplate: 'template,expectedVersion', SaveRule: 'rule,expectedVersion', SaveProject: 'project', SaveGoal: 'goal',
    SaveDefinition: 'id,expectedVersion,content,enabled,parentDefinitionId', ArchiveDefinition: 'definition', AcceptOffer: 'definition,targetDate', ResolveCaptureToAction: 'capture,content,targetDate', UpdateOpenInstance: 'instance,content,targetDate,placementPreviewId,acknowledgedOverlap',
    ReorderHand: 'instanceIds', WithdrawInstance: 'instance', ReturnWithdrawnToHand: 'instance', CommitPlacement: 'previewId,candidateId,acknowledgedOverlap', RetractPlan: 'planId,version', CancelFixed: 'commitment,unlockId', ApplyDayTemplate: 'previewId,acknowledgedOverlap', ConfirmActual: 'previewId,acknowledgedOverlap', AppendAnnotation: 'factId,text', PrepareDay: 'date,zone,templateId', CreateMakeup: 'occurrence,targetDate', ImportDefinitions: 'previewId,mode,backup', RestoreWorkspace: 'previewId,backup,discardDraftsConfirmed', ClearWorkspace: 'backup,discardDraftsConfirmed', CommitMigration: 'previewId,backup,discardDraftsConfirmed'
  };
  need(Object.hasOwn(fields, command.type) && command.payload && typeof command.payload === 'object' && Object.keys(command.payload).sort().join(',') === fields[command.type].split(',').sort().join(','), 'INVALID_INPUT', '命令内容缺字段或含未知字段');
  try { validateCommandPayload(command); } catch (error) { throw new ActionDomainError('INVALID_INPUT', (error as Error).message, error instanceof WorkspaceFormatError ? error.path : undefined); }
}
type Grant = { token: Token; operation: ActionOperation; conflicts: readonly Overlap[]; acknowledgementId: string | null; candidateId?: string; unlockId?: string };
type Unlock = { token: Token; id: string; version: number };
export type ActionServiceOptions = Readonly<{ now?: () => string; id?: () => string; compatibility?: (data: DataV2) => CompatibilityOccupancy | undefined;
  definitionImport?: (command: Extract<Command, { type: 'ImportDefinitions' }>, snapshot: WorkspaceSnapshot & { data: DataV2 }) => Extract<ActionOperation, { type: 'ImportDefinitions' }> }>;

export function calendarOperation(data: DataV2, input: { date: string; zone: string; templateId: string | null; entryOffsets?: Readonly<Record<string, string>> }, replace: boolean, at: string, prefix: string): Extract<ActionOperation, { type: 'ApplyCalendar' }> {
  assertDate(input.date); assertZone(input.zone);
  const p = data.planner, old = p.days.find(d => d.date === input.date);
  const matches = p.templates.filter(t => t.weekdays.includes(weekday(input.date)));
  if (!old || replace) need(input.templateId !== null || matches.length <= 1, 'AMBIGUOUS_DAY_TEMPLATE', '当天有多个模板，请明确选择');
  const template = old && !replace ? p.templates.find(t => t.id === old.template?.id) : input.templateId ? p.templates.find(t => t.id === input.templateId) : matches[0];
  if (input.templateId !== null) need(template, 'INVALID_INPUT', '模板不存在');
  const fixed: Fixed[] = [];
  if (!old || replace) {
    const prior = p.fixed.filter(f => f.ownerDate === input.date && f.template !== null && !f.manuallyOverridden);
    for (const value of prior) if (!value.cancelled) fixed.push({ ...value, version: value.version + 1, cancelled: true });
    for (const entry of template?.entries ?? []) {
      if (old?.overrides.some(o => o.entryId === entry.id)) continue;
      const range = plannedRange({ date: input.date, time: entry.start, zone: input.zone, ...(input.entryOffsets?.[entry.id] ? { offset: input.entryOffsets[entry.id] } : {}) }, entry.elapsedMinutes);
      const existing = prior.find(f => f.template?.id === template!.id && f.templateEntryId === entry.id);
      const value: Fixed = { id: existing?.id ?? `${prefix}:fixed:${entry.id}`, version: existing ? existing.version + 1 : 1, title: entry.title, range, cancelled: false, ownerDate: input.date,
        template: { id: template!.id, version: template!.version }, templateEntryId: entry.id, manuallyOverridden: false, source: { kind: 'manual' } };
      const index = fixed.findIndex(f => f.id === value.id); if (index < 0) fixed.push(value); else fixed[index] = value;
    }
  }
  const day: Day = old && !replace ? old : { date: input.date, zone: input.zone, version: old ? old.version + 1 : 1, name: template?.name ?? '未选择日型', template: template ? { id: template.id, version: template.version } : null, minimum: old?.minimum ?? false, top3: old?.top3 ?? [], overrides: old?.overrides ?? [] };
  const instances: Instance[] = [], occurrences: DataV2['planner']['occurrences'][number][] = [];
  for (const rule of p.rules) {
    if (rule.status !== 'active' || rule.startDate > input.date || input.date < dateAt(at, rule.zone) || !rule.weekdays.includes(weekday(input.date)) || p.occurrences.some(o => o.ruleId === rule.id && o.date === input.date) || oldOccurrenceExists(data, rule, input.date)) continue;
    const definition = p.definitions.find(d => d.id === rule.definitionId)!;
    if (!definition.enabled) continue;
    const occurrenceId = `${prefix}:occurrence:${rule.id}`, instanceId = `${prefix}:instance:${rule.id}`;
    instances.push({ id: instanceId, version: 1, definition: { id: definition.id, version: definition.version }, creationSnapshot: structuredClone(definition.content), currentContent: structuredClone(definition.content), source: { kind: 'occurrence', id: occurrenceId }, createdAt: at, targetDate: input.date, state: 'open', occurrenceId, makeupOf: null });
    occurrences.push({ id: occurrenceId, ruleId: rule.id, date: input.date, instanceId, disposition: 'generated' });
  }
  return { type: 'ApplyCalendar', day, fixed, instances, occurrences };
}
function calendarConflicts(data: DataV2, operation: Extract<ActionOperation, { type: 'ApplyCalendar' }>, compatibility?: CompatibilityOccupancy): readonly Overlap[] {
  const changedIds = new Set(operation.fixed.map(f => f.id));
  const filtered = { ...data, planner: { ...data.planner, fixed: data.planner.fixed.filter(f => !changedIds.has(f.id)) } };
  const changed = operation.fixed.filter(f => !f.cancelled);
  const zone = operation.day.zone, ownerDate = operation.day.date;
  // Project unprepared day templates for every calendar date reached by the new fixed blocks' full ranges.
  // The window opens one day early (a previous day template can spill into the owner day) and excludes the
  // owner date, whose own template is being instantiated; otherwise it would conflict with itself.
  let firstDate = nextDate(ownerDate, -1), lastDate = ownerDate;
  for (const item of changed) {
    const startDate = dateAt(item.range.startAt, zone), endDate = dateAt(item.range.endAt, zone);
    if (startDate < firstDate) firstDate = startDate;
    if (endDate > lastDate) lastDate = endDate;
  }
  const projected: Occupancy[] = [];
  for (let date = firstDate; date <= lastDate; date = nextDate(date))
    if (date !== ownerDate) projected.push(...projectedTemplates(data, date, zone));
  const withSpill: CompatibilityOccupancy | undefined = projected.length
    ? { unknown: compatibility?.unknown ?? false, items: [...(compatibility?.items ?? []), ...projected] }
    : compatibility;
  const result: Overlap[] = [];
  for (const [i, item] of changed.entries()) {
    result.push(...overlaps(filtered, item.range, undefined, withSpill).map(c => ({ ...c, id: `${item.id}->${c.id}` })));
    for (const other of changed.slice(i + 1)) { const overlap = intersectRanges(item.range, other.range); if (overlap) result.push({ kind: 'fixed', id: `${item.id}->${other.id}`, title: other.title, range: other.range, overlap }); }
  }
  return result;
}

/** Trusted command boundary. UI receives IDs, never a self-signable resolved operation. */
export function createActionService(store: WorkspaceStore, options: ActionServiceOptions = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const id = options.id ?? (() => crypto.randomUUID());
  const grants = new Map<string, Grant[]>(), unlocks = new Map<string, Unlock>();
  const invalidate = () => { grants.clear(); unlocks.clear(); };
  const readSnapshot = async () => inspectSnapshot(await store.read());
  const unsubscribe = store.subscribe(() => {
    void readSnapshot().then(snapshot => {
      for (const [key, values] of grants) if (values.some(value => !sameValue(value.token, snapshot.token))) grants.delete(key);
      for (const [key, value] of unlocks) if (!sameValue(value.token, snapshot.token)) unlocks.delete(key);
    }).catch(invalidate);
  });
  const compatible = (data: DataV2, range?: Range) => options.compatibility?.(data) ?? compatibilityFor(data, range);
  const current = async (expected?: Token) => {
    const snapshot = await readSnapshot();
    if (expected) checkToken(snapshot.token, expected);
    need(snapshot.data, 'LEGACY_READ_ONLY', '旧版数据只读，请先备份并显式升级');
    return { ...snapshot, data: snapshot.data };
  };
  const context = (data: DataV2, commandId: string, at: string) => ({ commandId, historyId: id(), at, date: dateAt(at, data.settings.zone ?? 'UTC'), compatibility: compatible(data) });
  function checkGrant(grant: Grant, snapshot: WorkspaceSnapshot): void {
    need(sameValue(grant.token, snapshot.token), 'PREVIEW_STALE', '预览已过期，请重新预览');
    if (grant.unlockId) {
      const unlock = unlocks.get(grant.unlockId);
      need(unlock && sameValue(unlock.token, snapshot.token), 'FIXED_LOCKED', '固定安排授权已失效');
    }
  }
  function operationFrom(command: Command, snapshot: WorkspaceSnapshot & { data: DataV2 }): ActionOperation {
    switch (command.type) {
      case 'ImportDefinitions': need(options.definitionImport, 'PREVIEW_STALE', '请重新预览配置'); return options.definitionImport(command, snapshot);
      case 'CreateCapture': return { ...command.payload, type: 'CreateCapture', captureId: id() };
      case 'SaveSettings': case 'SetCaptureStatus': case 'UpdateDay': case 'SaveTemplate': case 'SaveRule': case 'SaveProject': case 'SaveGoal': return { ...command.payload, type: command.type } as ActionOperation;
      case 'PrepareDay': {
        const operation = calendarOperation(snapshot.data, command.payload, false, now(), command.commandId);
        need(calendarConflicts(snapshot.data, operation, compatible(snapshot.data)).length === 0, 'OVERLAP_CONFIRMATION_REQUIRED', '准备日有重叠，请使用模板预览确认后应用'); return operation;
      }
      case 'SaveDefinition': return { ...command.payload, type: 'SaveDefinition', id: command.payload.id ?? id() };
      case 'ArchiveDefinition': {
        const definition = snapshot.data.planner.definitions.find(d => d.id === command.payload.definition.id);
        need(definition, 'INVALID_INPUT', '定义不存在');
        return { type: 'SaveDefinition', id: definition.id, expectedVersion: command.payload.definition.version, content: definition.content, parentDefinitionId: definition.parentDefinitionId, enabled: false };
      }
      case 'AcceptOffer': return { type: 'AcceptDefinition', ...command.payload, instanceId: id() };
      case 'ResolveCaptureToAction': return { type: 'ResolveCapture', ...command.payload, instanceId: id() };
      case 'ReorderHand': return { type: 'ReorderHand', ...command.payload };
      case 'WithdrawInstance': return { type: 'WithdrawInstance', ...command.payload };
      case 'ReturnWithdrawnToHand': return { type: 'ReturnToHand', ...command.payload };
      case 'RetractPlan': return { type: 'RetractPlan', plan: { id: command.payload.planId, version: command.payload.version } };
      case 'AppendAnnotation': return { type: 'AppendAnnotation', ...command.payload, annotationId: id() };
      case 'CreateMakeup': {
        if (command.payload.occurrence.kind === 'legacy') return legacyMakeup(snapshot.data, command.payload.occurrence, command.payload.targetDate, now(), id());
        return { type: 'CreateMakeup', occurrenceId: command.payload.occurrence.id, instanceId: id(), targetDate: command.payload.targetDate };
      }
      case 'UpdateOpenInstance': {
        if (command.payload.placementPreviewId !== null) {
          const grant = grants.get(command.payload.placementPreviewId)?.[0];
          need(grant?.operation.type === 'UpdateInstance', 'PREVIEW_STALE', '实例编辑预览不存在'); checkGrant(grant, snapshot);
          need(sameValue(grant.operation.instance, command.payload.instance) && sameValue(grant.operation.content, command.payload.content) && grant.operation.targetDate === command.payload.targetDate, 'PREVIEW_STALE', '编辑输入已改变，请重新预览');
          need(command.payload.acknowledgedOverlap === grant.acknowledgementId, 'OVERLAP_CONFIRMATION_REQUIRED', '请确认完整重叠');
          return { ...structuredClone(grant.operation), acknowledgedOverlaps: grant.conflicts };
        }
        return { type: 'UpdateInstance', instance: command.payload.instance, content: command.payload.content, targetDate: command.payload.targetDate };
      }
      case 'CancelFixed': {
        const unlock = unlocks.get(command.payload.unlockId);
        need(unlock && sameValue(unlock.token, snapshot.token) && unlock.id === command.payload.commitment.id && unlock.version === command.payload.commitment.version, 'FIXED_LOCKED', '请重新解锁固定安排');
        return { type: 'CancelFixed', fixed: command.payload.commitment, unlock: { id: unlock.id, version: unlock.version } };
      }
      case 'ApplyDayTemplate': case 'CommitPlacement': case 'ConfirmActual': {
        const payload = command.payload;
        const grant = grants.get(payload.previewId)?.find(g => command.type === 'ConfirmActual' ? g.operation.type === 'ConfirmActual' : command.type === 'ApplyDayTemplate' ? g.operation.type === 'ApplyCalendar' : g.candidateId === command.payload.candidateId);
        need(grant, 'PREVIEW_STALE', '预览不存在或已使用'); checkGrant(grant, snapshot);
        const allowed = payload.acknowledgedOverlap === grant.acknowledgementId;
        need(!grant.conflicts.length || (allowed && grant.acknowledgementId !== null), 'OVERLAP_CONFIRMATION_REQUIRED', '请明确确认本次完整重叠');
        need(payload.acknowledgedOverlap === null || allowed, 'PREVIEW_STALE', '重叠确认已失效');
        return { ...structuredClone(grant.operation), acknowledgedOverlaps: grant.conflicts } as ActionOperation;
      }
      default: throw new ActionDomainError('INVALID_INPUT', `命令 ${command.type} 的生命周期适配尚未启用`);
    }
  }
  return {
    readSnapshot,
    invalidateCapabilities: invalidate,
    close() { unsubscribe(); invalidate(); },
    async previewInstanceUpdate(input: { token: Token; instance: VersionRef; content: Content; targetDate: string | null; start: LocalInput }) {
      try {
        input = structuredClone(input); const snapshot = await current(input.token), data = snapshot.data;
        const plan = data.planner.plans.find(p => p.instanceId === input.instance.id && p.status === 'active'); need(plan, 'INVALID_INPUT', '没有活动计划');
        const replacementRange = plannedRange(input.start, input.content.presetMinutes), conflicts = overlaps(data, replacementRange, { kind: 'plan', id: plan.id }, compatible(data, replacementRange));
        const operation: ActionOperation = { type: 'UpdateInstance', instance: input.instance, content: input.content, targetDate: input.targetDate, replacementRange };
        applyAction(data, { ...operation, acknowledgedOverlaps: conflicts }, { ...context(data, 'preview', now()), compatibility: compatible(data, replacementRange) });
        const previewId = id(), acknowledgementId = conflicts.length ? id() : null;
        grants.set(previewId, [{ token: snapshot.token, operation: structuredClone(operation), conflicts: structuredClone(conflicts), acknowledgementId }]);
        return { ok: true as const, value: { previewId, token: snapshot.token, range: replacementRange, conflicts, acknowledgementId } };
      } catch (error) { return commandFailure(error); }
    },
    async previewDayTemplate(input: { token: Token; date: string; zone: string; templateId: string | null; entryOffsets?: Readonly<Record<string, string>> }) {
      try {
        input = structuredClone(input); const snapshot = await current(input.token), previewId = id();
        const operation = calendarOperation(snapshot.data, input, true, now(), previewId), conflicts = calendarConflicts(snapshot.data, operation, compatible(snapshot.data));
        const acknowledgementId = conflicts.length ? id() : null;
        applyAction(snapshot.data, operation, context(snapshot.data, previewId, now()));
        grants.set(previewId, [{ token: snapshot.token, operation: structuredClone(operation), conflicts: structuredClone(conflicts), acknowledgementId }]);
        return { ok: true as const, value: { previewId, token: snapshot.token, day: structuredClone(operation.day), fixed: structuredClone(operation.fixed), conflicts, acknowledgementId } };
      } catch (error) { return commandFailure(error); }
    },
    async unlockFixed(input: { token: Token; commitmentId: string; version: number }): Promise<Result<string>> {
      try {
        const snapshot = await current(input.token);
        const fixed = snapshot.data.planner.fixed.find(f => f.id === input.commitmentId && f.version === input.version && !f.cancelled);
        need(fixed, 'REVISION_CONFLICT', '固定安排已改变');
        const capability = id(); unlocks.set(capability, { token: snapshot.token, id: fixed.id, version: fixed.version });
        return { ok: true, value: capability };
      } catch (error) { return commandFailure(error); }
    },
    cancelPreview(previewId: string) { const value = grants.get(previewId); for (const grant of value ?? []) if (grant.unlockId) unlocks.delete(grant.unlockId); grants.delete(previewId); },
    async previewPlacement(query: PlacementQuery): Promise<Result<PlacementPreview>> {
      try {
        query = structuredClone(query);
        const snapshot = await current(query.token), data = snapshot.data, subject = query.subject;
        need(Number.isInteger(query.focusMinuteOfDay) && query.focusMinuteOfDay >= 0 && query.focusMinuteOfDay <= 1435 && query.focusMinuteOfDay % 5 === 0, 'INVALID_GRID', '请选择当天五分钟刻度');
        const time = `${String(Math.floor(query.focusMinuteOfDay / 60)).padStart(2, '0')}:${String(query.focusMinuteOfDay % 60).padStart(2, '0')}`;
        let minutes: number | null, base: { kind: 'plan' | 'fixed'; id: string } | undefined;
        if (subject.kind === 'fixed') {
          const unlock = unlocks.get(subject.unlockId);
          need(unlock && sameValue(unlock.token, snapshot.token) && unlock.id === subject.commitmentId && unlock.version === subject.version, 'FIXED_LOCKED', '请先解锁固定安排');
          const fixed = data.planner.fixed.find(f => f.id === subject.commitmentId && f.version === subject.version);
          need(fixed, 'REVISION_CONFLICT', '固定安排已改变'); minutes = elapsedMinutes(fixed.range); base = { kind: 'fixed', id: fixed.id };
        } else {
          const plan = subject.kind === 'plan' ? data.planner.plans.find(p => p.id === subject.planId && p.version === subject.version && p.status === 'active') : null;
          if (subject.kind === 'plan') need(plan, 'REVISION_CONFLICT', '计划已改变');
          const instance = data.planner.instances.find(i => i.id === (subject.kind === 'hand' ? subject.instanceId : plan!.instanceId));
          need(instance && (subject.kind !== 'hand' || instance.version === subject.version), 'REVISION_CONFLICT', '行动已改变');
          minutes = instance.currentContent.presetMinutes; if (plan) base = { kind: 'plan', id: plan.id };
        }
        const local = { date: query.date, time, zone: query.zone };
        let ranges;
        try { ranges = [plannedRange(local, minutes)]; }
        catch (error) {
          if (error instanceof ActionTimeError && error.code === 'AMBIGUOUS_LOCAL_TIME') ranges = error.choices.map(choice => plannedRange(choice.input, minutes));
          else throw error;
        }
        const previewId = id(), prepared: Grant[] = [];
        const candidates = ranges.map(range => {
          const conflicts = overlaps(data, range, base, compatible(data, range));
          const acknowledgementId = conflicts.length ? id() : null, candidateId = id();
          const operation: ActionOperation = subject.kind === 'hand' ? { type: 'PlaceInstance', instance: { id: subject.instanceId, version: subject.version }, planId: id(), range } :
            subject.kind === 'plan' ? { type: 'MovePlan', plan: { id: subject.planId, version: subject.version }, range } :
              { type: 'MoveFixed', fixed: { id: subject.commitmentId, version: subject.version }, unlock: { id: subject.commitmentId, version: subject.version }, range };
          applyAction(data, { ...operation, acknowledgedOverlaps: conflicts }, { ...context(data, `preview-${previewId}`, now()), compatibility: compatible(data, range) });
          prepared.push({ token: snapshot.token, operation: structuredClone(operation), conflicts: structuredClone(conflicts), acknowledgementId, candidateId, ...(subject.kind === 'fixed' ? { unlockId: subject.unlockId } : {}) });
          const view = { id: candidateId, half: (query.focusMinuteOfDay < 720 ? 0 : 1) as 0 | 1, range, label: `${range.localStart}—${range.localEnd}`, offsetLabel: `${range.startOffset}/${range.endOffset}`, units: minutes! / 5, segments: segmentsFor(range, query.date, query.zone, candidateId, subject.kind === 'fixed' ? 'fixed' : 'plan', '排期预览', false) };
          const blockers = conflicts.map(c => ({ id: c.id, kind: c.kind === 'legacy' ? 'template-projection' as const : c.kind, title: c.title, range: c.range, overlap: c.overlap }));
          return conflicts.length ? { ...view, state: 'conflict' as const, blockers, reason: '与已有安排重叠', acknowledgementId: acknowledgementId! } : { ...view, state: 'valid' as const };
        });
        grants.set(previewId, prepared);
        return { ok: true, value: structuredClone({ previewId, token: snapshot.token, query, candidates, unresolved: [] }) };
      } catch (error) { return commandFailure(error); }
    },
    async previewActual(input: { token: Token; draft: ActualDraft }): Promise<Result<ActualPreview>> {
      try {
        input = structuredClone(input);
        const snapshot = await current(input.token), data = snapshot.data, draft = input.draft;
        const range = actualRange(draft.start, draft.end);
        const instance = data.planner.instances.find(i => i.id === draft.instanceId);
        need(instance, 'INVALID_INPUT', '行动不存在');
        const plan = draft.mode === 'planned' ? data.planner.plans.find(p => p.id === draft.planId) : null;
        const conflicts = overlaps(data, range, plan ? { kind: 'plan', id: plan.id } : undefined, compatible(data, range));
        const operation: ActionOperation = { type: 'ConfirmActual', instance: { id: draft.instanceId, version: draft.instanceVersion },
          expectedPlan: draft.mode === 'planned' ? { id: draft.planId, version: draft.planVersion } : null, factId: id(), range };
        applyAction(data, { ...operation, acknowledgedOverlaps: conflicts }, { ...context(data, 'preview', now()), compatibility: compatible(data, range) });
        const previewId = id(), acknowledgementId = conflicts.length ? id() : null;
        grants.set(previewId, [{ token: snapshot.token, operation: structuredClone(operation), conflicts: structuredClone(conflicts), acknowledgementId }]);
        return { ok: true, value: structuredClone({ previewId, token: snapshot.token, draft, range, title: instance.currentContent.title, criteria: instance.currentContent.criteria,
          plannedRange: plan?.range ?? null, conflicts: conflicts.map(c => ({ ...c, kind: c.kind === 'legacy' ? 'template-projection' as const : c.kind })), acknowledgementId }) };
      } catch (error) { return commandFailure(error); }
    },
    async submit(input: Command): Promise<SubmitResult> {
      let command: Command | undefined;
      let retainPreview = false;
      try {
        command = structuredClone(input);
        assertCommand(command);
        need(command && typeof command.payload === 'object' && command.payload !== null && !Array.isArray(command.payload) && typeof command.expected?.epoch === 'string' && Number.isSafeInteger(command.expected.revision), 'INVALID_INPUT', '命令结构无效');
        need(typeof command.commandId === 'string' && !!command.commandId.trim(), 'INVALID_INPUT', '请求标识无效');
        const cmd = command;
        const payloadFingerprint = await fingerprint({ type: cmd.type, payload: cmd.payload });
        const before = await readSnapshot();
        const at = now(), historyId = id();
        return await store.atomic(raw => {
          const inspection = inspectEnvelope(raw);
          const envelope = raw as EnvelopeV4 | undefined;
          const token = envelope?.schemaVersion === 4 ? { epoch: envelope.epoch, revision: envelope.revision } : before.token;
          checkToken(token, cmd.expected, false);
          need(inspection.kind !== 'legacy-readonly', 'LEGACY_READ_ONLY', '旧版数据只读，请先备份并显式升级');
          const data = inspection.kind === 'uninitialized' ? emptyActionData() : (envelope as EnvelopeV4 & { mode: 'current' }).data;
          const receipt = data.commandReceipts.find(r => r.commandId === cmd.commandId);
          if (receipt) {
            need(receipt.payloadFingerprint === payloadFingerprint && receipt.type === cmd.type, 'COMMAND_ID_REUSED', '请求标识已用于其他内容');
            return { result: { ok: true, value: { token, resultRefs: receipt.resultRefs, replayed: true } } as SubmitResult };
          }
          checkToken(token, cmd.expected);
          need((raw === undefined ? 'uninitialized' : canonicalJson(raw)) === before.rawKey, 'REVISION_CONFLICT', '读取后工作区已改变，请重新提交');
          const snapshot = { mode: 'current' as const, token, data, raw, rawKey: '' };
          const operation = operationFrom(cmd, snapshot);
          const operationRange = 'range' in operation ? operation.range : operation.type === 'UpdateInstance' ? operation.replacementRange : undefined;
          const changed = applyAction(data, operation, { ...context(data, cmd.commandId, at), historyId, compatibility: compatible(data, operationRange) });
          const nextData: DataV2 = { ...changed.data, commandReceipts: [...data.commandReceipts, { commandId: cmd.commandId, type: cmd.type, payloadFingerprint, resultRefs: changed.resultRefs }] };
          validateActionData(nextData);
          need(backupBytes(nextData) <= MAX_BACKUP_BYTES, 'DATA_TOO_LARGE', '完整备份超过 5 MiB，本次未写入');
          const nextToken = { epoch: token.epoch, revision: token.revision + 1 };
          need(Number.isSafeInteger(nextToken.revision), 'INVALID_INPUT', '修订号已超出范围');
          const write: EnvelopeV4 = { schemaVersion: 4, ...nextToken, mode: 'current', dataFormat: 'action-v2', data: nextData, lifecycleReceipt: envelope?.schemaVersion === 4 ? envelope.lifecycleReceipt : null };
          return { write, at, reason: cmd.type, result: { ok: true, value: { token: nextToken, resultRefs: changed.resultRefs, replayed: false } } as SubmitResult };
        });
      } catch (error) {
        const failure = commandFailure(error);
        const previewId = command?.payload && ('previewId' in command.payload ? command.payload.previewId : 'placementPreviewId' in command.payload ? command.payload.placementPreviewId : null);
        const fixedAttempt = command?.type === 'CancelFixed' || !!(previewId && grants.get(previewId)?.some(g => g.unlockId));
        retainPreview = failure.code === 'STORAGE_FAILED' && !fixedAttempt;
        return failure.code === 'STORAGE_FAILED' && fixedAttempt ? { ...failure, retry: 'preview' } : failure;
      }
      finally {
        if (!retainPreview && command?.payload && 'previewId' in command.payload) grants.delete(command.payload.previewId);
        if (!retainPreview && command?.type === 'UpdateOpenInstance' && command.payload?.placementPreviewId) grants.delete(command.payload.placementPreviewId);
        if (command?.type === 'CancelFixed' && command.payload) unlocks.delete(command.payload.unlockId);
        if (command?.type === 'CommitPlacement') {
          // Any submission result ends the fixed authorization, including storage failure.
          for (const [key, unlock] of unlocks) if (sameValue(unlock.token, command.expected)) unlocks.delete(key);
        }
      }
    }
  };
}
