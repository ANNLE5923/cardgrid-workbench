/**
 * A1 workshop model: pure validation for action cards, book entries, pools and
 * generation rules. No React, no database; entities reuse the frozen v3 contracts.
 */
import type {
  ActionCard, BookEntry, GenerationRule, Pool,
} from '../workspace/index.ts';
import { assertDate, assertZone } from '../daily/time.ts';
import {poolCapacityIssue} from './capacity.ts';
export {POOL_CAPACITY, poolCapacityIssue} from './capacity.ts';
export type {ActionCard, BookEntry, Pool, PoolKind, SlotSpec, GenerationRule, GenerationSchedule, WorkshopEntityStatus} from '../workspace/index.ts';
export {validateWorkshopCatalog, validateWorkshopEntity, parseWorkshopJson, validateWorkshopChange, type WorkshopCatalog, type WorkshopValidation, type WorkshopEntity} from './catalog.ts';
export {prepareWorkshopChange, workshopChangeEffectiveDate, type WorkshopChangeContext, type WorkshopRevision, type PreparedWorkshopChange} from './change.ts';
export type {WorkshopIssueCode} from './validation.ts';

export type WorkshopIssue = Readonly<{ code: string; path: string; message: string }>;

export type WorkshopContext = Readonly<{
  actionCards: readonly ActionCard[];
  bookEntries: readonly BookEntry[];
  pools: readonly Pool[];
  rules: readonly GenerationRule[];
}>;

export const EMPTY_CONTEXT: WorkshopContext = { actionCards: [], bookEntries: [], pools: [], rules: [] };

const issue = (code: string, path: string, message: string): WorkshopIssue => ({ code, path, message });

/** Saving a changed entity advances its version; snapshots already taken never change. */
export function bumpVersion(version: number): number { return version + 1; }

export function validateBookDraft(draft: BookEntry): WorkshopIssue[] {
  const issues: WorkshopIssue[] = [];
  if (draft.title.trim() === '') issues.push(issue('TITLE_REQUIRED', 'title', '书名必填'));
  return issues;
}

export function validateActionDraft(draft: ActionCard, ctx: WorkshopContext): WorkshopIssue[] {
  const issues: WorkshopIssue[] = [];
  if (draft.content.title.trim() === '') issues.push(issue('TITLE_REQUIRED', 'content.title', '行动名称必填'));

  const seen = new Set<string>();
  draft.slots.forEach((slot, i) => {
    const p = `slots[${i}]`;
    if (seen.has(slot.id)) issues.push(issue('SLOT_ID_DUPLICATE', `${p}.id`, '槽 ID 在卡内重复'));
    seen.add(slot.id);
    const pool = ctx.pools.find(candidate => candidate.id === slot.poolId);
    if (!pool) issues.push(issue('SLOT_POOL_NOT_FOUND', `${p}.poolId`, '槽绑定的池不存在'));
    // v0.3 slots reference concrete book entries only (no recursive cards).
    else if (pool.poolKind !== 'book') issues.push(issue('SLOT_POOL_KIND_MISMATCH', `${p}.poolId`, '槽只能绑定书目池'));
  });
  return issues;
}

function poolHasCycle(draft: Pool, pools: readonly Pool[]): boolean {
  const byId = new Map(pools.map(p => [p.id, p]));
  const visited = new Set<string>([draft.id]);
  let current = draft.parentPoolId === null ? undefined : byId.get(draft.parentPoolId);
  while (current) {
    if (visited.has(current.id)) return true;
    visited.add(current.id);
    current = current.parentPoolId === null ? undefined : byId.get(current.parentPoolId);
  }
  return false;
}

export function validatePoolDraft(draft: Pool, ctx: WorkshopContext): WorkshopIssue[] {
  const issues: WorkshopIssue[] = [];
  const capacity = poolCapacityIssue(draft);
  if (capacity) issues.push(capacity);
  if (draft.name.trim() === '') issues.push(issue('NAME_REQUIRED', 'name', '池名称必填'));

  if (draft.parentPoolId !== null) {
    const parent = ctx.pools.find(candidate => candidate.id === draft.parentPoolId);
    if (!parent) issues.push(issue('POOL_PARENT_NOT_FOUND', 'parentPoolId', '父池不存在'));
    else if (parent.poolKind !== draft.poolKind) issues.push(issue('POOL_PARENT_KIND', 'parentPoolId', '父池种类必须一致'));
    else if (poolHasCycle(draft, ctx.pools)) issues.push(issue('POOL_PARENT_CYCLE', 'parentPoolId', '池层级不能成环'));
  }

  draft.memberIds.forEach((memberId, i) => {
    const p = `memberIds[${i}]`;
    if (draft.poolKind === 'book') {
      if (!ctx.bookEntries.some(entry => entry.id === memberId))
        issues.push(issue('MEMBER_NOT_FOUND', p, '成员书目不存在'));
    } else if (!ctx.actionCards.some(card => card.id === memberId)) {
      issues.push(issue('MEMBER_NOT_FOUND', p, '成员行动卡不存在'));
    }
  });
  return issues;
}

export function validateRuleDraft(draft: GenerationRule, ctx: WorkshopContext): WorkshopIssue[] {
  const issues: WorkshopIssue[] = [];
  if (draft.name.trim() === '') issues.push(issue('NAME_REQUIRED', 'name', '规则名称必填'));
  if (!ctx.actionCards.some(card => card.id === draft.actionCardId))
    issues.push(issue('RULE_ACTION_NOT_FOUND', 'actionCardId', '规则引用的行动原卡不存在'));

  if (draft.schedule.mode === 'weekdays') {
    const days = draft.schedule.weekdays;
    if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6))
      issues.push(issue('RULE_WEEKDAYS_INVALID', 'schedule.weekdays', '星期取值须为 0—6 且至少一天'));
  }
  try { assertDate(draft.startDate); } catch { issues.push(issue('RULE_START_INVALID', 'startDate', '开始日期无效')); }
  try { assertZone(draft.zone); } catch { issues.push(issue('RULE_ZONE_INVALID', 'zone', '时区无效')); }
  return issues;
}
