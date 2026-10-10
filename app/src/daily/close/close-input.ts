/**
 * 把正式 DataV5 + 某日 DayView 适配成收尾检查清单（v0.6.4）。
 *
 * 纯函数、不碰 React / Host / 存储：调用方负责读取与提交。关键点：
 * - materials 取自【全量】action/composite handCards（含已经排进表盘的卡），否则到期
 *   素材跨日计划的锁定会被漏掉；
 * - 手牌只用当前手牌投影（projectUnifiedHand + dock builders），已上表盘 / 已完成的实例
 *   天然不在手牌里；
 * - 例行锁、实例状态、Fact / 活动计划都从 planner 真实记录解析，不靠手牌 UI 猜测。
 */
import type { DayView, Id, Instance, Occurrence, Rule } from '../../workspace/index.ts';
import type { DataV5 } from '../../workspace/v06.ts';
import {
  legacyDockItems,
  materialDockItems,
  projectUnifiedHand,
  type HandDockItem,
} from '../hand/unified.ts';
import { dateAt } from '../schedule/time.ts';
import {
  buildCloseChecklist,
  type CloseChecklist,
  type CloseHandItem,
  type CloseMaterialBinding,
} from './close-checklist.ts';

type ActionCard = Extract<DataV5['handCards'][number], { kind: 'action' | 'composite' }>;

function isActionCard(card: DataV5['handCards'][number]): card is ActionCard {
  return (card.kind === 'action' || card.kind === 'composite') && !!card.actionInstanceId;
}

/** 全量行动 / 合成素材绑定，含已排进表盘（不在当前手牌投影中）的卡。 */
export function materialBindings(data: DataV5): readonly CloseMaterialBinding[] {
  return data.handCards.filter(isActionCard).map((card) => ({
    instanceId: card.actionInstanceId as Id,
    state: card.state,
    consumedBy: card.consumedBy,
    expiresAt: card.expiresAt,
  }));
}

function occurrenceRef(
  instance: Instance | undefined,
  occurrences: readonly Occurrence[],
  rules: readonly Rule[],
): CloseHandItem['occurrence'] {
  if (!instance?.occurrenceId) return null;
  const occurrence = occurrences.find((o) => o.id === instance.occurrenceId);
  const rule = occurrence && rules.find((r) => r.id === occurrence.ruleId);
  if (!occurrence || !rule) return null;
  return { date: occurrence.date, disposition: occurrence.disposition, zone: rule.zone };
}

function toCloseHandItem(item: HandDockItem, data: DataV5): CloseHandItem {
  const p = data.planner;
  let instanceId: Id | null = null;
  if (item.selection.kind === 'legacy') instanceId = item.selection.instanceId;
  else if (item.kind === 'action' || item.kind === 'composite') {
    const card = data.handCards.find((c) => c.id === item.id);
    if (card && isActionCard(card)) instanceId = card.actionInstanceId;
  }
  const instance = instanceId ? p.instances.find((i) => i.id === instanceId) : undefined;
  return {
    key: item.key,
    kind: item.kind,
    title: item.title,
    expiresAt: item.expiresAt,
    unavailableReason: item.unavailableReason,
    instanceId,
    instanceState: instance?.state ?? null,
    hasFact: instance ? p.facts.some((f) => f.instanceId === instance.id) : false,
    hasActivePlan: instance
      ? p.plans.some((plan) => plan.instanceId === instance.id && plan.status === 'active')
      : false,
    occurrence: occurrenceRef(instance, p.occurrences, p.rules),
  };
}

export function buildCloseChecklistFromV5(
  data: DataV5,
  day: DayView,
  now: string,
  options: Readonly<{ archived?: boolean; archiveComplete?: boolean }> = {},
): CloseChecklist {
  const p = data.planner;
  const archived = options.archived ?? false;
  const archiveComplete = options.archiveComplete ?? false;
  const isToday = day.date === dateAt(now, day.zone);

  const mappedInstanceIds = data.handCards.flatMap((c) =>
    isActionCard(c) ? [c.actionInstanceId as Id] : [],
  );
  const unified = projectUnifiedHand(data, now);
  const dockItems: readonly HandDockItem[] = [
    ...materialDockItems(unified),
    ...legacyDockItems(data, mappedInstanceIds),
  ];

  return buildCloseChecklist({
    date: day.date,
    zone: day.zone,
    now,
    day,
    occurrences: p.occurrences,
    instances: p.instances,
    rules: p.rules,
    confirmedInstanceIds: p.facts.map((f) => f.instanceId),
    hand: isToday && !archived ? dockItems.map((item) => toCloseHandItem(item, data)) : [],
    materials: materialBindings(data),
    isToday,
    archived,
    archiveComplete,
  });
}
