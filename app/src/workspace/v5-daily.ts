/** Daily stock keeps the established seven-day rule; generic fields stay frozen. */
import type { Command, Token, VersionRef, EntityRef } from './contracts.ts';
import type {
  DataV5,
  DailyCopyV5,
  DailyArchiveLogV5,
  V06History,
  V06EntityRef,
  HandCard,
} from './contracts-v06.ts';
import {
  createActionMaterial,
  prepareAttachedReferenceReturn,
  prepareReferenceReturn,
} from '../decision/model.ts';
import { dateAt, dayRange, nextDate, weekday, compareInstants } from '../daily/time.ts';
import { legacyValidationView } from './v5-format.ts';
import { applyV3CommandOnV4 } from './v4-operations.ts';
import { needV5, sourceAction, materialContext } from './v5-operations.ts';

export type TakeDailyMaterialCommand = Readonly<{
  contractVersion: 'v06-b7-1';
  commandId: string;
  expected: Token;
  type: 'TakeDailyMaterial';
  payload: { copy: VersionRef };
}>;
export type DailyCommand =
  | Extract<Command, { type: 'GenerateDailyCopies' | 'ArchiveDueCopies' | 'AcceptDailyCopy' }>
  | TakeDailyMaterialCommand;
export function applyDaily(
  data: DataV5,
  cmd: DailyCommand,
  at: string,
  id: () => string,
): { data: DataV5; resultRefs: readonly (V06EntityRef | EntityRef)[] } {
  let next = structuredClone(data),
    refs: (V06EntityRef | EntityRef)[] = [];
  const log = (entity: V06EntityRef | V06History['entity'], before: unknown, after: unknown) => {
    next = {
      ...next,
      planner: {
        ...next.planner,
        history: [
          ...next.planner.history,
          {
            id: `${cmd.commandId}:${refs.length}`,
            commandId: cmd.commandId,
            type: cmd.type,
            at,
            date: dateAt(at, data.settings.zone ?? 'UTC'),
            entity,
            before: structuredClone(before) as any,
            after: structuredClone(after) as any,
          },
        ],
      },
    };
    refs.push(entity);
  };
  const take = (copy: DailyCopyV5) => {
    const rule = data.generationRules.find((r) => r.id === copy.ruleId);
    needV5(rule, 'INVALID_INPUT', '来源规则不存在');
    const expiresAt = dayRange(nextDate(copy.sourceDate, 7), rule.zone).startAt;
    needV5(compareInstants(at, expiresAt) < 0, 'COPY_EXPIRED', '每日副本已到期');
    const action = sourceAction(data, copy.actionCard),
      instanceId = id();
    const base = createActionMaterial({
        id: id(),
        at,
        action,
        origin: {
          kind: 'daily-copy',
          copy: { id: copy.id, version: 1 },
          sourceDate: copy.sourceDate,
          zone: rule.zone,
          expiresAt,
        },
      }),
      card = { ...base, actionInstanceId: instanceId };
    // The proven daily source lives in the new HandCard; retain the old Instance shape.
    const instance = {
      id: instanceId,
      version: 1,
      definition: null,
      creationSnapshot: action.content,
      currentContent: action.content,
      source: { kind: 'manual' as const },
      createdAt: at,
      targetDate: null,
      state: 'open' as const,
      occurrenceId: null,
      makeupOf: null,
    };
    next = {
      ...next,
      handCards: [...next.handCards, card],
      planner: {
        ...next.planner,
        instances: [...next.planner.instances, instance],
        handOrder: [...next.planner.handOrder, instanceId],
      },
    };
    const after = {
      ...copy,
      version: copy.version + 1,
      acceptedInstanceIds: [...copy.acceptedInstanceIds, instanceId],
    };
    next = { ...next, dailyCopies: next.dailyCopies.map((c) => (c.id === copy.id ? after : c)) };
    log({ kind: 'instance', id: instanceId }, null, instance);
    log({ kind: 'hand-card', id: card.id }, null, card);
    log({ kind: 'daily-copy', id: copy.id }, copy, after);
  };
  if (cmd.type === 'TakeDailyMaterial') {
    const copy = data.dailyCopies.find((c) => c.id === cmd.payload.copy.id);
    needV5(
      copy && copy.version === cmd.payload.copy.version && 'format' in copy,
      'ENTRY_STALE',
      '每日副本已改变，旧副本请沿用原接受接口',
    );
    take(copy);
  } else if (cmd.type === 'AcceptDailyCopy') {
    const view = legacyValidationView(data),
      change = applyV3CommandOnV4(
        view,
        cmd,
        {
          at,
          date: dateAt(at, data.settings.zone ?? 'UTC'),
          commandId: cmd.commandId,
          historyId: cmd.commandId,
        },
        id,
      );
    next = {
      ...next,
      dailyCopies: [...change.data.dailyCopies, ...data.dailyCopies.filter((c) => 'format' in c)],
      planner: {
        ...change.data.planner,
        history: [
          ...data.planner.history,
          ...change.data.planner.history.slice(view.planner.history.length),
        ],
      },
    };
    refs = [...change.resultRefs];
    const instance = change.data.planner.instances.at(-1)!,
      copy = view.dailyCopies.find((c) => c.id === cmd.payload.copy.id)!,
      rule = data.generationRules.find((r) => r.id === copy.ruleId)!,
      action = sourceAction(data, copy.actionCard);
    const base = createActionMaterial({
      id: id(),
      at,
      action,
      origin: {
        kind: 'daily-copy',
        copy: { id: copy.id, version: 1 },
        sourceDate: copy.sourceDate,
        zone: rule.zone,
        expiresAt: dayRange(nextDate(copy.sourceDate, 7), rule.zone).startAt,
      },
    });
    const card: HandCard = {
      ...base,
      kind: 'composite',
      actionInstanceId: instance.id,
      contentSnapshot: instance.creationSnapshot,
      fieldValues: instance.daily!.slotSelections.map((s) => ({
        fieldId: s.slotId,
        value: s.entrySnapshot.title,
      })),
    };
    next = { ...next, handCards: [...next.handCards, card] };
    log({ kind: 'hand-card', id: card.id }, null, card);
  } else if (cmd.type === 'GenerateDailyCopies') {
    for (const current of data.generationRules.filter((r) => r.status === 'active')) {
      const date =
        cmd.payload.target === 'current' ? dateAt(at, current.zone) : cmd.payload.target.date;
      if (cmd.payload.target !== 'current' && cmd.payload.target.ruleId !== current.id) continue;
      needV5(date <= dateAt(at, current.zone), 'FUTURE_DATE', '不能生成未来副本');
      needV5(
        date >= nextDate(dateAt(at, current.zone), -6),
        'DATE_OUTSIDE_RETENTION',
        '超出七天保留期',
      );
      if (next.generationLedger.some((l) => l.ruleId === current.id && l.sourceDate === date))
        continue;
      const boundary = dayRange(nextDate(date), current.zone).startAt;
      const historical = (kind: string, key: string) =>
        data.planner.history
          .filter(
            (h) =>
              h.entity.kind === kind &&
              'id' in h.entity &&
              h.entity.id === key &&
              compareInstants(h.at, boundary) < 0 &&
              compareInstants(h.at, at) <= 0,
          )
          .at(-1)?.after as any;
      const rule = historical('generation-rule', current.id);
      needV5(rule, 'VERSION_HISTORY_UNAVAILABLE', '来源日规则历史不可用');
      if (
        rule.status !== 'active' ||
        date < rule.startDate ||
        (rule.schedule.mode === 'weekdays' && !rule.schedule.weekdays.includes(weekday(date)))
      )
        continue;
      const action = data.planner.history
        .filter(
          (h) =>
            h.entity.kind === 'action-card' &&
            'id' in h.entity &&
            h.entity.id === rule.actionCardId &&
            (h.after as any)?.fields !== undefined &&
            compareInstants(h.at, boundary) < 0 &&
            compareInstants(h.at, at) <= 0,
        )
        .at(-1)?.after as any;
      needV5(action, 'VERSION_HISTORY_UNAVAILABLE', '来源日原卡历史不可用');
      if (action.status !== 'active') continue;
      const decisions = data.decisionCards
        .map((d) => historical('decision-card', d.id))
        .filter((d) => d && d.status === 'active' && d.ownerActionId === action.id);
      const copy: DailyCopyV5 = {
        format: 'v5',
        id: id(),
        version: 1,
        ruleId: rule.id,
        ruleVersion: rule.version,
        actionCard: { id: action.id, version: action.version },
        sourceDate: date,
        generatedAt: at,
        contentSnapshot: structuredClone(action.content),
        fieldSpecsSnapshot: structuredClone(action.fields),
        decisionCardsSnapshot: structuredClone(decisions),
        status: 'active',
        acceptedInstanceIds: [],
      };
      next = {
        ...next,
        dailyCopies: [...next.dailyCopies, copy],
        generationLedger: [
          ...next.generationLedger,
          { ruleId: rule.id, sourceDate: date, copyId: copy.id, at },
        ],
      };
      log({ kind: 'daily-copy', id: copy.id }, null, copy);
    }
  } else {
    const view = legacyValidationView(data),
      change = applyV3CommandOnV4(
        view,
        cmd,
        {
          at,
          date: dateAt(at, data.settings.zone ?? 'UTC'),
          commandId: cmd.commandId,
          historyId: cmd.commandId,
        },
        id,
      );
    next = {
      ...next,
      dailyCopies: [...change.data.dailyCopies, ...data.dailyCopies.filter((c) => 'format' in c)],
      archiveLogs: [...change.data.archiveLogs, ...data.archiveLogs.filter((c) => 'format' in c)],
      planner: {
        ...change.data.planner,
        history: [
          ...data.planner.history,
          ...change.data.planner.history.slice(view.planner.history.length),
        ],
      },
    };
    refs = [...change.resultRefs];
    for (const copy of data.dailyCopies.filter((c): c is DailyCopyV5 => 'format' in c)) {
      const rule = data.generationRules.find((r) => r.id === copy.ruleId)!;
      if (dateAt(at, rule.zone) < nextDate(copy.sourceDate, 7)) continue;
      const archive: DailyArchiveLogV5 = {
        format: 'v5',
        id: id(),
        version: 1,
        copyId: copy.id,
        ruleId: copy.ruleId,
        actionCard: copy.actionCard,
        sourceDate: copy.sourceDate,
        contentSnapshot: copy.contentSnapshot,
        acceptedFieldValuesSnapshot: data.handCards.flatMap((c) =>
          (c.kind === 'action' || c.kind === 'composite') &&
          copy.acceptedInstanceIds.includes(c.actionInstanceId ?? '')
            ? c.fieldValues
            : [],
        ),
        acceptedInstanceIds: copy.acceptedInstanceIds,
        disposition: copy.acceptedInstanceIds.length ? 'accepted' : 'none-accepted',
        archivedAt: at,
      };
      next = {
        ...next,
        dailyCopies: next.dailyCopies.filter((c) => c.id !== copy.id),
        archiveLogs: [...next.archiveLogs, archive],
      };
      log({ kind: 'archive-log', id: archive.id }, copy, archive);
    }
    for (const card of next.handCards.filter(
      (c) =>
        c.state === 'available' && c.expiresAt !== null && compareInstants(at, c.expiresAt) >= 0,
    )) {
      if (card.kind === 'answer') {
        const positions = next.referencePlacements.filter(
          (r) => r.answerId === card.id && r.state === 'active',
        );
        if (
          positions.some(
            (r) =>
              r.mode === 'attached' &&
              next.planner.facts.some((f) => f.instanceId === r.targetInstanceId),
          )
        )
          continue;
        for (const position of positions) {
          const returned = prepareReferenceReturn({
            context: materialContext(next),
            reference: position,
            at,
          });
          for (const r of returned.references) {
            next = {
              ...next,
              referencePlacements: next.referencePlacements.map((x) => (x.id === r.id ? r : x)),
            };
            log({ kind: 'reference-placement', id: r.id }, position, r);
          }
        }
      }
      if (
        (card.kind === 'action' || card.kind === 'composite') &&
        next.planner.facts.some((f) => f.instanceId === card.actionInstanceId)
      )
        continue;
      if ((card.kind === 'action' || card.kind === 'composite') && card.actionInstanceId) {
        const instance = next.planner.instances.find((i) => i.id === card.actionInstanceId)!;
        const returned = prepareAttachedReferenceReturn({
          context: materialContext(next),
          instance,
          at,
        });
        for (const r of returned.references) {
          const before = next.referencePlacements.find((x) => x.id === r.id)!;
          next = {
            ...next,
            referencePlacements: next.referencePlacements.map((x) => (x.id === r.id ? r : x)),
          };
          log({ kind: 'reference-placement', id: r.id }, before, r);
        }
        for (const plan of next.planner.plans.filter(
          (p) => p.instanceId === instance.id && p.status === 'active',
        )) {
          const after = {
            ...plan,
            version: plan.version + 1,
            status: 'retracted' as const,
            changedAt: at,
          };
          next = {
            ...next,
            planner: {
              ...next.planner,
              plans: next.planner.plans.map((p) => (p.id === plan.id ? after : p)),
            },
          };
          log({ kind: 'plan', id: plan.id }, plan, after);
        }
        if (instance.state === 'open') {
          const after = { ...instance, version: instance.version + 1, state: 'withdrawn' as const };
          next = {
            ...next,
            planner: {
              ...next.planner,
              instances: next.planner.instances.map((i) => (i.id === instance.id ? after : i)),
              handOrder: next.planner.handOrder.filter((i) => i !== instance.id),
            },
          };
          log({ kind: 'instance', id: instance.id }, instance, after);
        }
      }
      const after = { ...card, version: card.version + 1, state: 'expired' as const };
      next = { ...next, handCards: next.handCards.map((c) => (c.id === card.id ? after : c)) };
      log({ kind: 'hand-card', id: card.id }, card, after);
    }
  }
  return { data: next, resultRefs: refs };
}
