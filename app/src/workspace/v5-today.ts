/** Planner adapter: reuse the established time/overlap rules; preserve v5 history. */
import type { Command, Token, Range, EntityRef } from './contracts.ts';
import type { DataV5, V06EntityRef, ReferencePlacement, AnswerSnapshot } from './contracts-v06.ts';
import type { ActionOperation } from '../daily/model.ts';
import { projectUnifiedHand } from '../daily/model.ts';
import { applyAction } from '../daily/model.ts';
import { compatibilityFor, projectDay } from '../daily/projection.ts';
import { dateAt, compareInstants } from '../daily/time.ts';
import { legacyValidationView } from './v5-format.ts';
import { needV5, materialContext } from './v5-operations.ts';
import { prepareAttachedReferenceReturn, snapshotAttachedAnswers } from '../decision/model.ts';
import { assertV06WritableDate, assertV06WritableRange } from './v06-readonly.ts';

export const todayTypes = new Set([
  'SaveSettings',
  'CreateCapture',
  'SetCaptureStatus',
  'UpdateDay',
  'SaveTemplate',
  'SaveRule',
  'SaveProject',
  'SaveGoal',
  'PrepareDay',
  'SaveDefinition',
  'ArchiveDefinition',
  'AcceptOffer',
  'ResolveCaptureToAction',
  'ReorderHand',
  'WithdrawInstance',
  'ReturnWithdrawnToHand',
  'RetractPlan',
  'AppendAnnotation',
  'CreateMakeup',
  'UpdateOpenInstance',
  'CancelFixed',
  'ApplyDayTemplate',
  'CommitPlacement',
  'ConfirmActual',
]);
export function plannerView(data: DataV5) {
  return legacyValidationView(data);
}
export function todayView(
  data: DataV5,
  token: Token,
  input: { date: string; zone: string },
  at: string,
) {
  const day = projectDay(
    { mode: 'current', token, data: plannerView(data), raw: null, rawKey: '' },
    input,
    at,
  );
  const attached = data.referencePlacements.filter(
    (r) => r.state === 'active' && r.mode === 'attached',
  );
  const eligible = new Set(
    projectUnifiedHand(data, at)
      .filter((x) => x.usableInToday && (x.card.kind === 'action' || x.card.kind === 'composite'))
      .map(
        (x) =>
          (x.card as Extract<DataV5['handCards'][number], { kind: 'action' | 'composite' }>)
            .actionInstanceId,
      ),
  );
  return {
    ...day,
    hand: day.hand.filter(
      (i) =>
        !data.handCards.some(
          (c) =>
            (c.kind === 'action' || c.kind === 'composite') && c.actionInstanceId === i.instanceId,
        ) || eligible.has(i.instanceId),
    ),
    references: data.referencePlacements
      .filter((r) => r.state === 'active')
      .flatMap<{ reference: ReferencePlacement; answer: AnswerSnapshot; range: Range | null }>(
        (r) => {
          const answer = data.handCards.find((c) => c.id === r.answerId);
          if (answer?.kind !== 'answer') return [];
          if (r.mode === 'point')
            return dateAt(r.point.at, input.zone) === input.date
              ? [{ reference: r, answer: answer.answer, range: null }]
              : [];
          const plan = day.plans.find((p) => p.instanceId === r.targetInstanceId);
          return plan ? [{ reference: r, answer: answer.answer, range: plan.range }] : [];
        },
      ),
    factAnswers: day.facts.map((f) => ({
      factId: f.factId,
      answers: data.factReferenceSnapshots.find((s) => s.factId === f.factId)?.answers ?? [],
    })),
    attachedCount: attached.length,
  };
}
export function applyToday(
  data: DataV5,
  command: Command,
  operation: ActionOperation,
  at: string,
): { data: DataV5; resultRefs: readonly (V06EntityRef | EntityRef)[] } {
  const context = materialContext(data),
    view = plannerView(data);
  const instanceId =
    'instance' in operation
      ? operation.instance.id
      : operation.type === 'RetractPlan' || operation.type === 'MovePlan'
        ? data.planner.plans.find((p) => p.id === operation.plan.id)?.instanceId
        : null;
  if ('range' in operation) assertV06WritableRange(data, operation.range);
  if (operation.type === 'UpdateInstance' && operation.replacementRange)
    assertV06WritableRange(data, operation.replacementRange);
  if (operation.type === 'UpdateDay') assertV06WritableDate(data, operation.date);
  if (operation.type === 'ApplyCalendar') {
    assertV06WritableDate(data, operation.day.date);
    for (const fixed of operation.fixed) assertV06WritableRange(data, fixed.range);
  }
  // Dependencies explicitly retained in the active workspace can still move to
  // an active day or be withdrawn. Only the new destination is read-only;
  // records removed into a ZIP have no active identity to mutate.
  const material = data.handCards.find(
    (c) => (c.kind === 'action' || c.kind === 'composite') && c.actionInstanceId === instanceId,
  );
  if (material) {
    needV5(
      material.state === 'available' && material.consumedBy === null,
      'MATERIAL_CONSUMED',
      '已消费或退出素材不能重新安排、收回或复活',
    );
    needV5(
      material.expiresAt === null || compareInstants(at, material.expiresAt) < 0,
      'MATERIAL_EXPIRED',
      '每日素材已经到期',
    );
    if (operation.type === 'PlaceInstance' || operation.type === 'ConfirmActual') {
      needV5(
        material.kind === 'action' || material.kind === 'composite',
        'INVALID_INPUT',
        '需要行动素材',
      );
      needV5(
        material.fieldSpecs.every(
          (f) =>
            !f.required ||
            material.fieldValues.some(
              (v) =>
                v.fieldId === f.id &&
                v.value !== null &&
                (typeof v.value !== 'string' || !!v.value.trim()),
            ),
        ),
        'INVALID_INPUT',
        '先补齐必填字段再打出',
      );
    }
    if ('range' in operation)
      needV5(
        material.expiresAt === null ||
          compareInstants(operation.range.startAt, material.expiresAt) < 0,
        'MATERIAL_EXPIRED',
        '安排开始时间不能越过素材到期点',
      );
    if (operation.type === 'UpdateInstance')
      needV5(
        JSON.stringify(operation.content) ===
          JSON.stringify(data.planner.instances.find((i) => i.id === instanceId)?.currentContent),
        'INVALID_INPUT',
        '本次卡牌内容是冻结快照，请从原卡重新取得素材',
      );
  }
  // A movement must still fit all attached answers' expiry bounds.
  if (operation.type === 'MovePlan')
    for (const r of data.referencePlacements.filter(
      (r) => r.state === 'active' && r.mode === 'attached' && r.targetInstanceId === instanceId,
    )) {
      const answer = data.handCards.find((c) => c.id === r.answerId)!;
      needV5(
        answer.expiresAt === null ||
          (compareInstants(at, answer.expiresAt) < 0 &&
            compareInstants(operation.range.startAt, answer.expiresAt) < 0),
        'MATERIAL_EXPIRED',
        '新安排越过贴附答案到期点',
      );
    }
  const instance = data.planner.instances.find((i) => i.id === instanceId);
  const returned =
    operation.type === 'RetractPlan' && instance
      ? prepareAttachedReferenceReturn({ context, instance, at })
      : null;
  const frozen =
    operation.type === 'ConfirmActual'
      ? snapshotAttachedAnswers({
          context,
          instance: operation.instance,
          factId: operation.factId,
          at,
        })
      : null;
  const range =
    'range' in operation
      ? operation.range
      : operation.type === 'UpdateInstance'
        ? operation.replacementRange
        : undefined;
  const change = applyAction(view, operation, {
    at,
    date: dateAt(at, data.settings.zone ?? 'UTC'),
    commandId: command.commandId,
    historyId: `${command.commandId}:planner`,
    compatibility: compatibilityFor(view, range),
  });
  const logs = change.data.planner.history.slice(view.planner.history.length),
    refs: (V06EntityRef | EntityRef)[] = [...change.resultRefs];
  let next: DataV5 = {
    ...data,
    settings: change.data.settings,
    planner: { ...change.data.planner, history: [...data.planner.history, ...logs] },
    factReferenceSnapshots: frozen
      ? [...data.factReferenceSnapshots, frozen]
      : data.factReferenceSnapshots,
  };
  for (const r of returned?.references ?? []) {
    const before = data.referencePlacements.find((x) => x.id === r.id)!;
    const entity = { kind: 'reference-placement' as const, id: r.id };
    refs.push(entity);
    next = {
      ...next,
      referencePlacements: next.referencePlacements.map((x) => (x.id === r.id ? r : x)),
      planner: {
        ...next.planner,
        history: [
          ...next.planner.history,
          {
            id: `${command.commandId}:return:${r.id}`,
            commandId: command.commandId,
            type: command.type,
            at,
            date: dateAt(at, data.settings.zone ?? 'UTC'),
            entity,
            before,
            after: r,
          },
        ],
      },
    };
  }
  for (const id of returned?.expiredAnswerIds ?? []) {
    const before = next.handCards.find((c) => c.id === id)!;
    if (before.state === 'expired') continue;
    const after = { ...before, version: before.version + 1, state: 'expired' as const },
      entity = { kind: 'hand-card' as const, id };
    refs.push(entity);
    next = {
      ...next,
      handCards: next.handCards.map((c) => (c.id === id ? after : c)),
      planner: {
        ...next.planner,
        history: [
          ...next.planner.history,
          {
            id: command.commandId + ':expired:' + id,
            commandId: command.commandId,
            type: command.type,
            at,
            date: dateAt(at, data.settings.zone ?? 'UTC'),
            entity,
            before,
            after,
          },
        ],
      },
    };
  }
  return { data: next, resultRefs: refs };
}
