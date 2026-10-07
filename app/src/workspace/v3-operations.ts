import type {
  Command,
  EntityRef,
  History,
  Instance,
  Json,
  VersionRef,
  ErrorCode,
} from './contracts.ts';
import type { DataV3, DailyCopy } from './contracts-v3.ts';
import type { V3Capable } from './contracts-v4.ts';
import {
  ActionDomainError,
  assertActionTransition,
  type TransitionContext,
} from '../daily/model.ts';
import { assertDate, assertInstant, dateAt, nextDate } from '../daily/time.ts';
import { prepareWorkshopChange, type WorkshopCatalog } from '../workshop/model.ts';
import {
  composeDailyCopy,
  runDailyGeneration,
  runManualGeneration,
  planArchive,
  type GenerationOutcome,
} from '../drawing/model.ts';
import { historicalWorkshopEntity, workshopCatalog, workshopKinds } from './workshop-history.ts';

type V3Type =
  | 'SaveActionCard'
  | 'SaveBookEntry'
  | 'SavePool'
  | 'SaveGenerationRule'
  | 'GenerateDailyCopies'
  | 'ArchiveDueCopies'
  | 'AcceptDailyCopy';
export type V3Command = Extract<Command, { type: V3Type }>;
const types: readonly string[] = [
  'SaveActionCard',
  'SaveBookEntry',
  'SavePool',
  'SaveGenerationRule',
  'GenerateDailyCopies',
  'ArchiveDueCopies',
  'AcceptDailyCopy',
];
export const isV3Command = (command: Command): command is V3Command => types.includes(command.type);
function need(condition: unknown, code: ErrorCode, message: string): asserts condition {
  if (!condition) throw new ActionDomainError(code, message);
}
type Change<T = DataV3> = Readonly<{ data: T; resultRefs: readonly EntityRef[]; changed: boolean }>;
function history(
  context: TransitionContext,
  type: string,
  entity: EntityRef,
  before: unknown,
  after: unknown,
  suffix: string,
): History {
  return {
    id: `${context.historyId}:${suffix}`,
    commandId: context.commandId,
    at: context.at,
    date: context.date,
    type,
    entity,
    before: structuredClone(before) as Json,
    after: structuredClone(after) as Json,
  };
}
export function saveWorkshopCatalog<C extends V3Capable>(
  data: C,
  candidate: WorkshopCatalog,
  context: TransitionContext,
  type: string,
): Change<C> {
  const prepared = prepareWorkshopChange(workshopCatalog(data), candidate, { at: context.at });
  if (!prepared.ok)
    throw new ActionDomainError(
      'INVALID_INPUT',
      prepared.issues.map((i) => `${i.path}: ${i.message}`).join('; '),
    );
  const logs = prepared.value.revisions.map((revision, index) =>
    history(
      context,
      type,
      { kind: workshopKinds[revision.collection], id: revision.after.id },
      revision.before,
      revision.after,
      `workshop-${index}`,
    ),
  );
  return {
    data: {
      ...data,
      ...prepared.value.catalog,
      planner: { ...data.planner, history: [...data.planner.history, ...logs] },
    } as C,
    resultRefs: logs.map((log) => log.entity),
    changed: logs.length > 0,
  };
}
export function generationFor(
  data: V3Capable,
  target: Extract<V3Command, { type: 'GenerateDailyCopies' }>['payload']['target'],
  at: string,
  newId: () => string,
): GenerationOutcome {
  assertInstant(at);
  if (target !== 'current') {
    assertDate(target.date);
    const currentRule = data.generationRules.find((r) => r.id === target.ruleId);
    need(currentRule, 'RULE_NOT_FOUND', '生成规则不存在');
    need(currentRule.status === 'active', 'RULE_NOT_ACTIVE', '生成规则已暂停或归档');
    const today = dateAt(at, currentRule.zone);
    need(target.date <= today, 'FUTURE_DATE', '不能补生成未来日期');
    need(
      target.date >= nextDate(today, -6),
      'DATE_OUTSIDE_RETENTION',
      '超出七天保留期，不能补生成',
    );
    const rule = historicalWorkshopEntity(
      data,
      'generationRules',
      currentRule.id,
      target.date,
      currentRule.zone,
      at,
    );
    need(rule, 'VERSION_HISTORY_UNAVAILABLE', '该来源日没有可核对的规则版本');
    const card = historicalWorkshopEntity(
      data,
      'actionCards',
      rule.actionCardId,
      target.date,
      rule.zone,
      at,
    );
    need(card, 'VERSION_HISTORY_UNAVAILABLE', '该来源日没有可核对的原卡版本');
    const result = runManualGeneration(
      { rules: [rule], actionCards: [card], ledger: data.generationLedger, at, newId },
      target,
    );
    if (!result.ok) throw new ActionDomainError(result.code, result.message);
    return result.value;
  }
  return runDailyGeneration({
    rules: data.generationRules,
    actionCards: data.actionCards,
    ledger: data.generationLedger,
    at,
    newId,
  });
}
export function activeCopy(data: V3Capable, ref: VersionRef, at: string): DailyCopy {
  const copy = data.dailyCopies.find((c) => c.id === ref.id);
  need(
    copy,
    data.archiveLogs.some((log) => log.copyId === ref.id) ? 'COPY_EXPIRED' : 'COPY_NOT_FOUND',
    '副本不存在或已归档',
  );
  need(copy.version === ref.version, 'REVISION_CONFLICT', '副本已改变，请重新载入');
  const rule = data.generationRules.find((r) => r.id === copy.ruleId);
  need(
    rule && dateAt(at, rule.zone) < nextDate(copy.sourceDate, 7),
    'COPY_EXPIRED',
    '副本已经到期',
  );
  return copy;
}
export function applyV3Command(
  data: DataV3,
  command: V3Command,
  context: TransitionContext,
  newId: () => string,
): Change {
  assertInstant(context.at);
  assertDate(context.date);
  let result: Change;
  if (
    command.type === 'SaveActionCard' ||
    command.type === 'SaveBookEntry' ||
    command.type === 'SavePool' ||
    command.type === 'SaveGenerationRule'
  ) {
    const collection =
      command.type === 'SaveActionCard'
        ? 'actionCards'
        : command.type === 'SaveBookEntry'
          ? 'bookEntries'
          : command.type === 'SavePool'
            ? 'pools'
            : 'generationRules';
    const item =
      'actionCard' in command.payload
        ? command.payload.actionCard
        : 'bookEntry' in command.payload
          ? command.payload.bookEntry
          : 'pool' in command.payload
            ? command.payload.pool
            : command.payload.generationRule;
    const previous = data[collection].find((v) => v.id === item.id);
    need(
      previous
        ? previous.version === command.payload.expectedVersion
        : command.payload.expectedVersion === null,
      'REVISION_CONFLICT',
      '工坊对象版本已改变',
    );
    const next = {
      ...workshopCatalog(data),
      [collection]: previous
        ? data[collection].map((v) => (v.id === item.id ? item : v))
        : [...data[collection], item],
    };
    result = saveWorkshopCatalog(data, next as WorkshopCatalog, context, command.type);
  } else if (command.type === 'GenerateDailyCopies') {
    const outcome = generationFor(data, command.payload.target, context.at, newId);
    result = {
      data: {
        ...data,
        dailyCopies: [...data.dailyCopies, ...outcome.copies],
        generationLedger: [...data.generationLedger, ...outcome.ledgerEntries],
        planner: {
          ...data.planner,
          history: [
            ...data.planner.history,
            ...outcome.copies.map((copy, i) =>
              history(
                context,
                command.type,
                { kind: 'daily-copy', id: copy.id },
                null,
                copy,
                `copy-${i}`,
              ),
            ),
          ],
        },
      },
      resultRefs: outcome.copies.map((copy) => ({ kind: 'daily-copy', id: copy.id })),
      changed: outcome.copies.length > 0,
    };
  } else if (command.type === 'AcceptDailyCopy') {
    const copy = activeCopy(data, command.payload.copy, context.at);
    const preview = composeDailyCopy(
      copy,
      command.payload.selections,
      data.bookEntries,
      data.pools,
      context.at,
    );
    need(preview.ready, 'REQUIRED_SLOT_EMPTY', '请填写全部必填槽位');
    need(
      preview.composedText === command.payload.composedText,
      'INVALID_INPUT',
      '组合文字与已选词条不一致，请重新预览',
    );
    const content = { ...structuredClone(copy.contentSnapshot), title: preview.composedText };
    const instance: Instance = {
      id: newId(),
      version: 1,
      definition: null,
      creationSnapshot: content,
      currentContent: structuredClone(content),
      source: { kind: 'daily-copy', id: copy.id },
      createdAt: context.at,
      targetDate: null,
      state: 'open',
      occurrenceId: null,
      makeupOf: null,
      daily: {
        copyId: copy.id,
        sourceDate: copy.sourceDate,
        slotSelections: structuredClone(preview.selections),
      },
    };
    const nextCopy = {
      ...copy,
      version: copy.version + 1,
      acceptedInstanceIds: [...copy.acceptedInstanceIds, instance.id],
    };
    result = {
      data: {
        ...data,
        dailyCopies: data.dailyCopies.map((c) => (c.id === copy.id ? nextCopy : c)),
        planner: {
          ...data.planner,
          instances: [...data.planner.instances, instance],
          handOrder: [...data.planner.handOrder, instance.id],
          history: [
            ...data.planner.history,
            history(
              context,
              command.type,
              { kind: 'instance', id: instance.id },
              null,
              instance,
              'accept',
            ),
            history(
              context,
              command.type,
              { kind: 'daily-copy', id: copy.id },
              copy,
              nextCopy,
              'copy',
            ),
          ],
        },
      },
      resultRefs: [{ kind: 'instance', id: instance.id }],
      changed: true,
    };
  } else {
    const plan = planArchive({
      copies: data.dailyCopies,
      rules: data.generationRules,
      asOf: context.at,
      newId,
    });
    const logs = plan.logs.map((log) => ({
      ...log,
      slotSelectionsSnapshot: log.acceptedInstanceIds.flatMap(
        (id) => data.planner.instances.find((i) => i.id === id)?.daily?.slotSelections ?? [],
      ),
    }));
    const released = new Set(plan.instanceIdsToRelease),
      due = new Set(plan.dueCopyIds);
    const plans = data.planner.plans.map((p) =>
      p.status === 'active' && released.has(p.instanceId)
        ? { ...p, status: 'retracted' as const, version: p.version + 1, changedAt: context.at }
        : p,
    );
    const logHistory = logs.map((log, i) =>
      history(
        context,
        command.type,
        { kind: 'archive-log', id: log.id },
        data.dailyCopies.find((c) => c.id === log.copyId),
        log,
        `archive-${i}`,
      ),
    );
    const planHistory = plans.flatMap((p, i) =>
      p === data.planner.plans[i]
        ? []
        : [
            history(
              context,
              command.type,
              { kind: 'plan', id: p.id },
              data.planner.plans[i],
              p,
              `plan-${i}`,
            ),
          ],
    );
    result = {
      data: {
        ...data,
        dailyCopies: data.dailyCopies.filter((c) => !due.has(c.id)),
        archiveLogs: [...data.archiveLogs, ...logs],
        planner: {
          ...data.planner,
          plans,
          handOrder: data.planner.handOrder.filter((id) => !released.has(id)),
          history: [...data.planner.history, ...logHistory, ...planHistory],
        },
      },
      resultRefs: logs.map((log) => ({ kind: 'archive-log', id: log.id })),
      changed: logs.length > 0,
    };
  }
  assertActionTransition(data, result.data);
  return result;
}
