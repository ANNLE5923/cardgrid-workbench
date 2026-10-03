import type {
  ActualDraft, ActualPreview, Blocker, Candidate, Command, DayView, Failure,
  PlacementPreview, PlacementQuery, PrototypeHarness, PrototypeHost,
  Range, Result, Segment, SubmitResult, Token,
} from '../../../../产品设计/1C-prototype-contract.ts';
import { asFactView, createFixture, type Fixture, type ScenarioId } from './fixtures.ts';
import { addDate, at, dayRange, freeRanges, labelAt, localParts, offsetLabel, offsetTransition, overlap, range, resolveLocal, validDate } from './time.ts';

const fail = (code: Failure['code'], message: string, retry: Failure['retry'] = 'edit', extra: Partial<Failure> = {}): Failure => ({ ok: false, code, message, retry, ...extra });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const clone = <T>(value: T): T => structuredClone(value);
const minute = 60000;
type PlacementCache = { kind: 'placement'; value: PlacementPreview };
type ActualCache = { kind: 'actual'; value: ActualPreview };

class MemoryHost implements PrototypeHost, PrototypeHarness {
  readonly host: PrototypeHost = this;
  private fixture: Fixture;
  private revision = 0;
  private epoch = 0;
  private serial = 0;
  private now: string;
  private previews = new Map<string, PlacementCache | ActualCache>();
  private unlocks = new Map<string, { id: string; version: number; token: Token }>();
  private receipts = new Map<string, { fingerprint: string; refs: string[] }>();
  private subscribers = new Set<(token: Token) => void>();
  private nextFailure: 'STORAGE_FAILED' | null = null;

  constructor(id: ScenarioId) { this.fixture = createFixture(id); this.now = this.fixture.now; }
  get token(): Token { return { epoch: `synthetic-${this.epoch}`, revision: this.revision }; }
  get scenario(): Fixture { return clone(this.fixture); }
  get clock(): string { return this.now; }
  private id(prefix: string): string { return `${prefix}-${++this.serial}`; }
  private fresh(token: Token): boolean { return token.epoch === this.token.epoch && token.revision === this.token.revision; }
  private notify() { const token = this.token; this.subscribers.forEach(fn => fn(token)); }
  private invalidate() { this.previews.clear(); this.unlocks.clear(); this.notify(); }
  loadScenario(id: ScenarioId): void { this.fixture = createFixture(id); this.now = this.fixture.now; this.epoch++; this.revision = 0; this.serial = 0; this.receipts.clear(); this.invalidate(); }
  setNow(now: string): void { if (!Number.isFinite(Date.parse(now))) throw Error('无效模拟时钟'); this.now = now; this.notify(); }
  failNextSubmit(): void { this.nextFailure = 'STORAGE_FAILED'; }
  simulateExternalWrite(): void { this.revision++; this.invalidate(); }
  subscribe(fn: (token: Token) => void): () => void { this.subscribers.add(fn); return () => this.subscribers.delete(fn); }
  cancelPreview(previewId: string): void { this.previews.delete(previewId); }

  private occupancy(exclude?: { kind: 'plan' | 'fixed'; id: string }): { id: string; kind: Blocker['kind']; title: string; range: Range }[] {
    return [
      ...this.fixture.fixed.filter(x => !(exclude?.kind === 'fixed' && exclude.id === x.id)).map(x => ({ id: x.id, kind: 'fixed' as const, title: x.title, range: x.range })),
      ...this.fixture.plans.filter(x => !(exclude?.kind === 'plan' && exclude.id === x.id)).map(x => ({ id: x.id, kind: 'plan' as const, title: x.title, range: x.range })),
      ...this.fixture.facts.map(x => ({ id: x.id, kind: 'fact' as const, title: x.title, range: x.range })),
    ];
  }
  private blockers(wanted: Range, exclude?: { kind: 'plan' | 'fixed'; id: string }): Blocker[] {
    return this.occupancy(exclude).flatMap(x => {
      const common = overlap(wanted, x.range);
      return common ? [{ ...x, overlap: common }] : [];
    });
  }
  private project(source: Range, date: string, kind: Segment['kind'], sourceId: string | null, title: string): Segment[] {
    const bounds = dayRange(date, source.zone);
    const visible = overlap(source, bounds);
    if (!visible) return [];
    const segments: Segment[] = [];
    const visibleEnd = Date.parse(visible.endAt);
    let cursor = Date.parse(visible.startAt);
    while (cursor < visibleEnd) {
      const p = localParts(cursor, source.zone);
      const half = p.hour < 12 ? 0 as const : 1 as const;
      const halfEnd = half === 0 ? Date.parse(at(date, '12:00', source.zone)) : Date.parse(dayRange(date, source.zone).endAt);
      const change = offsetTransition(cursor, Math.min(visibleEnd, halfEnd), source.zone);
      const end = Math.min(visibleEnd, halfEnd, change ?? Infinity);
      if (end <= cursor) throw Error('显示分片未向前推进');
      const startMinuteOfHalf = (p.hour % 12) * 60 + p.minute;
      const endMinuteOfHalf = startMinuteOfHalf + (end - cursor) / minute;
      const piece = range(new Date(cursor).toISOString(), new Date(end).toISOString(), source.zone);
      const startDate = localParts(source.startAt, source.zone).date;
      const continuesBefore = piece.startAt === bounds.startAt && source.startAt < bounds.startAt;
      const continuesAfter = piece.endAt === bounds.endAt && source.endAt > bounds.endAt;
      segments.push({ id: `${sourceId ?? 'empty'}-${kind}-${cursor}`, sourceId, kind, title,
        sourceRange: source, clippedRange: piece, startDate, half,
        startMinuteOfHalf, endMinuteOfHalf, continuesBefore, continuesAfter,
        label: `${startDate < date ? `开始于 ${startDate} · ` : ''}${title} ${labelAt(piece.startAt, source.zone)}–${labelAt(piece.endAt, source.zone, localParts(piece.endAt, source.zone).date !== date)}${continuesAfter ? ' · 续次日 →' : ''}`,
        offsetLabel: offsetLabel(piece.startAt, source.zone), locked: kind === 'fixed' || kind === 'fact' || kind === 'plan-reference' });
      cursor = end;
    }
    return segments;
  }
  readDay(input: { date: string; zone: string }): Result<DayView> {
    try {
      if (!validDate(input.date) || !input.zone) return fail('INVALID_INPUT', '日期或时区无效');
      const bounds = dayRange(input.date, input.zone);
      const occupied = this.occupancy();
      const free = freeRanges(bounds, occupied.map(x => x.range));
      const ended = Date.parse(this.now) >= Date.parse(bounds.endAt);
      const segments = [
        ...this.fixture.fixed.flatMap(x => this.project(x.range, input.date, 'fixed', x.id, x.title)),
        ...this.fixture.plans.flatMap(x => this.project(x.range, input.date, 'plan', x.id, x.title)),
        ...this.fixture.facts.flatMap(x => [
          ...this.project(x.range, input.date, 'fact', x.id, x.title),
          ...(x.plannedRange ? this.project(x.plannedRange, input.date, 'plan-reference', x.id, `${x.title} · 原计划`) : []),
        ]),
        ...(ended ? free.flatMap(x => this.project(x, input.date, 'empty', null, '空时间')) : []),
      ];
      const scheduled = new Set(this.fixture.plans.map(x => x.instanceId));
      const done = new Set(this.fixture.facts.map(x => x.instanceId));
      return ok(clone({ token: this.token, date: input.date, zone: input.zone, now: this.now,
        dayRange: bounds, hand: this.fixture.cards.filter(x => !scheduled.has(x.instanceId) && !done.has(x.instanceId)),
        segments, facts: this.fixture.facts.filter(x => overlap(x.range, bounds)).map(asFactView), freeRanges: free,
        plans: this.fixture.plans.filter(x => overlap(x.range, bounds)).map(x => {
          const instance = this.fixture.cards.find(card => card.instanceId === x.instanceId);
          if (!instance) throw Error('计划缺少对应行动实例');
          return { planId: x.id, version: x.version, instanceId: x.instanceId, instanceVersion: instance.version, range: x.range };
        }),
        fixed: this.fixture.fixed.filter(x => overlap(x.range, bounds)).map(x => ({ commitmentId: x.id, version: x.version, range: x.range })),
        policies: { status: 'user-decided', actualPrecision: 'minute', allowFutureActualEnd: true,
          confirmedOccupancy: 'actual-only', dayEnd: 'automatic-recompute', placementOverlap: 'explicit-acknowledgement' } } as DayView));
    } catch (error) { return fail('INVALID_INPUT', (error as Error).message); }
  }
  previewPlacement(query: PlacementQuery): Result<PlacementPreview> {
    if (!this.fresh(query.token)) return fail('REVISION_CONFLICT', '合成工作区已变化，请重新预览', 'reload');
    if (!validDate(query.date) || !query.zone || !Number.isInteger(query.focusMinuteOfDay) || query.focusMinuteOfDay < 0 || query.focusMinuteOfDay > 1435 || query.focusMinuteOfDay % 5) return fail('INVALID_GRID', '起点须在 00:00–23:55 的 5 分钟网格上');
    const { subject } = query;
    let duration = 0, exclude: { kind: 'plan' | 'fixed'; id: string } | undefined;
    if (subject.kind === 'hand') {
      const card = this.fixture.cards.find(x => x.instanceId === subject.instanceId);
      if (!card || card.version !== subject.version) return fail('INVALID_INPUT', '手牌已改变', 'reload');
      if (this.fixture.facts.some(x => x.instanceId === card.instanceId)) return fail('FACT_LOCKED', '已确认的卡不能打出', 'none');
      if (this.fixture.plans.some(x => x.instanceId === card.instanceId)) return fail('ALREADY_PLANNED', '这张卡已经安排', 'reload');
      duration = card.presetMinutes ?? 0;
    } else if (subject.kind === 'plan') {
      const plan = this.fixture.plans.find(x => x.id === subject.planId && x.version === subject.version);
      if (!plan) return fail('INVALID_INPUT', '计划已改变', 'reload');
      duration = (Date.parse(plan.range.endAt) - Date.parse(plan.range.startAt)) / minute;
      exclude = { kind: 'plan', id: plan.id };
    } else {
      const fixed = this.fixture.fixed.find(x => x.id === subject.commitmentId && x.version === subject.version);
      const unlock = this.unlocks.get(subject.unlockId);
      if (!fixed || !unlock || unlock.id !== fixed.id || unlock.version !== fixed.version || !this.fresh(unlock.token)) return fail('FIXED_LOCKED', '需要重新解锁这项固定安排', 'preview');
      duration = (Date.parse(fixed.range.endAt) - Date.parse(fixed.range.startAt)) / minute;
      exclude = { kind: 'fixed', id: fixed.id };
    }
    if (!duration || duration % 5) return fail('DURATION_REQUIRED', '请先提供合法的 5 分钟倍数时长');
    try {
      const previewId = this.id('placement');
      const candidates: Candidate[] = [], unresolved: PlacementPreview['unresolved'][number][] = [];
      {
        const minuteOfDay = query.focusMinuteOfDay;
        const half: 0 | 1 = minuteOfDay < 720 ? 0 : 1;
        const localTime = `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;
        const starts = resolveLocal({ date: query.date, time: localTime, zone: query.zone });
        if (!starts.length) unresolved.push({ half, code: 'NONEXISTENT_LOCAL_TIME', message: `${localTime} 在当地不存在` });
        if (starts.length > 1) unresolved.push({ half, code: 'AMBIGUOUS_LOCAL_TIME', message: `${localTime} 有 ${starts.length} 个偏移，请从列表明确选择` });
        starts.forEach((start, index) => {
          const wanted = range(start, new Date(Date.parse(start) + duration * minute).toISOString(), query.zone);
          const blockers = this.blockers(wanted, exclude);
          const item = { id: `${previewId}-${half}-${index}`, half, range: wanted,
            label: `${labelAt(start, query.zone, true)}–${labelAt(wanted.endAt, query.zone, true)}`,
            offsetLabel: offsetLabel(start, query.zone), units: duration / 5,
            segments: [...this.project(wanted, query.date, 'plan', subject.kind === 'hand' ? subject.instanceId : subject.kind === 'plan' ? subject.planId : subject.commitmentId, '候选'),
              ...this.project(wanted, addDate(query.date, 1), 'plan', subject.kind === 'hand' ? subject.instanceId : subject.kind === 'plan' ? subject.planId : subject.commitmentId, '候选')],
          };
          candidates.push(blockers.length ? { ...item, state: 'conflict', blockers, reason: `与 ${blockers.map(x => x.title).join('、')} 重叠`, acknowledgementId: `${item.id}-ack` } : { ...item, state: 'valid' });
        });
      }
      const preview: PlacementPreview = { previewId, token: this.token, query: clone(query), candidates, unresolved };
      this.previews.set(previewId, { kind: 'placement', value: preview });
      return ok(clone(preview));
    } catch (error) { return fail('INVALID_INPUT', (error as Error).message); }
  }
  previewActual(input: { token: Token; draft: ActualDraft }): Result<ActualPreview> {
    if (!this.fresh(input.token)) return fail('REVISION_CONFLICT', '合成工作区已变化，请重新预览', 'reload');
    const { draft } = input;
    if (this.fixture.facts.some(x => x.instanceId === draft.instanceId)) return fail('ALREADY_CONFIRMED', '这项行动已有锁定事实', 'none', { existingFactId: this.fixture.facts.find(x => x.instanceId === draft.instanceId)?.id });
    const plan = this.fixture.plans.find(x => x.instanceId === draft.instanceId);
    if (draft.mode === 'planned' ? !plan || plan.id !== draft.planId || plan.version !== draft.planVersion : !!plan) return fail('INVALID_INPUT', '确认模式与当前计划不匹配', 'reload');
    const card = this.fixture.cards.find(x => x.instanceId === draft.instanceId);
    if (card && card.version !== draft.instanceVersion) return fail('REVISION_CONFLICT', '卡片内容已改变', 'reload');
    if (!card && !plan) return fail('INVALID_INPUT', '找不到这张卡');
    try {
      const start = resolveLocal(draft.start), end = resolveLocal(draft.end);
      if (start.length !== 1) return fail(start.length ? 'AMBIGUOUS_LOCAL_TIME' : 'NONEXISTENT_LOCAL_TIME', '实际开始时间需明确', 'edit', { choices: start.map(instant => ({ instant, input: { ...draft.start, offset: offsetLabel(instant, draft.start.zone) } })) });
      if (end.length !== 1) return fail(end.length ? 'AMBIGUOUS_LOCAL_TIME' : 'NONEXISTENT_LOCAL_TIME', '实际结束时间需明确', 'edit', { choices: end.map(instant => ({ instant, input: { ...draft.end, offset: offsetLabel(instant, draft.end.zone) } })) });
      const actual = range(start[0], end[0], draft.start.zone);
      const conflicts = this.blockers(actual, plan ? { kind: 'plan', id: plan.id } : undefined);
      const previewId = this.id('actual');
      const preview: ActualPreview = { previewId, token: this.token, draft: clone(draft), range: actual,
        title: card?.title ?? plan?.title ?? '', criteria: card?.criteria ?? '合成完成标准',
        plannedRange: plan?.range ?? null, conflicts, acknowledgementId: conflicts.length ? `${previewId}-ack` : null };
      this.previews.set(previewId, { kind: 'actual', value: preview });
      return ok(clone(preview));
    } catch (error) { return fail('INVALID_INPUT', (error as Error).message); }
  }
  unlockFixed(input: { token: Token; commitmentId: string; version: number }): Result<string> {
    if (!this.fresh(input.token)) return fail('REVISION_CONFLICT', '版本已变化', 'reload');
    const fixed = this.fixture.fixed.find(x => x.id === input.commitmentId && x.version === input.version);
    if (!fixed) return fail('FIXED_LOCKED', '固定安排不存在或版本过期');
    const id = this.id('unlock'); this.unlocks.set(id, { id: fixed.id, version: fixed.version, token: clone(input.token) });
    return ok(id);
  }
  async submit(command: Command): Promise<SubmitResult> {
    const fingerprint = JSON.stringify({ type: command.type, payload: command.payload });
    if (command.expected.epoch !== this.token.epoch) return fail('WORKSPACE_REPLACED', '已载入另一合成场景，请重新操作', 'reload');
    const receipt = this.receipts.get(command.commandId);
    if (receipt) return receipt.fingerprint === fingerprint
      ? ok({ token: this.token, resultRefs: receipt.refs, replayed: true })
      : fail('COMMAND_ID_REUSED', '命令编号已被其他操作使用', 'none');
    if (!this.fresh(command.expected)) return fail('REVISION_CONFLICT', '预览后版本已变化，请重新预览', 'reload');
    if (this.nextFailure) { this.nextFailure = null; return fail('STORAGE_FAILED', '模拟保存失败：输入与原安排保留', 'same-command'); }
    let refs: string[] = [];
    if (command.type === 'CommitPlacement') {
      const cache = this.previews.get(command.payload.previewId);
      if (!cache || cache.kind !== 'placement') return fail('PREVIEW_STALE', '落点预览已失效', 'preview');
      const candidate = cache.value.candidates.find(x => x.id === command.payload.candidateId);
      if (!candidate) return fail('INVALID_INPUT', '请明确选择一个候选落点');
      const query = cache.value.query;
      const freshPreview = this.previewPlacement(query);
      if (!freshPreview.ok) return freshPreview;
      const equivalent = freshPreview.value.candidates.find(x => x.half === candidate.half && x.range.startAt === candidate.range.startAt);
      if (!equivalent || equivalent.state !== candidate.state) return fail('PREVIEW_STALE', '落点情况已变化，请重新预览', 'preview');
      if (candidate.state === 'conflict') {
        if (equivalent.state !== 'conflict' || JSON.stringify(equivalent.blockers.map(x => [x.id, x.overlap])) !== JSON.stringify(candidate.blockers.map(x => [x.id, x.overlap]))) return fail('PREVIEW_STALE', '重叠对象已变化，请重新预览', 'preview');
        if (command.payload.acknowledgedOverlap !== candidate.acknowledgementId) return fail('OVERLAP_CONFIRMATION_REQUIRED', '请明确确认列出的重叠安排', 'preview', { conflicts: candidate.blockers });
      }
      if (query.subject.kind === 'hand') {
        const subject = query.subject;
        const card = this.fixture.cards.find(x => x.instanceId === subject.instanceId);
        if (!card || card.version !== query.subject.version) return fail('REVISION_CONFLICT', '卡片已改变', 'reload');
        const id = this.id('plan'); this.fixture.plans.push({ id, instanceId: card.instanceId, title: card.title, range: candidate.range, version: 1 }); refs = [id];
      } else if (query.subject.kind === 'plan') {
        const subject = query.subject;
        const plan = this.fixture.plans.find(x => x.id === subject.planId && x.version === subject.version);
        if (!plan) return fail('REVISION_CONFLICT', '计划已改变', 'reload');
        plan.range = candidate.range; plan.version++; refs = [plan.id];
      } else {
        const subject = query.subject;
        const fixed = this.fixture.fixed.find(x => x.id === subject.commitmentId && x.version === subject.version);
        if (!fixed || !this.unlocks.has(subject.unlockId)) return fail('FIXED_LOCKED', '固定安排需要重新解锁', 'preview');
        fixed.range = candidate.range; fixed.version++; refs = [fixed.id]; this.unlocks.delete(subject.unlockId);
      }
    } else if (command.type === 'RetractPlan') {
      const index = this.fixture.plans.findIndex(x => x.id === command.payload.planId && x.version === command.payload.version);
      if (index < 0) return fail('REVISION_CONFLICT', '计划已改变', 'reload');
      refs = [this.fixture.plans[index].id]; this.fixture.plans.splice(index, 1);
    } else if (command.type === 'ReorderHand') {
      const current = this.fixture.cards.filter(x => !this.fixture.plans.some(p => p.instanceId === x.instanceId) && !this.fixture.facts.some(f => f.instanceId === x.instanceId)).map(x => x.instanceId);
      if (new Set(command.payload.instanceIds).size !== current.length || current.some(x => !command.payload.instanceIds.includes(x))) return fail('INVALID_INPUT', '排序必须包含全部当前手牌', 'reload');
      const rank = new Map(command.payload.instanceIds.map((x, i) => [x, i]));
      this.fixture.cards.sort((a, b) => (rank.get(a.instanceId) ?? 1000) - (rank.get(b.instanceId) ?? 1000)); refs = [...command.payload.instanceIds];
    } else if (command.type === 'ConfirmActual') {
      const cache = this.previews.get(command.payload.previewId);
      if (!cache || cache.kind !== 'actual') return fail('PREVIEW_STALE', '实际时间预览已失效', 'preview');
      const p = cache.value;
      const refreshed = this.previewActual({ token: p.token, draft: p.draft });
      if (!refreshed.ok) return refreshed;
      if (JSON.stringify(refreshed.value.conflicts.map(x => [x.id, x.overlap])) !== JSON.stringify(p.conflicts.map(x => [x.id, x.overlap]))) return fail('PREVIEW_STALE', '重叠情况已变化，请重新确认', 'preview');
      if (p.acknowledgementId !== command.payload.acknowledgedOverlap) return fail('OVERLAP_CONFIRMATION_REQUIRED', '请再次确认列出的重叠安排', 'preview', { conflicts: p.conflicts });
      const id = this.id('fact');
      this.fixture.facts.push({ id, instanceId: p.draft.instanceId, title: p.title, criteria: p.criteria,
        range: p.range, plannedRange: p.plannedRange, confirmedAt: this.now, annotations: [] });
      if (p.draft.mode === 'planned') {
        const planId = p.draft.planId;
        this.fixture.plans = this.fixture.plans.filter(x => x.id !== planId);
      }
      refs = [id];
    } else if (command.type === 'AppendAnnotation') {
      const f = this.fixture.facts.find(x => x.id === command.payload.factId);
      if (!f || !command.payload.text.trim()) return fail('INVALID_INPUT', '请选择事实并填写说明');
      const id = this.id('annotation'); f.annotations.push({ id, text: command.payload.text.trim(), createdAt: this.now }); refs = [id];
    }
    this.revision++;
    this.receipts.set(command.commandId, { fingerprint, refs });
    this.invalidate();
    return ok({ token: this.token, resultRefs: refs, replayed: false });
  }
}

export function createPrototype(id: ScenarioId = 'S01'): PrototypeHarness & { readonly scenario: Fixture; readonly token: Token; readonly clock: string } {
  return new MemoryHost(id);
}
