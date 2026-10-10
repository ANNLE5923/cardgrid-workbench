/**
 * 结束当天（v0.6.4）纯检查模型。
 *
 * 这是一个只读派生：输入全部来自既有投影（readDay 的 DayView、活动工作区的
 * planner.occurrences/instances/rules、readUnifiedHand 的手牌），输出"收尾一屏"需要
 * 展示与判断的内容。函数本身不 import React / Host / 存储，不产生任何命令或写入；
 * 打开面板、刷新、空场收口都由调用方保证零业务写入。
 *
 * 关键口径（见 v0.6.4 策划 §8 评审及 2026-10-10 独立复查）：
 * - 计划超时不等于实际发生：已结束但仍无 Fact 的有效计划需要核实。但要区分两类：
 *   （1）当前可处理的阻塞项 unverified——仅"今天、可写、且正式命令仍允许解除"的计划；
 *   （2）历史只读提醒 lockedUnverified——过去日 / 已被例行锁定的计划。正式 Host 对过去
 *   例行的 ConfirmActual / RetractPlan / WithdrawInstance 一律 PAST_OCCURRENCE_LOCKED
 *   （见 daily/model/domain.ts 的 editable），原日没有合法的就地解除路径，只有向前
 *   CreateMakeup 合法；这类项绝不能把历史日永久卡成 canClose=false，已有补录实例时只链接。
 *   同理，绑定的每日素材一旦到期 / 已消费（常见于 23:50–次日 00:20、素材午夜到期），正式
 *   Host 对确认 / 撤回 / 改期全部判 MATERIAL_*，也归入 lockedUnverified(material-expired)，
 *   等待"归档到期副本"库存对账统一收回，而不是阻塞收尾。
 * - 跨午夜尚未结束的安排（endAt 晚于 now）不算超时，不进任何待核实列表。
 * - "该日实际发生"只统计 actualRange 与当日相交的 Fact（按 factId 去重）；实际时长用
 *   kind === 'fact' 且已裁剪到当日的 clippedRange，原计划对照 / plan / fixed 不计入，
 *   跨午夜的 Fact 不会在两天重复计整段。
 * - 补录资格对齐 CreateMakeup：原实例无 Fact、尚无补录实例，且例行 missed/skipped，
 *   或 generated 但来源日已过（按规则时区）；cancelled 不提示。
 * - 手牌"可收回"必须逐条对齐正式门禁（domain.ts 的 editable + WithdrawInstance +
 *   v5-today 的素材门禁）：action/composite、实例 open、无 Fact、无活动计划、素材未到期
 *   未消费，且若绑定例行，该例行必须是"今天（规则时区）仍 generated"；过去例行一律不可
 *   收回。answer/entry 没有该正式命令，只读。手牌仅在查看"今天"时参与。
 */
import type { DayView, Id, Instance, Occurrence, Range, Rule } from '../../workspace/index.ts';
import {
  compareInstants,
  dateAt,
  elapsedMinutes,
  intersectRanges,
  nextDate,
  weekday,
} from '../schedule/time.ts';

/** 调用方从当前手牌投影 + 真实实例 / 例行解析后传入的最小手牌视图。 */
export type CloseHandItem = Readonly<{
  key: string;
  kind: 'action' | 'answer' | 'composite' | 'entry';
  title: string;
  expiresAt: string | null;
  unavailableReason: string | null;
  /** action/composite 解析到的实例 ID；answer/entry 或无法解析时为 null。 */
  instanceId: Id | null;
  /** 实例当前状态；非实例条目为 null。 */
  instanceState: Instance['state'] | null;
  hasFact: boolean;
  hasActivePlan: boolean;
  /** 绑定的例行（取自 instance.occurrenceId → occurrence + rule.zone）；非例行为 null。 */
  occurrence: Readonly<{
    date: string;
    disposition: Occurrence['disposition'];
    zone: string;
  }> | null;
}>;

export type UnverifiedPlan = Readonly<{
  planId: Id;
  instanceId: Id;
  title: string;
  range: Range;
  /** 跨午夜延续：开始时间落在所选日期之前。 */
  continuesBefore: boolean;
}>;

/** 历史只读提醒：原日已无合法就地解除路径，不阻塞收口；可链接到向前补录实例。 */
export type LockedUnverifiedPlan = UnverifiedPlan &
  Readonly<{
    /**
     * past-occurrence：过去 / 已结束例行（editable 抛 PAST_OCCURRENCE_LOCKED）；
     * material-expired：绑定的每日素材已到期 / 已消费（v5-today 抛 MATERIAL_EXPIRED /
     * MATERIAL_CONSUMED），确认、撤回、改期都被拒，只能等"归档到期副本"库存对账统一收回；
     * historical-readonly：非今天 / 归档只读日，本视图不提供写入。
     */
    lockedReason: 'past-occurrence' | 'material-expired' | 'historical-readonly';
    /** 已存在的向前补录实例 ID（CreateMakeup 产物）；没有则为 null。 */
    makeupInstanceId: Id | null;
  }>;

/**
 * 计划实例绑定的 v5 行动 / 合成素材（data.handCards 中 action/composite 卡，按
 * actionInstanceId 对应）。没有素材卡的传统实例无需传入。
 */
export type CloseMaterialBinding = Readonly<{
  instanceId: Id;
  state: 'available' | 'consumed' | 'expired' | 'withdrawn';
  consumedBy: Id | null;
  expiresAt: string | null;
}>;

export type MakeupRoutine = Readonly<{
  occurrenceId: Id;
  ruleId: Id;
  instanceId: Id;
  date: string;
  disposition: Occurrence['disposition'];
  /** 对齐 CreateMakeup 的真实资格；不满足时仅展示、不引导补录。 */
  makeupEligible: boolean;
  reason: 'missed' | 'skipped' | 'past-generated';
}>;

export type WithdrawBlockedReason =
  'past-occurrence' | 'fact-locked' | 'already-planned' | 'instance-closed' | 'expired';

export type RetainedHandItem = Readonly<{
  key: string;
  kind: CloseHandItem['kind'];
  title: string;
  expiresAt: string | null;
  expired: boolean;
  unavailableReason: string | null;
  instanceId: Id | null;
  /** answer/entry 等没有正式收回命令的条目只读。 */
  readOnly: boolean;
  withdrawable: boolean;
  withdrawBlockedReason: WithdrawBlockedReason | null;
}>;

export type CloseRecap = Readonly<{
  /** 该日实际发生且已确认的卡（actualRange 与当日相交，按 factId 去重）。 */
  actualConfirmedCount: number;
  /** 该日实际时段分钟数（仅 kind==='fact' 的当日裁剪段）。 */
  actualMinutes: number;
  /** 当日仍 active 的计划数（含已核实与待核实）。 */
  activePlanCount: number;
}>;

export type CloseChecklist = Readonly<{
  date: string;
  zone: string;
  isToday: boolean;
  /** 归档日期且归档包覆盖不全：无法完整回顾，只读且不能收口。 */
  reviewable: boolean;
  reviewBlockedReason: string | null;
  /** 可处理的待核实安排：今天可写、正式命令仍允许解除；唯一阻塞项。 */
  unverified: readonly UnverifiedPlan[];
  /** 历史只读提醒：过去日 / 被例行锁定、原日无法就地解除，不阻塞。 */
  lockedUnverified: readonly LockedUnverifiedPlan[];
  /** 例行补录提醒（非阻塞，是历史例行唯一合法的向前处理路径）。 */
  routines: readonly MakeupRoutine[];
  /** 当前仍保留的手牌（仅查看今天时提供）。 */
  hand: readonly RetainedHandItem[];
  recap: CloseRecap;
  /** 仅当不存在"今天仍可处理却未核实"的计划时可收口；归档不完整时恒为 false。 */
  canClose: boolean;
}>;

export type CloseChecklistInput = Readonly<{
  date: string;
  zone: string;
  now: string;
  day: DayView;
  /** 活动工作区 planner.occurrences（归档只读日传空数组）。 */
  occurrences: readonly Occurrence[];
  /** 活动工作区 planner.instances。 */
  instances: readonly Instance[];
  /** 活动工作区 planner.rules。 */
  rules: readonly Rule[];
  /** 全量 planner.facts 对应的实例 ID（用于补录 / 完成判定，不只当日投影）。 */
  confirmedInstanceIds: readonly string[];
  /** 当前手牌；仅 isToday 且非归档时传入，其它情况传空数组。 */
  hand: readonly CloseHandItem[];
  /**
   * 行动 / 合成素材绑定（全量 action/composite handCards，按 actionInstanceId）。
   * 用于判定到期素材的计划是否还能确认 / 撤回 / 改期；归档只读日可传空数组。
   */
  materials: readonly CloseMaterialBinding[];
  isToday: boolean;
  archived: boolean;
  archiveComplete: boolean;
}>;

const TITLE_FALLBACK = '未命名安排';

/**
 * 对齐 domain.ts editable() 的例行锁：只有"规则时区下仍是今天、且 disposition 为
 * generated"的例行实例允许就地确认 / 撤回 / 收回；过去或已结束例行返回 false。
 * 非例行实例（无 occurrenceId）不受此锁约束。
 */
function occurrenceIsEditable(
  instance: Instance | undefined,
  occurrences: readonly Occurrence[],
  rules: readonly Rule[],
  now: string,
): boolean {
  if (!instance?.occurrenceId) return true;
  const occurrence = occurrences.find((o) => o.id === instance.occurrenceId);
  const rule = occurrence && rules.find((r) => r.id === occurrence.ruleId);
  if (!occurrence || !rule) return false;
  return occurrence.date >= dateAt(now, rule.zone) && occurrence.disposition === 'generated';
}

/**
 * 对齐 v5-today.applyToday 的素材门禁：绑定了行动 / 合成素材的实例，只要素材不是
 * available、已被消费，或已过 expiresAt，确认 / 撤回 / 改期都会被拒（MATERIAL_*）。
 * 没有素材卡的传统实例（binding 缺失）不受此门禁约束（对应 applyToday 的 `if (material)`）。
 */
function materialIsEditable(
  instanceId: Id,
  materials: readonly CloseMaterialBinding[],
  now: string,
): boolean {
  const material = materials.find((m) => m.instanceId === instanceId);
  if (!material) return true;
  if (material.state !== 'available' || material.consumedBy !== null) return false;
  return material.expiresAt === null || compareInstants(now, material.expiresAt) < 0;
}

function makeupInstanceIdFor(
  instance: Instance | undefined,
  occurrences: readonly Occurrence[],
  instances: readonly Instance[],
): Id | null {
  if (!instance?.occurrenceId) return null;
  const occurrence = occurrences.find((o) => o.id === instance.occurrenceId);
  if (!occurrence) return null;
  return (
    instances.find((i) => i.makeupOf?.kind === 'occurrence' && i.makeupOf.id === occurrence.id)
      ?.id ?? null
  );
}

/** 逐条复刻正式 WithdrawInstance 门禁；返回是否可收回及不可收回原因。 */
function evaluateWithdraw(
  item: CloseHandItem,
  expired: boolean,
  now: string,
): { withdrawable: boolean; reason: WithdrawBlockedReason | null } {
  const isAction = item.kind === 'action' || item.kind === 'composite';
  if (!isAction) return { withdrawable: false, reason: null }; // answer/entry 只读，非收回目标
  if (!item.instanceId || item.instanceState !== 'open')
    return { withdrawable: false, reason: 'instance-closed' };
  if (item.hasFact) return { withdrawable: false, reason: 'fact-locked' };
  if (item.hasActivePlan) return { withdrawable: false, reason: 'already-planned' };
  if (expired) return { withdrawable: false, reason: 'expired' };
  if (item.occurrence) {
    const editableToday =
      item.occurrence.date >= dateAt(now, item.occurrence.zone) &&
      item.occurrence.disposition === 'generated';
    if (!editableToday) return { withdrawable: false, reason: 'past-occurrence' };
  }
  return { withdrawable: true, reason: null };
}

/**
 * 计算某一天的收尾检查清单。纯函数：相同输入恒定得到相同输出，不修改入参。
 */
export function buildCloseChecklist(input: CloseChecklistInput): CloseChecklist {
  const { date, zone, now, day, isToday, archived, archiveComplete } = input;
  const dayRange = day.dayRange;
  const confirmed = new Set(input.confirmedInstanceIds);
  const writableToday = isToday && !archived;

  const reviewable = !archived || archiveComplete;
  const reviewBlockedReason =
    archived && !archiveComplete ? '归档覆盖不全，无法完整回顾这一天' : null;

  // —— 已结束（endAt <= now）且仍无 Fact 的 active 计划，按实例去重，再分两类 ——
  const seen = new Set<Id>();
  const unverified: UnverifiedPlan[] = [];
  const lockedUnverified: LockedUnverifiedPlan[] = [];
  for (const plan of day.plans) {
    if (seen.has(plan.instanceId)) continue;
    const isConfirmed = day.facts.some((f) => f.instanceId === plan.instanceId);
    const ended = compareInstants(plan.range.endAt, now) <= 0;
    if (!ended || isConfirmed) continue;
    seen.add(plan.instanceId);
    const instance = input.instances.find((i) => i.id === plan.instanceId);
    const base: UnverifiedPlan = {
      planId: plan.planId,
      instanceId: plan.instanceId,
      title: instance?.currentContent.title ?? TITLE_FALLBACK,
      range: plan.range,
      continuesBefore: compareInstants(plan.range.startAt, dayRange.startAt) < 0,
    };
    const occurrenceEditable = occurrenceIsEditable(instance, input.occurrences, input.rules, now);
    const materialEditable = materialIsEditable(plan.instanceId, input.materials, now);
    if (writableToday && occurrenceEditable && materialEditable) {
      unverified.push(base);
    } else {
      const lockedReason: LockedUnverifiedPlan['lockedReason'] = !occurrenceEditable
        ? 'past-occurrence'
        : !materialEditable
          ? 'material-expired'
          : 'historical-readonly';
      lockedUnverified.push({
        ...base,
        lockedReason,
        makeupInstanceId: makeupInstanceIdFor(instance, input.occurrences, input.instances),
      });
    }
  }

  // —— 例行补录提醒（对齐 CreateMakeup，非阻塞；归档日只读，不提供）——
  // 今天收尾要收集【截至今天所有仍欠的例行】：昨天（或更早）漏做 / 跳过 / 已过期的
  // generated，都应能在今天一键向前补做（CreateMakeup 的 targetDate 是今天）；
  // 回看某一过去日时，只列该日自己的例行，作只读提醒（面板本身只在今天渲染）。
  const routines: MakeupRoutine[] = [];
  if (!archived) {
    for (const occurrence of input.occurrences) {
      const rule = input.rules.find((r) => r.id === occurrence.ruleId);
      if (!rule) continue;
      if (occurrence.disposition === 'cancelled') continue;
      if (confirmed.has(occurrence.instanceId)) continue; // 已确认，无需补录
      const alreadyMakeup = input.instances.some(
        (i) => i.makeupOf?.kind === 'occurrence' && i.makeupOf.id === occurrence.id,
      );
      if (alreadyMakeup) continue; // 已有补录实例，在历史提醒里链接，不重复提示
      const ruleToday = dateAt(now, rule.zone);
      const inScope = isToday ? occurrence.date <= ruleToday : occurrence.date === date;
      if (!inScope) continue; // 今天视图不收未来例行；过去日视图只看当日
      const pastGenerated = occurrence.disposition === 'generated' && occurrence.date < ruleToday;
      const eligibleByDisposition =
        occurrence.disposition === 'missed' ||
        occurrence.disposition === 'skipped' ||
        pastGenerated;
      if (!eligibleByDisposition) continue;
      routines.push({
        occurrenceId: occurrence.id,
        ruleId: occurrence.ruleId,
        instanceId: occurrence.instanceId,
        date: occurrence.date,
        disposition: occurrence.disposition,
        makeupEligible: true,
        reason:
          occurrence.disposition === 'missed'
            ? 'missed'
            : occurrence.disposition === 'skipped'
              ? 'skipped'
              : 'past-generated',
      });
    }
  }

  // —— 当前手牌（仅查看今天；过去日不混入当前库存）——
  const hand: RetainedHandItem[] = writableToday
    ? input.hand.map((item) => {
        const expired = item.expiresAt !== null && compareInstants(now, item.expiresAt) >= 0;
        const isAction = item.kind === 'action' || item.kind === 'composite';
        const gate = evaluateWithdraw(item, expired, now);
        return {
          key: item.key,
          kind: item.kind,
          title: item.title,
          expiresAt: item.expiresAt,
          expired,
          unavailableReason: item.unavailableReason,
          instanceId: item.instanceId,
          readOnly: !isAction,
          withdrawable: gate.withdrawable,
          withdrawBlockedReason: gate.reason,
        };
      })
    : [];

  // —— 只读回顾：实际发生按 actualRange 与当日相交，实际时长取当日裁剪的 fact 段 ——
  const actualFactIds = new Set<Id>();
  for (const fact of day.facts)
    if (intersectRanges(dayRange, fact.actualRange)) actualFactIds.add(fact.factId);
  const actualMinutes = day.segments
    .filter((segment) => segment.kind === 'fact')
    .reduce((sum, segment) => sum + elapsedMinutes(segment.clippedRange), 0);
  const recap: CloseRecap = {
    actualConfirmedCount: actualFactIds.size,
    actualMinutes,
    activePlanCount: day.plans.length,
  };

  return {
    date,
    zone,
    isToday,
    reviewable,
    reviewBlockedReason,
    unverified,
    lockedUnverified,
    routines,
    hand,
    recap,
    canClose: reviewable && unverified.length === 0,
  };
}

/**
 * 明日"例行卡"预计（仅规则层预计，不是库存事实）。
 *
 * 范围限定为 planner.Rule（按 weekdays 排程的例行规则）：每条规则用【自己的 zone】计算
 * 当地明天，再判 startDate / weekdays；来源卡当前无效的规则直接剔除（不进结果）。
 * 正式 Data v5 没有未来副本、也没有 previewGeneration，结果必须标注"预计，尚未生成"。
 *
 * 注意：每日副本使用的 GenerationRule（schedule.daily / schedule.weekdays）是另一套契约，
 * 不在此函数处理；接线时不要把 GenerationRule 当作 Rule 传入。
 */
export type ExpectedRoutineItem = Readonly<{
  ruleId: Id;
  /** 该规则时区下的明天日期 */ date: string;
}>;

export function projectExpectedRoutines(
  rules: readonly Rule[],
  context: Readonly<{ now: string; isSourceActive: (rule: Rule) => boolean }>,
): readonly ExpectedRoutineItem[] {
  const result: ExpectedRoutineItem[] = [];
  for (const rule of rules) {
    if (rule.status !== 'active') continue;
    if (!context.isSourceActive(rule)) continue; // 来源无效：不进入预计
    const tomorrow = nextDate(dateAt(context.now, rule.zone));
    if (tomorrow < rule.startDate) continue;
    if (!rule.weekdays.includes(weekday(tomorrow))) continue;
    result.push({ ruleId: rule.id, date: tomorrow });
  }
  return result;
}
