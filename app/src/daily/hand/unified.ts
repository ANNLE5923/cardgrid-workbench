import type { Token, WorkspaceData } from '../../workspace/index.ts';
import type { DataV5, UnifiedHandItem, HandCard, V06ErrorCode } from '../../workspace/v06.ts';
import { assertInstant, compareInstants } from '../time.ts';

/** Read projection only. Placed entities remain in history, never duplicate the hand. */
export function projectUnifiedHand(data: DataV5, at: string): readonly UnifiedHandItem[] {
  assertInstant(at);
  return data.handCards
    .filter((card) => {
      if (card.state !== 'available' || card.consumedBy !== null) return false;
      if (card.kind === 'answer')
        return !data.referencePlacements.some(
          (r) => r.answerId === card.id && r.state === 'active',
        );
      if (card.kind === 'action' || card.kind === 'composite') {
        const instance = data.planner.instances.find((i) => i.id === card.actionInstanceId);
        return (
          !!instance &&
          instance.state === 'open' &&
          data.planner.handOrder.includes(instance.id) &&
          !data.planner.plans.some((p) => p.instanceId === instance.id && p.status === 'active') &&
          !data.planner.facts.some((f) => f.instanceId === instance.id)
        );
      }
      return true;
    })
    .map((card) => {
      let unavailableReason: UnifiedHandItem['unavailableReason'] = null;
      if (compareInstants(card.createdAt, at) > 0) unavailableReason = 'ENTRY_UNAVAILABLE';
      else if (card.expiresAt !== null && compareInstants(at, card.expiresAt) >= 0)
        unavailableReason = 'MATERIAL_EXPIRED';
      else if (card.kind === 'entry') unavailableReason = 'ENTRY_UNAVAILABLE';
      else if (card.kind === 'action' || card.kind === 'composite') {
        const values = new Map(card.fieldValues.map((v) => [v.fieldId, v.value]));
        if (
          card.fieldSpecs.some(
            (f) =>
              f.required &&
              (!values.has(f.id) ||
                values.get(f.id) === null ||
                (typeof values.get(f.id) === 'string' && !(values.get(f.id) as string).trim())),
          )
        )
          unavailableReason = 'INCOMPLETE';
      }
      return {
        card: structuredClone(card),
        usableInToday: unavailableReason === null,
        unavailableReason,
      };
    });
}

export type HandDockItem = Readonly<{
  key: string;
  id: string;
  version: number;
  kind: 'action' | 'answer' | 'composite' | 'entry';
  title: string;
  source: string;
  detail: string;
  usableInToday: boolean;
  unavailableReason: UnifiedHandItem['unavailableReason'];
  expiresAt: string | null;
  selection:
    | Readonly<{ kind: 'legacy'; instanceId: string }>
    | Readonly<{ kind: 'material'; cardId: string }>;
}>;
export type HandDockView = Readonly<{ token: Token; items: readonly HandDockItem[] }>;
export type HandPlayRequest = Readonly<{ requestId: string; token: Token; item: HandDockItem }>;
const sources = (card: HandCard) =>
  card.provenance
    .map((p) =>
      p.kind === 'daily-copy'
        ? `每日副本 ${p.copy.id} v${p.copy.version} · ${p.sourceDate} · ${p.zone}`
        : p.kind === 'manual'
          ? `原库 ${p.source.id} v${p.source.version}`
          : `问题 ${p.snapshot.question} · 决策 ${p.snapshot.decision.id} v${p.snapshot.decision.version} · 清单 ${p.snapshot.sourceDecks.map((d) => `${d.id} v${d.version}`).join('、')}`,
    )
    .join('\n');
export function materialDockItems(items: readonly UnifiedHandItem[]): readonly HandDockItem[] {
  return items.map(({ card, usableInToday, unavailableReason }) => ({
    key: `material:${card.id}`,
    id: card.id,
    version: card.version,
    kind: card.kind,
    title:
      card.kind === 'answer'
        ? card.answer.entry.title
        : card.kind === 'entry'
          ? card.entrySnapshot.title
          : card.contentSnapshot.title,
    source: sources(card),
    detail: [
      `本次 ID ${card.id} · v${card.version}`,
      `取得 ${card.createdAt}`,
      ...(card.expiresAt ? [`到期 ${card.expiresAt}`] : []),
      ...(card.inputIds.length ? [`合成输入 ${card.inputIds.join('、')}`] : []),
      card.kind === 'answer'
        ? `回答：${card.answer.question}\n${card.answer.fieldValues.map((f) => `${f.fieldId}：${String(f.value)}`).join('\n')}`
        : card.kind === 'entry'
          ? Object.entries(card.entrySnapshot.attributes)
              .map(([k, v]) => `${k}：${String(v)}`)
              .join('\n')
          : [
              card.contentSnapshot.criteria,
              card.fieldSpecs
                .map(
                  (f) =>
                    `${f.label}：${String(card.fieldValues.find((v) => v.fieldId === f.id)?.value ?? '未填')}`,
                )
                .join('\n'),
            ]
              .filter(Boolean)
              .join('\n'),
    ]
      .filter(Boolean)
      .join('\n'),
    expiresAt: card.expiresAt,
    usableInToday,
    unavailableReason,
    selection: { kind: 'material', cardId: card.id },
  }));
}
/** All old unbound Instances stay visible, including those a v5 migration cannot map. */
export function legacyDockItems(
  data: Readonly<{
    planner: Pick<WorkspaceData['planner'], 'instances' | 'plans' | 'facts' | 'handOrder'>;
  }>,
  mappedInstanceIds: readonly string[] = [],
): readonly HandDockItem[] {
  const p = data.planner;
  return p.handOrder.flatMap((id) => {
    const i = p.instances.find((i) => i.id === id);
    if (
      !i ||
      mappedInstanceIds.includes(id) ||
      i.state !== 'open' ||
      p.facts.some((f) => f.instanceId === id) ||
      p.plans.some((p) => p.instanceId === id && p.status === 'active')
    )
      return [];
    return [
      {
        key: `legacy:${id}`,
        id,
        version: i.version,
        kind: 'action' as const,
        title: i.currentContent.title,
        source: i.daily
          ? `每日副本 ${i.daily.copyId} · ${i.daily.sourceDate}`
          : i.definition
            ? `行动定义 ${i.definition.id} v${i.definition.version}`
            : '独立行动',
        detail: [
          `实例 ID ${id} · v${i.version}`,
          i.currentContent.criteria,
          ...(i.daily?.slotSelections.map((s) => `${s.slotId}：${s.entrySnapshot.title}`) ?? []),
        ].join('\n'),
        expiresAt: null,
        usableInToday: true,
        unavailableReason: null,
        selection: { kind: 'legacy' as const, instanceId: id },
      },
    ];
  });
}
export const handUnavailableText = (reason: V06ErrorCode | 'INCOMPLETE' | null) =>
  reason === 'MATERIAL_EXPIRED'
    ? '素材已到期'
    : reason === 'INCOMPLETE'
      ? '必填字段尚未补全，请先合成'
      : reason === 'ENTRY_UNAVAILABLE'
        ? '素材不能直接打出'
        : (reason ?? '');

/** Short badge for the collapsed/at-a-glance hand view. */
export const handUnavailableBadge = (reason: V06ErrorCode | 'INCOMPLETE' | null) =>
  reason === 'MATERIAL_EXPIRED'
    ? '已到期'
    : reason === 'INCOMPLETE'
      ? '待补字段'
      : reason === 'ENTRY_UNAVAILABLE'
        ? '不可直接打出'
        : '不可用';
