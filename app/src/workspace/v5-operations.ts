/** B4 named business reducer. It runs synchronously inside the existing store transaction. */
import type {
  DataV5,
  V06History,
  V06EntityRef,
  HandCard,
  SelectedAnswer,
  FieldResolution,
  ReferenceDraft,
  CatalogV06,
} from './contracts-v06.ts';
import type { V06Command } from './ports-v06.ts';
import type { ActionCardV5 } from './contracts-v06.ts';
import { V06ContractError } from './v06-validation.ts';
import { canonicalJson } from './format.ts';
import {
  createActionMaterial,
  createEntryMaterial,
  createDecisionMaterials,
  prepareSynthesisConsumption,
  previewReferencePlacement,
  prepareReferenceReturn,
  type MaterialContext,
} from '../decision/model.ts';
import { prepareJournalNote, prepareLegacyJournalEdit } from '../journal/model.ts';
import { compareInstants, dateAt } from '../daily/time.ts';
import { catalogOf, validateV5Catalog, v5Kinds, v5CatalogKeys } from './v5-format.ts';
import { applyPlannerConfig } from './v5-config.ts';
import { assertV06WritableRange, assertV06WritablePoint } from './v06-readonly.ts';

export type BusinessGrant =
  | {
      kind: 'answer';
      selection: SelectedAnswer;
      action: ActionCardV5;
      answerId: string;
      actionId: string;
    }
  | {
      kind: 'synthesis';
      inputs: readonly [
        Readonly<{ id: string; version: number }>,
        Readonly<{ id: string; version: number }>,
      ];
      resolutions: readonly FieldResolution[];
      outputId: string;
      action: ActionCardV5;
    }
  | { kind: 'reference'; draft: ReferenceDraft; referenceId: string }
  | {
      kind: 'catalog';
      catalog: CatalogV06;
      config: import('./contracts-v06.ts').ConfigV4['config'];
    };
export const materialContext = (data: DataV5): MaterialContext => ({
  materials: data.handCards,
  instances: data.planner.instances,
  plans: data.planner.plans,
  facts: data.planner.facts,
  references: data.referencePlacements,
});
export function needV5(
  condition: unknown,
  code: ConstructorParameters<typeof V06ContractError>[0],
  message: string,
): asserts condition {
  if (!condition) throw new V06ContractError(code, '$', message);
}
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function sourceAction(data: DataV5, ref: { id: string; version: number }): ActionCardV5 {
  const source = data.planner.history.find(
    (h) =>
      h.entity.kind === 'action-card' &&
      'id' in h.entity &&
      h.entity.id === ref.id &&
      (h.after as any)?.version === ref.version &&
      (h.after as any)?.fields !== undefined,
  )?.after;
  needV5(source, 'VERSION_HISTORY_UNAVAILABLE', '找不到冻结的行动原版本');
  return structuredClone(source) as unknown as ActionCardV5;
}
export function applyV5Command(
  data: DataV5,
  command: V06Command,
  options: { at: string; id: () => string; grant?: BusinessGrant },
): { data: DataV5; resultRefs: readonly V06EntityRef[] } {
  let next = structuredClone(data) as any;
  const logs: V06History[] = [],
    refs: V06EntityRef[] = [];
  const log = (entity: V06EntityRef, before: unknown, after: unknown) => {
    logs.push({
      id: `${command.commandId}:${logs.length}`,
      commandId: command.commandId,
      type: command.type,
      at: options.at,
      date: dateAt(options.at, data.settings.zone ?? 'UTC'),
      entity,
      before: structuredClone(before) as any,
      after: structuredClone(after) as any,
    });
    if (!refs.some((r) => equal(r, entity))) refs.push(entity);
  };
  function save(key: keyof CatalogV06, value: any, expected: number | null) {
    const before = data[key].find((i) => i.id === value.id);
    needV5(
      before ? before.version === expected : expected === null,
      'ENTRY_STALE',
      '目录版本已改变',
    );
    needV5(
      value.version === (before ? before.version + 1 : 1),
      'INVALID_INPUT',
      '保存对象须采用下一版本，新对象从 1 开始',
    );
    if (before) {
      needV5(equal(value.source, before.source), 'INVALID_INPUT', '创建来源不可替换');
      const prior = data.planner.history
        .filter(
          (h) => h.entity.kind === v5Kinds[key] && 'id' in h.entity && h.entity.id === value.id,
        )
        .at(-1);
      needV5(
        !prior || compareInstants(options.at, prior.at) >= 0,
        'INVALID_INPUT',
        '保存时间不能倒退',
      );
    }
    if (before) next[key] = next[key].map((i: any) => (i.id === value.id ? value : i));
    else next[key].push(value);
    log({ kind: v5Kinds[key], id: value.id }, before ?? null, value);
  }
  const grant = options.grant;
  function take(card: HandCard) {
    needV5(
      !next.handCards.some((c: HandCard) => c.id === card.id),
      'INVALID_INPUT',
      '本次牌 ID 已占用',
    );
    if (card.kind === 'action' || card.kind === 'composite') {
      const instanceId = options.id();
      needV5(
        !next.planner.instances.some((i: any) => i.id === instanceId),
        'INVALID_INPUT',
        '实例 ID 已占用',
      );
      const instance = {
        id: instanceId,
        version: 1,
        definition: null,
        creationSnapshot: structuredClone(card.contentSnapshot),
        currentContent: structuredClone(card.contentSnapshot),
        source: { kind: 'manual' },
        createdAt: options.at,
        targetDate: null,
        state: 'open',
        occurrenceId: null,
        makeupOf: null,
      };
      next.planner.instances.push(instance);
      next.planner.handOrder.push(instanceId);
      log({ kind: 'instance', id: instanceId }, null, instance);
      card = { ...card, actionInstanceId: instanceId };
    }
    next.handCards.push(card);
    log({ kind: 'hand-card', id: card.id }, null, card);
  }
  switch (command.type) {
    case 'SaveCatalogEntry':
      save('catalogEntries', command.payload.entry, command.payload.expectedVersion);
      break;
    case 'SaveDeck':
      save('decks', command.payload.deck, command.payload.expectedVersion);
      break;
    case 'SaveActionCardV5':
      save('actionCards', command.payload.actionCard, command.payload.expectedVersion);
      break;
    case 'SaveDecisionCard':
      save('decisionCards', command.payload.decision, command.payload.expectedVersion);
      break;
    case 'MoveDeckMember': {
      const p = command.payload,
        entry = data.catalogEntries.find((e) => e.id === p.entry.id),
        from = data.decks.find((d) => d.id === p.from.id),
        to = data.decks.find((d) => d.id === p.to.id);
      needV5(
        entry &&
          entry.version === p.entry.version &&
          from &&
          from.version === p.from.version &&
          to &&
          to.version === p.to.version,
        'ENTRY_STALE',
        '条目或目录已变化',
      );
      needV5(
        from.deckKind === 'entry' && to.deckKind === 'entry' && from.memberIds.includes(entry.id),
        'INVALID_INPUT',
        '只能移动清单中已有资源',
      );
      const members = to.memberIds.filter((id) => id !== entry.id);
      needV5(p.targetIndex <= members.length, 'INVALID_INPUT', '目标位置越界');
      members.splice(p.targetIndex, 0, entry.id);
      if (from.id === to.id) {
        if (equal(from.memberIds, members)) break;
        save('decks', { ...from, version: from.version + 1, memberIds: members }, from.version);
      } else {
        save(
          'decks',
          {
            ...from,
            version: from.version + 1,
            memberIds: from.memberIds.filter((id) => id !== entry.id),
          },
          from.version,
        );
        save('decks', { ...to, version: to.version + 1, memberIds: members }, to.version);
      }
      break;
    }
    case 'TakeActionMaterial': {
      const action = data.actionCards.find((c) => c.id === command.payload.action.id);
      needV5(
        action && action.version === command.payload.action.version,
        'ENTRY_STALE',
        '行动原卡已变化',
      );
      take(createActionMaterial({ id: options.id(), at: options.at, action }));
      break;
    }
    case 'TakeEntryMaterial': {
      const entry = data.catalogEntries.find((c) => c.id === command.payload.entry.id);
      needV5(
        entry && entry.version === command.payload.entry.version,
        'ENTRY_STALE',
        '资源条目已变化',
      );
      take(createEntryMaterial({ id: options.id(), at: options.at, entry }));
      break;
    }
    case 'AcceptDecisionAnswer': {
      needV5(grant?.kind === 'answer', 'PREVIEW_STALE', '选择会话已失效');
      const prepared = createDecisionMaterials({
        answerId: grant.answerId,
        at: options.at,
        answer: grant.selection.answer,
        ...(command.payload.alsoTakeAction
          ? { action: { id: grant.actionId, card: grant.action } }
          : {}),
      });
      take(prepared.answer);
      if (prepared.action) take(prepared.action);
      break;
    }
    case 'ConfirmSynthesis': {
      needV5(grant?.kind === 'synthesis', 'PREVIEW_STALE', '合成预览已失效');
      const prepared = prepareSynthesisConsumption({
        context: materialContext(data),
        inputs: grant.inputs,
        resolutions: grant.resolutions,
        outputId: grant.outputId,
        at: options.at,
        actionSource: grant.action,
      });
      for (const consumed of prepared.consumed) {
        const before = data.handCards.find((c) => c.id === consumed.id)!;
        next.handCards = next.handCards.map((c: HandCard) => (c.id === consumed.id ? consumed : c));
        log({ kind: 'hand-card', id: consumed.id }, before, consumed);
        if (
          (consumed.kind === 'action' || consumed.kind === 'composite') &&
          consumed.actionInstanceId !== null
        ) {
          const instance = data.planner.instances.find((i) => i.id === consumed.actionInstanceId)!;
          const retired = { ...instance, version: instance.version + 1, state: 'withdrawn' };
          next.planner.instances = next.planner.instances.map((i: any) =>
            i.id === instance.id ? retired : i,
          );
          next.planner.handOrder = next.planner.handOrder.filter(
            (id: string) => id !== instance.id,
          );
          log({ kind: 'instance', id: instance.id }, instance, retired);
        }
      }
      take(prepared.output);
      break;
    }
    case 'ReorderUnifiedHand': {
      const available = data.handCards.filter(
        (c) =>
          c.state === 'available' &&
          !data.referencePlacements.some((r) => r.state === 'active' && r.answerId === c.id) &&
          !(
            (c.kind === 'action' || c.kind === 'composite') &&
            c.actionInstanceId &&
            !data.planner.handOrder.includes(c.actionInstanceId)
          ),
      );
      needV5(
        command.payload.cardIds.length === available.length &&
          command.payload.cardIds.every((id) => available.some((c) => c.id === id)),
        'INVALID_INPUT',
        '排序须覆盖所有当前可持有本次牌',
      );
      const ordered = command.payload.cardIds.map((id) => available.find((c) => c.id === id)!);
      let index = 0;
      next.handCards = data.handCards.map((c) => (available.includes(c) ? ordered[index++] : c));
      if (!equal(next.handCards, data.handCards) && available.length)
        log(
          { kind: 'hand-card', id: available[0].id },
          available.map((c) => c.id),
          command.payload.cardIds,
        );
      break;
    }
    case 'CommitReferencePlacement': {
      needV5(grant?.kind === 'reference', 'PREVIEW_STALE', '参考预览已失效');
      const prepared = previewReferencePlacement({
        context: materialContext(data),
        draft: grant.draft,
        referenceId: grant.referenceId,
        at: options.at,
      });
      if (prepared.placement.mode === 'point')
        assertV06WritablePoint(data, prepared.placement.point.at);
      else {
        const instanceId = prepared.placement.targetInstanceId,
          plan = data.planner.plans.find(
            (p) => p.instanceId === instanceId && p.status === 'active',
          );
        if (plan) assertV06WritableRange(data, plan.range);
      }
      next.referencePlacements.push(prepared.placement);
      log({ kind: 'reference-placement', id: prepared.placement.id }, null, prepared.placement);
      break;
    }
    case 'RetractReference': {
      const prepared = prepareReferenceReturn({
        context: materialContext(data),
        reference: command.payload.reference,
        at: options.at,
      });
      for (const reference of prepared.references) {
        const before = data.referencePlacements.find((r) => r.id === reference.id)!;
        next.referencePlacements = next.referencePlacements.map((r: any) =>
          r.id === reference.id ? reference : r,
        );
        log({ kind: 'reference-placement', id: reference.id }, before, reference);
      }
      for (const id of prepared.expiredAnswerIds) {
        const before = data.handCards.find((c) => c.id === id)!;
        if (before.state !== 'expired') {
          const after = { ...before, version: before.version + 1, state: 'expired' };
          next.handCards = next.handCards.map((c: HandCard) => (c.id === id ? after : c));
          log({ kind: 'hand-card', id }, before, after);
        }
      }
      break;
    }
    case 'SaveJournalNote': {
      const prepared = prepareJournalNote({
        command,
        notes: data.journalNotes,
        context: {
          at: options.at,
          workspaceZone: data.settings.zone,
          access: 'live',
          archiveDates: data.archiveIndex.flatMap((a) => a.coveredDates),
        },
        newId: options.id,
      });
      if (prepared.changed && prepared.after) {
        next.journalNotes = prepared.before
          ? next.journalNotes.map((n: any) => (n.id === prepared.after!.id ? prepared.after : n))
          : [...next.journalNotes, prepared.after];
        log({ kind: 'journal-note', id: prepared.after.id }, prepared.before, prepared.after);
      }
      break;
    }
    case 'SaveLegacyJournalBlock': {
      const prepared = prepareLegacyJournalEdit({
        command,
        entries: data.journalEntries,
        context: {
          at: options.at,
          workspaceZone: data.settings.zone,
          access: 'live',
          archiveDates: data.archiveIndex.flatMap((a) => a.coveredDates),
        },
      });
      if (prepared.changed && prepared.after) {
        next.journalEntries = next.journalEntries.map((n: any) =>
          n.id === prepared.after!.id ? prepared.after : n,
        );
        log({ kind: 'journal-entry', id: prepared.after.id }, prepared.before, prepared.after);
      }
      break;
    }
    case 'ImportCatalogV4': {
      needV5(grant?.kind === 'catalog', 'PREVIEW_STALE', '配置预览已失效');
      next = applyPlannerConfig(
        data,
        grant.config,
        command.payload.mode,
        command.commandId,
        options.at,
      );
      for (const key of v5CatalogKeys) {
        if (command.payload.mode === 'replace')
          for (const old of data[key])
            if (!grant.catalog[key].some((i) => i.id === old.id)) {
              const value =
                key === 'decks' ? { ...old, memberIds: [] } : { ...old, status: 'archived' };
              if (!equal(old, value))
                save(key, { ...value, version: old.version + 1 }, old.version);
            }
        for (const incoming of grant.catalog[key]) {
          const old = data[key].find((i) => i.id === incoming.id);
          const value = {
            ...incoming,
            version: old?.version ?? 1,
            source: old?.source ?? { kind: 'manual' },
          };
          if (!old || !equal(old, value))
            save(key, { ...value, version: old ? old.version + 1 : 1 }, old?.version ?? null);
        }
      }
      break;
    }
    case 'CommitMonthlyArchive':
      throw new V06ContractError(
        'CONTRACT_NOT_IMPLEMENTED',
        '$',
        '月度 ZIP 导出核验及清理在 B11 接入',
      );
  }
  next.planner.history.push(...logs);
  validateV5Catalog(catalogOf(next), next.planner.history, true);
  return { data: next as DataV5, resultRefs: refs };
}
