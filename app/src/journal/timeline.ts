import type { DayView, JournalEntry, RecordedRange, Template, Token } from '../workspace/index.ts';
import type {
  AnswerSnapshot,
  FactReferenceSnapshot,
  HandCard,
  JournalAutoSegment,
  JournalNote,
  JournalTimeline,
  ReferencePlacement,
  RecordedPoint,
} from '../workspace/v06.ts';
import { V06ContractError, validateV06Dto } from '../workspace/v06.ts';
import {
  compareInstants,
  dateAt,
  dayRange,
  intersectRanges,
  recordRange,
  resolveLocal,
} from '../daily/time.ts';
import { toLegacyJournalBlock } from './records.ts';

export type JournalRow =
  | Readonly<{ kind: 'automatic'; at: string; id: string; segment: JournalAutoSegment }>
  | Readonly<{ kind: 'reflection'; at: string; id: string; note: JournalNote }>
  | Readonly<{
      kind: 'reference';
      at: string;
      id: string;
      point: RecordedPoint;
      answer: AnswerSnapshot;
    }>;
export type JournalProjection = Readonly<{
  token: Token;
  timeline: JournalTimeline;
  rows: readonly JournalRow[];
  plannedComparisons: readonly Readonly<{
    sourceKey: string;
    range: RecordedRange;
    clippedRange: RecordedRange;
    actualRange: RecordedRange;
  }>[];
}>;
export type JournalProjectionInput = Readonly<{
  day: DayView;
  templates: readonly Template[];
  notes: readonly JournalNote[];
  legacyEntries: readonly JournalEntry[];
  materials: readonly HandCard[];
  references: readonly ReferencePlacement[];
  factReferences: readonly FactReferenceSnapshot[];
}>;
function fail(field: string, message: string): never {
  throw new V06ContractError('INVALID_INPUT', field, message);
}
const key = (kind: string, ...parts: (string | number)[]) =>
  `${kind}:${parts.map((p) => encodeURIComponent(String(p))).join(':')}`;
const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function answerFor(input: JournalProjectionInput, id: string): AnswerSnapshot {
  const matches = input.materials.filter((m) => m.id === id);
  if (matches.length !== 1 || matches[0].kind !== 'answer')
    fail('answerId', '参考答案不存在或不唯一');
  const material = matches[0];
  if (material.state !== 'available' || material.consumedBy !== null)
    fail('reference', '活动参考不能指向已消费、到期或收回的材料');
  validateV06Dto('answer', material.answer);
  return structuredClone(material.answer);
}
/** Read the existing dial, merge its noon/DST display pieces into one source/day row. */
export function projectJournalTimeline(input: JournalProjectionInput): JournalProjection {
  const { day } = input,
    viewRange = dayRange(day.date, day.zone);
  const seenRefs = new Set<string>(),
    seenAnswers = new Set<string>();
  for (const reference of input.references.filter((r) => r.state === 'active')) {
    if (seenRefs.has(reference.id) || seenAnswers.has(reference.answerId))
      fail('references', '活动参考身份重复');
    seenRefs.add(reference.id);
    seenAnswers.add(reference.answerId);
  }
  const automatic: JournalAutoSegment[] = [],
    seenSources = new Map<string, string>();
  const comparisons: JournalProjection['plannedComparisons'][number][] = [];
  for (const piece of day.segments) {
    if (piece.kind === 'empty' || piece.kind === 'plan-reference') continue;
    if (piece.sourceId === null) fail('sourceId', '自动段必须有明确表盘来源');
    const range = recordRange(piece.sourceRange),
      clipped = intersectRanges(range, viewRange);
    if (!clipped) continue;
    let sourceKey: string,
      sourceKind: JournalAutoSegment['sourceKind'],
      status: JournalAutoSegment['status'],
      answers: readonly AnswerSnapshot[] = [];
    if (piece.kind === 'plan') {
      const matches = day.plans.filter((p) => p.planId === piece.sourceId);
      if (matches.length !== 1) fail('plans', '表盘计划来源不唯一');
      const plan = matches[0];
      if (day.facts.some((f) => f.instanceId === plan.instanceId)) continue;
      sourceKey = key('instance', plan.instanceId);
      sourceKind = 'plan';
      status = 'planned';
      answers = input.references
        .filter(
          (r) =>
            r.state === 'active' && r.mode === 'attached' && r.targetInstanceId === plan.instanceId,
        )
        .map((r) => answerFor(input, r.answerId));
    } else if (piece.kind === 'fact') {
      const matches = day.facts.filter((f) => f.factId === piece.sourceId);
      if (matches.length !== 1) fail('facts', '表盘事实来源不唯一');
      sourceKey = key('instance', matches[0].instanceId);
      sourceKind = 'fact';
      status = 'confirmed';
      const snapshots = input.factReferences.filter((s) => s.factId === piece.sourceId);
      if (snapshots.length > 1) fail('factReferences', '事实参考快照重复');
      answers = structuredClone(snapshots[0]?.answers ?? []);
      for (const answer of answers) validateV06Dto('answer', answer);
    } else {
      status = 'fixed';
      const fixed = day.fixed.filter((f) => f.commitmentId === piece.sourceId);
      if (fixed.length > 1) fail('fixed', '固定来源重复');
      if (fixed.length) {
        sourceKey = key('fixed', fixed[0].commitmentId);
        sourceKind = 'fixed';
      } else {
        const sourceDate = dateAt(range.startAt, range.zone);
        const candidates = input.templates.flatMap((template) =>
          template.entries
            .filter(
              (entry) =>
                `template-projection:${sourceDate}:${template.id}:${entry.id}` === piece.sourceId,
            )
            .map((entry) => ({ template, entry })),
        );
        if (candidates.length !== 1)
          fail('templates', '未保存模板来源不存在或有歧义，不能拆分名称猜测');
        const { template, entry } = candidates[0];
        sourceKey = key('template', template.id, template.version, sourceDate, entry.id);
        sourceKind = 'template';
      }
    }
    const sourceIdentity = JSON.stringify([sourceKind, piece.sourceId, range, piece.title]);
    if (seenSources.has(sourceKey)) {
      if (seenSources.get(sourceKey) !== sourceIdentity)
        fail('segments', '同一来源出现不一致的表盘快照');
      continue;
    }
    seenSources.set(sourceKey, sourceIdentity);
    automatic.push({
      id: JSON.stringify([sourceKey, day.date, day.zone]),
      sourceKey,
      sourceKind,
      title: piece.title,
      range,
      clippedRange: recordRange(clipped),
      status,
      referenceAnswers: answers,
    });
  }
  for (const fact of day.facts) {
    if (!fact.plannedRange) continue;
    const clipped = intersectRanges(fact.plannedRange, viewRange);
    if (!clipped) continue;
    comparisons.push({
      sourceKey: key('instance', fact.instanceId),
      range: recordRange(fact.plannedRange),
      clippedRange: recordRange(clipped),
      actualRange: recordRange(fact.actualRange),
    });
  }
  const notes = input.notes
    .filter((n) => n.date === day.date)
    .map((note) => {
      validateV06Dto('note', note);
      if (
        compareInstants(note.recordedAt, note.createdAt) !== 0 ||
        compareInstants(note.updatedAt, note.createdAt) < 0
      )
        fail('note', '感想原时间或修改时间无效');
      return structuredClone(note);
    });
  if (new Set(notes.map((n) => n.id)).size !== notes.length) fail('notes', '感想 ID 重复');
  const legacyBlocks = input.legacyEntries
    .filter((e) => e.date === day.date)
    .map(toLegacyJournalBlock);
  if (new Set(legacyBlocks.map((e) => e.id)).size !== legacyBlocks.length)
    fail('legacyEntries', '旧正文 ID 重复');
  automatic.sort(
    (a, b) =>
      compareInstants(a.range.startAt, b.range.startAt) || ordinal(a.sourceKey, b.sourceKey),
  );
  notes.sort((a, b) => compareInstants(a.recordedAt, b.recordedAt) || ordinal(a.id, b.id));
  legacyBlocks.sort((a, b) => ordinal(a.zone, b.zone) || ordinal(a.id, b.id));
  comparisons.sort(
    (a, b) =>
      compareInstants(a.range.startAt, b.range.startAt) || ordinal(a.sourceKey, b.sourceKey),
  );
  const rows: JournalRow[] = [
    ...automatic.map((segment) => ({
      kind: 'automatic' as const,
      at: segment.range.startAt,
      id: segment.id,
      segment,
    })),
    ...notes.map((note) => ({
      kind: 'reflection' as const,
      at: note.recordedAt,
      id: note.id,
      note,
    })),
  ];
  for (const reference of input.references) {
    if (reference.state !== 'active' || reference.mode !== 'point') continue;
    const point = reference.point;
    // Validate the stored local snapshot without interpreting the reference as an interval.
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(point.localTime) ||
      Number(point.localTime.slice(14)) % 5
    )
      fail('point', '参考点须为 5 分钟网格上的完整当地分钟');
    const local = resolveLocal({
      date: point.localTime.slice(0, 10),
      time: point.localTime.slice(11),
      zone: point.zone,
      offset: point.offset,
    });
    if (compareInstants(local.instant, point.at) !== 0) fail('point', '参考点当地时间快照无效');
    if (
      compareInstants(point.at, viewRange.startAt) >= 0 &&
      compareInstants(point.at, viewRange.endAt) < 0
    )
      rows.push({
        kind: 'reference',
        at: point.at,
        id: reference.id,
        point: structuredClone(point),
        answer: answerFor(input, reference.answerId),
      });
  }
  rows.sort(
    (a, b) => compareInstants(a.at, b.at) || ordinal(a.kind, b.kind) || ordinal(a.id, b.id),
  );
  return {
    token: structuredClone(day.token),
    timeline: { date: day.date, zone: day.zone, automatic, notes, legacyBlocks },
    rows,
    plannedComparisons: comparisons,
  };
}
