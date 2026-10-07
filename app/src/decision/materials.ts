import type {
  ActionCardV5,
  AnswerSnapshot,
  CatalogEntry,
  FieldSpec,
  FieldValue,
  HandCard,
  Provenance,
} from '../workspace/v06.ts';
import type { Content, VersionRef } from '../workspace/index.ts';
import { validateV06Dto } from '../workspace/v06.ts';
import {
  assertDate,
  assertInstant,
  assertZone,
  compareInstants,
  dateAt,
  dayRange,
  nextDate,
} from '../daily/time.ts';
import {
  fail,
  id,
  ref,
  validateAction,
  validateAnswer,
  validateFieldValues,
} from './rule-checks.ts';

export type ActionMaterial = Extract<HandCard, { kind: 'action' }>;
export type AnswerMaterial = Extract<HandCard, { kind: 'answer' }>;
export type EntryMaterial = Extract<HandCard, { kind: 'entry' }>;
export type DailyOrigin = Extract<Provenance, { kind: 'daily-copy' }>;
function base(
  materialId: string,
  at: string,
  provenance: readonly Provenance[],
  expiresAt: string | null,
) {
  id(materialId, 'id');
  assertInstant(at);
  if (expiresAt !== null && compareInstants(at, expiresAt) >= 0)
    fail('MATERIAL_EXPIRED', 'expiresAt', '已到期素材不能重新拿出');
  return {
    id: materialId,
    version: 1,
    state: 'available' as const,
    createdAt: at,
    provenance: structuredClone(provenance),
    inputIds: [],
    expiresAt,
    consumedBy: null,
  };
}
function validateOrigin(origin: DailyOrigin, at: string): void {
  ref(origin.copy, 'origin.copy');
  assertDate(origin.sourceDate);
  assertZone(origin.zone);
  assertInstant(origin.expiresAt);
  if (
    compareInstants(
      origin.expiresAt,
      dayRange(nextDate(origin.sourceDate, 7), origin.zone).startAt,
    ) !== 0
  )
    fail('INVALID_INPUT', 'origin.expiresAt', '到期时刻须保持原来源日 D+7 的冻结时区日界');
  if (origin.sourceDate > dateAt(at, origin.zone))
    fail('INVALID_INPUT', 'origin.sourceDate', '不能把未来副本作为当前素材拿出');
}
/** Caller provides the frozen daily expiry; taking a card never recomputes it from today's date. */
export function createActionMaterial(
  input: Readonly<{ id: string; at: string; action: ActionCardV5; origin?: DailyOrigin }>,
): ActionMaterial {
  validateAction(input.action);
  if (input.action.status !== 'active') fail('ENTRY_UNAVAILABLE', 'action', '行动原卡已停用');
  if (input.origin) validateOrigin(input.origin, input.at);
  const owner = { id: input.action.id, version: input.action.version };
  const provenance: readonly Provenance[] = input.origin
    ? [input.origin]
    : [{ kind: 'manual', source: owner }];
  return {
    ...base(input.id, input.at, provenance, input.origin?.expiresAt ?? null),
    kind: 'action',
    actionInstanceId: null,
    ownerAction: owner,
    contentSnapshot: structuredClone(input.action.content),
    fieldSpecs: structuredClone(input.action.fields),
    fieldValues: [],
  };
}
export function createEntryMaterial(
  input: Readonly<{ id: string; at: string; entry: CatalogEntry }>,
): EntryMaterial {
  validateV06Dto('entry', input.entry);
  if (input.entry.status !== 'active') fail('ENTRY_UNAVAILABLE', 'entry', '条目已归档');
  return {
    ...base(
      input.id,
      input.at,
      [{ kind: 'manual', source: { id: input.entry.id, version: input.entry.version } }],
      null,
    ),
    kind: 'entry',
    entrySnapshot: structuredClone(input.entry),
  };
}
export function createAnswerMaterial(
  input: Readonly<{ id: string; at: string; answer: AnswerSnapshot }>,
): AnswerMaterial {
  validateAnswer(input.answer);
  if (compareInstants(input.answer.selectedAt, input.at) > 0)
    fail('INVALID_INPUT', 'answer.selectedAt', '选择时间不能晚于拿牌时间');
  return {
    ...base(input.id, input.at, [{ kind: 'answer', snapshot: input.answer }], null),
    kind: 'answer',
    answer: structuredClone(input.answer),
  };
}
/** Default answer-only; the optional action is explicit and both drafts are returned together. */
export function createDecisionMaterials(
  input: Readonly<{
    answerId: string;
    at: string;
    answer: AnswerSnapshot;
    action?: Readonly<{ id: string; card: ActionCardV5; origin?: DailyOrigin }>;
  }>,
): Readonly<{ answer: AnswerMaterial; action: ActionMaterial | null }> {
  if (input.action) {
    if (input.answerId === input.action.id)
      fail('INVALID_INPUT', 'id', '两张本次牌必须使用不同 ID');
    assertSameActionOwner(input.answer.ownerAction, {
      id: input.action.card.id,
      version: input.action.card.version,
    });
    validateFieldValues(input.action.card.fields, input.answer.fieldValues);
  }
  const answer = createAnswerMaterial({ id: input.answerId, at: input.at, answer: input.answer });
  const action = input.action
    ? createActionMaterial({
        id: input.action.id,
        at: input.at,
        action: input.action.card,
        origin: input.action.origin,
      })
    : null;
  return { answer, action };
}
export function assertSameActionOwner(left: VersionRef, right: VersionRef): void {
  ref(left, 'ownerAction');
  ref(right, 'ownerAction');
  if (left.id !== right.id)
    fail('ACTION_OWNER_MISMATCH', 'ownerAction', '只能组合相同行动原卡的素材和答案');
  if (left.version !== right.version)
    fail('ENTRY_STALE', 'ownerAction.version', '行动来源版本不一致，不能猜测字段兼容');
}
/** Text substitution is one pass; inserted braces are literal and scalar 0/false are real values. */
export function renderActionContent(
  content: Content,
  fields: readonly FieldSpec[],
  values: readonly FieldValue[],
): Readonly<{ content: Content; missingFieldIds: readonly string[]; ready: boolean }> {
  validateV06Dto('action', {
    id: 'render-check',
    version: 1,
    kind: 'action',
    content,
    fields,
    status: 'active',
    parentId: null,
    source: { kind: 'manual' },
  });
  validateFieldValues(fields, values);
  const present = (value: FieldValue | undefined) =>
    value !== undefined &&
    value.value !== null &&
    !(typeof value.value === 'string' && !value.value.trim());
  const missingFieldIds = fields
    .filter((f) => f.required && !present(values.find((v) => v.fieldId === f.id)))
    .map((f) => f.id);
  const replace = (text: string) =>
    text.replace(/\{([^{}]+)\}/g, (original, label: string) => {
      const field = fields.find((f) => f.label === label);
      if (!field) return original;
      const value = values.find((v) => v.fieldId === field.id);
      return present(value) ? String(value!.value) : field.required ? original : '';
    });
  return {
    content: {
      ...structuredClone(content),
      title: replace(content.title),
      criteria: replace(content.criteria),
    },
    missingFieldIds,
    ready: missingFieldIds.length === 0,
  };
}
/** Inheritance only. B2 checks placement/consumption/facts and resolves field conflicts. */
export function inheritMaterialSources(inputs: readonly [HandCard, HandCard]): Readonly<{
  inputIds: readonly [string, string];
  provenance: readonly Provenance[];
  expiresAt: string | null;
}> {
  const [left, right] = inputs;
  id(left.id, 'inputs[0].id');
  id(right.id, 'inputs[1].id');
  if (left.id === right.id) fail('INVALID_INPUT', 'inputs', '两个输入不能是同一张本次牌');
  const instants = [left.expiresAt, right.expiresAt].filter((at): at is string => at !== null);
  for (const at of instants) assertInstant(at);
  return {
    inputIds: [left.id, right.id],
    provenance: structuredClone([...left.provenance, ...right.provenance]),
    expiresAt: instants.reduce<string | null>(
      (first, at) => (first === null || compareInstants(at, first) < 0 ? at : first),
      null,
    ),
  };
}
