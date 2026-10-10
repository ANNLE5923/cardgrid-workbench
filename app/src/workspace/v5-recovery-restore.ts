import type { DataV5 } from './contracts-v06.ts';
import { backupV5, parseV06Restore, validateV5Fingerprints } from './v5-format.ts';
import { canonicalJson } from './format.ts';
import { ActionDomainError, sameValue } from '../daily/model.ts';

type RecoveryPoint = Readonly<{ createdAt: string; reason: string; raw: unknown }>;

export type V5RecoveryVerdict = Readonly<{
  pointKey: string;
  createdAt: string;
  reason: string;
  restorable: boolean;
  blocked: boolean;
  message: string;
  currentFacts: number;
  pointFacts: number;
  targetFingerprint: string;
}>;

export type V5RecoveryTarget = Readonly<{
  mode: 'current';
  dataFormat: 'action-v5';
  data: DataV5;
}>;

// Deterministic, synchronous content digest so the same binding can be checked
// inside the atomic transaction. Change-detection binding, not a security hash.
export function contentFingerprint(value: unknown): string {
  const text = canonicalJson(value);
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(13, '0');
}

/** A recovery point must be a v5 envelope; round-trip it through the v5 backup validator. */
export function targetFromV5Raw(raw: unknown): V5RecoveryTarget {
  if (
    !raw ||
    typeof raw !== 'object' ||
    (raw as { schemaVersion?: unknown }).schemaVersion !== 4 ||
    (raw as { mode?: unknown }).mode !== 'current' ||
    (raw as { dataFormat?: unknown }).dataFormat !== 'action-v5'
  )
    throw new ActionDomainError(
      'UNSUPPORTED_VERSION',
      '该恢复点不是通用卡牌工作区，一键“回到刚才”不支持跨版本；请使用完整备份恢复。',
    );
  const pack = backupV5((raw as { data: DataV5 }).data),
    target = parseV06Restore(JSON.stringify(pack));
  if (target.mode !== 'current' || target.dataFormat !== 'action-v5')
    throw new ActionDomainError(
      'UNSUPPORTED_VERSION',
      '该恢复点不是通用卡牌工作区，请使用完整备份恢复。',
    );
  return target;
}

// Facts only move forward: every confirmed fact in the live workspace must be
// present and unchanged in the point.
function crossedFacts(current: DataV5, data: DataV5): number {
  let crossed = 0;
  for (const fact of current.planner.facts) {
    const previous = data.planner.facts.find((item) => item.id === fact.id);
    if (!previous || !sameValue(previous, fact)) crossed += 1;
  }
  return crossed;
}

/** Read-only verdict for the honest confirmation; validates the fact lock and source digests. */
export async function inspectV5RecoveryPoint(input: {
  pointKey: string;
  value: unknown;
  current: DataV5;
}): Promise<V5RecoveryVerdict> {
  const point =
    input.value && typeof input.value === 'object' && 'raw' in input.value
      ? (input.value as RecoveryPoint)
      : null;
  const base = {
    pointKey: input.pointKey,
    createdAt: point?.createdAt ?? '',
    reason: point?.reason ?? '',
    currentFacts: input.current.planner.facts.length,
  };
  const refuse = (message: string, pointFacts = 0): V5RecoveryVerdict => ({
    ...base,
    restorable: false,
    blocked: true,
    pointFacts,
    targetFingerprint: '',
    message,
  });
  if (!point) return refuse('该恢复点不含可恢复工作区，请保留导出原文。');
  let target: V5RecoveryTarget;
  try {
    target = targetFromV5Raw(point.raw);
  } catch (error) {
    return refuse(
      error instanceof Error ? error.message : '该恢复点无法完整读取，请保留导出原文。',
    );
  }
  const crossed = crossedFacts(input.current, target.data);
  if (crossed > 0)
    return refuse(
      `该恢复点早于 ${crossed} 条已确认事实。事实只向前，无法回到这里；你仍可导出该点原文。`,
      target.data.planner.facts.length,
    );
  // P1: corrupt sources must be rejected before they are written back.
  try {
    await validateV5Fingerprints(target.data);
  } catch (error) {
    return refuse(
      error instanceof Error ? error.message : '该恢复点原文摘要不匹配，无法安全回到这里。',
      target.data.planner.facts.length,
    );
  }
  return {
    ...base,
    restorable: true,
    blocked: false,
    pointFacts: target.data.planner.facts.length,
    targetFingerprint: contentFingerprint(target.data),
    message: '',
  };
}

/** Re-validate at submit time (fact lock); returns the target or throws an honest message. */
export function guardedV5Target(current: DataV5, raw: unknown): V5RecoveryTarget {
  const target = targetFromV5Raw(raw),
    crossed = crossedFacts(current, target.data);
  if (crossed > 0)
    throw new ActionDomainError(
      'MIGRATION_BLOCKED',
      `该恢复点早于 ${crossed} 条已确认事实。事实只向前，无法回到这里。`,
    );
  return target;
}
