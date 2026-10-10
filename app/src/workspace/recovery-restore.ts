import type { WorkspaceData } from './contracts.ts';
import {
  parseRestore,
  exportWorkspace,
  canonicalJson,
  validateSourceFingerprints,
  type RestoreTarget,
} from './format.ts';
import { ActionDomainError, sameValue } from '../daily/model.ts';

type RecoveryPoint = Readonly<{ createdAt: string; reason: string; raw: unknown }>;

export type RecoveryVerdict = Readonly<{
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

/** Turn a recovery point's stored envelope into a validated restore target. */
export function targetFromRecoveryRaw(raw: unknown): RestoreTarget {
  return parseRestore(JSON.stringify(exportWorkspace(raw)));
}

// Deterministic, synchronous content digest so the same binding can be checked
// inside the atomic transaction. It is a change-detection binding, not a security hash.
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

type GuardResult = Readonly<{ ok: boolean; pointFacts: number; message: string }>;

// Facts only move forward: a one-click "go back" may never remove or alter a confirmed fact,
// and the lightweight path stays within the same data generation.
function guard(current: WorkspaceData, target: RestoreTarget): GuardResult {
  const crossVersion =
    '该恢复点来自更早的版本格式，一键“回到刚才”不支持跨版本；请使用完整备份恢复。';
  if (target.mode !== 'current') return { ok: false, pointFacts: 0, message: crossVersion };
  const point = target.data;
  if (point.version !== current.version)
    return { ok: false, pointFacts: point.planner.facts.length, message: crossVersion };
  let crossed = 0;
  for (const fact of current.planner.facts) {
    const previous = point.planner.facts.find((item) => item.id === fact.id);
    if (!previous || !sameValue(previous, fact)) crossed += 1;
  }
  if (crossed > 0)
    return {
      ok: false,
      pointFacts: point.planner.facts.length,
      message: `该恢复点早于 ${crossed} 条已确认事实。事实只向前，无法回到这里；你仍可导出该点原文。`,
    };
  return { ok: true, pointFacts: point.planner.facts.length, message: '' };
}

/** Read-only verdict used to render the honest confirmation before any write.
 * Also validates source fingerprints so a corrupt point is refused up front. */
export async function inspectRecoveryPoint(input: {
  pointKey: string;
  value: unknown;
  current: WorkspaceData;
}): Promise<RecoveryVerdict> {
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
  const refuse = (message: string, pointFacts = 0): RecoveryVerdict => ({
    ...base,
    restorable: false,
    blocked: true,
    pointFacts,
    targetFingerprint: '',
    message,
  });
  if (!point) return refuse('该恢复点不含可恢复工作区，请保留导出原文。');
  let target: RestoreTarget;
  try {
    target = targetFromRecoveryRaw(point.raw);
  } catch (error) {
    return refuse(
      error instanceof Error ? error.message : '该恢复点无法完整读取，请保留导出原文。',
    );
  }
  const result = guard(input.current, target);
  if (!result.ok) return refuse(result.message, result.pointFacts);
  if (target.mode !== 'current') return refuse('该恢复点不是可编辑工作区。');
  // P1: corrupt legacy sources must be rejected before they are written back.
  try {
    await validateSourceFingerprints(target.data);
  } catch (error) {
    return refuse(
      error instanceof Error ? error.message : '该恢复点原文摘要不匹配，无法安全回到这里。',
      result.pointFacts,
    );
  }
  return {
    ...base,
    restorable: true,
    blocked: false,
    pointFacts: result.pointFacts,
    targetFingerprint: contentFingerprint(target.data),
    message: '',
  };
}

/** Re-validate at submit time and return a current-mode target, or throw with an honest message. */
export function guardedRecoveryTarget(
  current: WorkspaceData,
  raw: unknown,
): Extract<RestoreTarget, { mode: 'current' }> {
  const target = targetFromRecoveryRaw(raw),
    result = guard(current, target);
  if (!result.ok) throw new ActionDomainError('MIGRATION_BLOCKED', result.message);
  return target as Extract<RestoreTarget, { mode: 'current' }>;
}
