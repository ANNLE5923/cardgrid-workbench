import type { RecordedRange, VersionRef } from '../workspace/index.ts';
import type {
  AnswerSnapshot,
  FactReferenceSnapshot,
  ReferenceDraft,
  ReferencePlacement,
  RecordedPoint,
} from '../workspace/v06.ts';
import {
  assertInstant,
  assertRecordedRange,
  compareInstants,
  resolveLocal,
} from '../daily/time.ts';
import { assertSameActionOwner } from './materials.ts';
import {
  assertAvailable,
  assertNoFact,
  assertUnplaced,
  nextVersion,
  readMaterial,
  type MaterialContext,
} from './material-state.ts';
import { fail, id, ref, uniqueEntity, validateAnswer } from './rule-checks.ts';

function targetMaterial(context: MaterialContext, instance: VersionRef, at: string) {
  ref(instance, 'instance');
  const target = uniqueEntity(context.instances, instance.id, 'instance');
  if (target.version !== instance.version)
    fail('ENTRY_STALE', 'instance.version', '目标行动已变化');
  assertNoFact(context, target.id);
  if (target.state !== 'open') fail('ENTRY_UNAVAILABLE', 'instance', '目标行动已收回');
  const materials = context.materials.filter(
    (c) => (c.kind === 'action' || c.kind === 'composite') && c.actionInstanceId === target.id,
  );
  if (materials.length !== 1)
    fail(
      'ACTION_OWNER_MISMATCH',
      'instance',
      '目标行动缺少唯一、明确的来源映射，不能猜测旧手牌归属',
    );
  const material = materials[0];
  if (material.kind !== 'action' && material.kind !== 'composite')
    fail('INVALID_INPUT', 'instance', '目标必须是行动');
  assertAvailable(material, at);
  return material;
}
export type ReferencePlacementDraft = Readonly<{
  draft: ReferenceDraft;
  placement: ReferencePlacement;
  point: RecordedPoint | null;
  occupiedMinutes: 0;
}>;
export function previewReferencePlacement(
  input: Readonly<{
    context: MaterialContext;
    draft: ReferenceDraft;
    referenceId: string;
    at: string;
  }>,
): ReferencePlacementDraft {
  const material = readMaterial(input.context, input.draft.answer);
  if (material.kind !== 'answer') fail('INVALID_INPUT', 'answer', '只有答案能作为参考');
  assertAvailable(material, input.at);
  assertUnplaced(input.context, material);
  validateAnswer(material.answer);
  id(input.referenceId, 'referenceId');
  if (input.context.references.some((r) => r.id === input.referenceId))
    fail('INVALID_INPUT', 'referenceId', '参考位置需要新的 ID');
  const base = {
    id: input.referenceId,
    version: 1,
    answerId: material.id,
    createdAt: input.at,
    changedAt: input.at,
    state: 'active' as const,
  };
  if (input.draft.mode === 'attached') {
    const draft = input.draft;
    const target = targetMaterial(input.context, draft.instance, input.at);
    assertSameActionOwner(target.ownerAction, material.answer.ownerAction);
    const plans = input.context.plans.filter(
      (p) => p.instanceId === draft.instance.id && p.status === 'active',
    );
    if (plans.length !== 1)
      fail('ENTRY_UNAVAILABLE', 'instance', '贴附参考需要目标行动的唯一活动安排');
    assertRecordedRange(plans[0].range);
    if (
      material.expiresAt !== null &&
      compareInstants(plans[0].range.startAt, material.expiresAt) >= 0
    )
      fail('MATERIAL_EXPIRED', 'instance', '目标安排已在答案到期时刻及之后');
    return {
      draft: structuredClone(draft),
      placement: { ...base, mode: 'attached', targetInstanceId: draft.instance.id },
      point: null,
      occupiedMinutes: 0,
    };
  }
  if (input.draft.mode !== 'point') fail('INVALID_INPUT', 'draft.mode', '参考只能贴附或放为时间点');
  const local = input.draft.local,
    resolved = resolveLocal(local);
  if (Number(local.time.slice(3)) % 5) fail('INVALID_GRID', 'time', '参考时间点须落在 5 分钟网格');
  const point: RecordedPoint = {
    at: resolved.instant,
    zone: local.zone,
    localTime: `${local.date}T${local.time}`,
    offset: resolved.offset,
  };
  if (material.expiresAt !== null && compareInstants(point.at, material.expiresAt) >= 0)
    fail('MATERIAL_EXPIRED', 'point', '不能把答案放在到期时刻及之后');
  return {
    draft: structuredClone(input.draft),
    placement: { ...base, mode: 'point', point },
    point: structuredClone(point),
    occupiedMinutes: 0,
  };
}
/** Attached positions follow the current Plan; references never contribute another occupied range. */
export function projectReferences(context: MaterialContext): readonly Readonly<{
  reference: ReferencePlacement;
  range: RecordedRange | null;
  point: RecordedPoint | null;
  occupiedMinutes: 0;
}>[] {
  return context.references
    .filter(
      (r) =>
        r.state === 'active' &&
        !(r.mode === 'attached' && context.facts.some((f) => f.instanceId === r.targetInstanceId)),
    )
    .map((reference) => {
      uniqueEntity(context.references, reference.id, 'reference');
      if (reference.mode === 'point')
        return {
          reference: structuredClone(reference),
          range: null,
          point: structuredClone(reference.point),
          occupiedMinutes: 0,
        };
      const plans = context.plans.filter(
        (p) => p.instanceId === reference.targetInstanceId && p.status === 'active',
      );
      if (plans.length !== 1)
        fail('INVALID_INPUT', 'reference', '贴附参考必须跟随唯一活动计划，事实参考由独立快照展示');
      assertRecordedRange(plans[0].range);
      return {
        reference: structuredClone(reference),
        range: structuredClone(plans[0].range),
        point: null,
        occupiedMinutes: 0,
      };
    });
}
export type ReferenceReturnDraft = Readonly<{
  references: readonly ReferencePlacement[];
  returnedAnswerIds: readonly string[];
  expiredAnswerIds: readonly string[];
}>;
function returnDraft(
  context: MaterialContext,
  references: readonly ReferencePlacement[],
  at: string,
): ReferenceReturnDraft {
  assertInstant(at);
  const returnedAnswerIds: string[] = [],
    expiredAnswerIds: string[] = [];
  const updated = references.map((reference) => {
    uniqueEntity(context.references, reference.id, 'reference');
    ref(reference, 'reference');
    if (reference.state !== 'active') fail('ENTRY_UNAVAILABLE', 'reference', '参考已经收回或到期');
    if (reference.mode === 'attached') assertNoFact(context, reference.targetInstanceId);
    if (compareInstants(at, reference.changedAt) < 0)
      fail('INVALID_INPUT', 'at', '不能倒写参考变更时间');
    const material = uniqueEntity(context.materials, reference.answerId, 'answerId');
    if (material.kind !== 'answer') fail('INVALID_INPUT', 'answerId', '参考来源必须是答案');
    if (
      context.references.some(
        (r) => r.id !== reference.id && r.answerId === material.id && r.state === 'active',
      )
    )
      fail('INVALID_INPUT', 'reference', '同一答案不能有多个活动位置');
    if (material.state === 'consumed' || material.consumedBy !== null)
      fail('MATERIAL_CONSUMED', 'answer', '收回参考不能复活已消费素材');
    if (material.state === 'withdrawn')
      fail('ENTRY_UNAVAILABLE', 'answer', '收回参考不能复活已收回素材');
    const expired =
      material.state === 'expired' ||
      (material.expiresAt !== null && compareInstants(at, material.expiresAt) >= 0);
    (expired ? expiredAnswerIds : returnedAnswerIds).push(material.id);
    return {
      ...structuredClone(reference),
      version: nextVersion(reference.version),
      changedAt: at,
      state: expired ? ('expired' as const) : ('returned' as const),
    };
  });
  return { references: updated, returnedAnswerIds, expiredAnswerIds };
}
export function prepareReferenceReturn(
  input: Readonly<{ context: MaterialContext; reference: VersionRef; at: string }>,
): ReferenceReturnDraft {
  ref(input.reference, 'reference');
  const reference = uniqueEntity(input.context.references, input.reference.id, 'reference');
  if (reference.version !== input.reference.version)
    fail('ENTRY_STALE', 'reference.version', '参考位置已变化');
  return returnDraft(input.context, [reference], input.at);
}
export function prepareAttachedReferenceReturn(
  input: Readonly<{ context: MaterialContext; instance: VersionRef; at: string }>,
): ReferenceReturnDraft {
  ref(input.instance, 'instance');
  const instance = uniqueEntity(input.context.instances, input.instance.id, 'instance');
  if (instance.version !== input.instance.version)
    fail('ENTRY_STALE', 'instance.version', '行动实例已变化');
  assertNoFact(input.context, instance.id);
  return returnDraft(
    input.context,
    input.context.references.filter(
      (r) => r.mode === 'attached' && r.targetInstanceId === instance.id && r.state === 'active',
    ),
    input.at,
  );
}
/** Called BEFORE new ConfirmActual is persisted, alongside Fact in its future atomic transaction. */
export function snapshotAttachedAnswers(
  input: Readonly<{ context: MaterialContext; instance: VersionRef; factId: string; at: string }>,
): FactReferenceSnapshot | null {
  id(input.factId, 'factId');
  if (input.context.facts.some((f) => f.id === input.factId))
    fail('FACT_LOCKED', 'factId', '不能覆盖或补造旧事实参考');
  ref(input.instance, 'instance');
  const instance = uniqueEntity(input.context.instances, input.instance.id, 'instance');
  if (instance.version !== input.instance.version)
    fail('ENTRY_STALE', 'instance.version', '行动实例已变化');
  assertNoFact(input.context, instance.id);
  const references = input.context.references.filter(
    (r) =>
      r.mode === 'attached' && r.targetInstanceId === input.instance.id && r.state === 'active',
  );
  if (!references.length) return null; // Legacy actions without a proven owner remain usable.
  const target = targetMaterial(input.context, input.instance, input.at);
  const seen = new Set<string>(),
    answers: AnswerSnapshot[] = [];
  for (const reference of references) {
    uniqueEntity(input.context.references, reference.id, 'reference');
    if (seen.has(reference.answerId))
      fail('INVALID_INPUT', 'references', '同一答案不能重复进入事实');
    seen.add(reference.answerId);
    const material = uniqueEntity(input.context.materials, reference.answerId, 'answerId');
    if (material.kind !== 'answer') fail('INVALID_INPUT', 'answerId', '参考来源必须是答案');
    assertAvailable(material, input.at);
    validateAnswer(material.answer);
    assertSameActionOwner(target.ownerAction, material.answer.ownerAction);
    answers.push(structuredClone(material.answer));
  }
  return answers.length ? { factId: input.factId, answers } : null;
}
