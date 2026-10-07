import type { Fact, Instance, Plan, VersionRef } from '../workspace/index.ts';
import type { HandCard, ReferencePlacement } from '../workspace/v06.ts';
import { assertInstant, compareInstants } from '../daily/time.ts';
import { fail, ref, uniqueEntity } from './rule-checks.ts';

/** Authoritative read snapshot supplied by the future Host, never client eligibility flags. */
export type MaterialContext = Readonly<{
  materials: readonly HandCard[];
  instances: readonly Instance[];
  plans: readonly Plan[];
  facts: readonly Fact[];
  references: readonly ReferencePlacement[];
}>;
export function nextVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1 || version === Number.MAX_SAFE_INTEGER)
    fail('INVALID_INPUT', 'version', '版本无效或已不能递增');
  return version + 1;
}
export function readMaterial(context: MaterialContext, expected: VersionRef): HandCard {
  ref(expected, 'material');
  const material = uniqueEntity(context.materials, expected.id, 'material');
  if (material.version !== expected.version)
    fail('ENTRY_STALE', 'material.version', '本次牌已变化，请重新预览');
  return material;
}
export function assertAvailable(material: HandCard, at: string): void {
  ref(material, 'material');
  assertInstant(at);
  assertInstant(material.createdAt);
  if (compareInstants(material.createdAt, at) > 0)
    fail('INVALID_INPUT', 'at', '不能在本次牌创建前使用');
  if (material.state === 'consumed' || material.consumedBy !== null)
    fail('MATERIAL_CONSUMED', 'material', '本次素材已被消费');
  if (
    material.state === 'expired' ||
    (material.expiresAt !== null && compareInstants(at, material.expiresAt) >= 0)
  )
    fail('MATERIAL_EXPIRED', 'material', '本次素材已到期');
  if (material.state !== 'available') fail('ENTRY_UNAVAILABLE', 'material', '本次素材已收回');
}
export function assertNoFact(context: MaterialContext, instanceId: string): void {
  if (context.facts.some((f) => f.instanceId === instanceId))
    fail('FACT_LOCKED', 'instance', '已确认事实不能再参与合成或收回参考');
}
export function assertUnplaced(context: MaterialContext, material: HandCard): void {
  if (material.kind === 'action' || material.kind === 'composite') {
    if (material.actionInstanceId !== null) {
      assertNoFact(context, material.actionInstanceId);
      const instance = uniqueEntity(
        context.instances,
        material.actionInstanceId,
        'actionInstanceId',
      );
      if (instance.state !== 'open') fail('ENTRY_UNAVAILABLE', 'instance', '行动实例已收回');
      if (context.plans.some((p) => p.instanceId === instance.id && p.status === 'active'))
        fail('MATERIAL_PLACED', 'material', '行动已经安排，请先在 Today 撤回');
    }
  } else if (material.kind === 'answer') {
    const placements = context.references.filter(
      (r) => r.answerId === material.id && r.state === 'active',
    );
    for (const placement of placements)
      if (placement.mode === 'attached') assertNoFact(context, placement.targetInstanceId);
    if (placements.length) fail('MATERIAL_PLACED', 'material', '答案已贴附或独立摆放，请先收回');
  }
}
