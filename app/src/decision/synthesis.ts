import type { VersionRef } from '../workspace/index.ts';
import type { ActionCardV5, FieldResolution, HandCard, Scalar } from '../workspace/v06.ts';
import { assertSameActionOwner, inheritMaterialSources, renderActionContent } from './materials.ts';
import {
  assertAvailable,
  assertUnplaced,
  nextVersion,
  readMaterial,
  type MaterialContext,
} from './material-state.ts';
import { fail, id, validateAction, validateAnswer, validateFieldValues } from './rule-checks.ts';

export type CompositeMaterial = Extract<HandCard, { kind: 'composite' }>;
export type SynthesisInput = Readonly<{
  context: MaterialContext;
  inputs: readonly [VersionRef, VersionRef];
  outputId: string;
  at: string;
  /** Frozen original action version from retained catalog/history, not the current edited card. */
  actionSource: ActionCardV5;
  resolutions?: readonly FieldResolution[];
}>;
export type SynthesisDraft = Readonly<{
  inputs: readonly [VersionRef, VersionRef];
  output: CompositeMaterial;
  conflicts: readonly Readonly<{ fieldId: string; previous: Scalar; incoming: Scalar }>[];
  unresolvedFieldIds: readonly string[];
  missingFieldIds: readonly string[];
  canConfirm: boolean;
  readyForToday: boolean;
}>;
const populated = (value: Scalar | undefined) =>
  value !== undefined && value !== null && !(typeof value === 'string' && !value.trim());
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((v, i) => sameJson(v, right[i]))
    );
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]))
  );
}
/** A tentative output is display-only until every conflict is explicitly resolved. */
export function previewSynthesis(input: SynthesisInput): SynthesisDraft {
  if (input.inputs.length !== 2 || input.inputs[0].id === input.inputs[1].id)
    fail('INVALID_INPUT', 'inputs', '必须是两张不同的本次牌');
  const cards = input.inputs.map((expected) => readMaterial(input.context, expected));
  const action = cards.find((c) => c.kind === 'action' || c.kind === 'composite');
  const answer = cards.find((c) => c.kind === 'answer');
  if (!action || !answer) fail('INVALID_INPUT', 'inputs', '需要一张行动／中间成品和一张答案');
  for (const material of cards) {
    assertAvailable(material, input.at);
    assertUnplaced(input.context, material);
  }
  assertSameActionOwner(action.ownerAction, answer.answer.ownerAction);
  validateAction(input.actionSource);
  assertSameActionOwner(action.ownerAction, input.actionSource);
  validateAnswer(answer.answer);
  validateFieldValues(action.fieldSpecs, action.fieldValues);
  validateFieldValues(action.fieldSpecs, answer.answer.fieldValues);
  if (!sameJson(action.fieldSpecs, input.actionSource.fields))
    fail('ENTRY_STALE', 'actionSource.fields', '必须使用原归属版本的字段模板');
  const previousContent =
    action.kind === 'action'
      ? input.actionSource.content
      : renderActionContent(input.actionSource.content, action.fieldSpecs, action.fieldValues)
          .content;
  if (!sameJson(action.contentSnapshot, previousContent))
    fail('ENTRY_STALE', 'actionSource.content', '不能用改变后的原卡或成品标题猜测模板');
  id(input.outputId, 'outputId');
  if (input.context.materials.some((c) => c.id === input.outputId))
    fail('INVALID_INPUT', 'outputId', '成品需要全新的本次牌 ID');
  const merged = new Map(action.fieldValues.map((v) => [v.fieldId, v.value]));
  const conflicts: SynthesisDraft['conflicts'][number][] = [];
  for (const value of answer.answer.fieldValues) {
    const previous = merged.get(value.fieldId);
    if (populated(previous) && previous !== value.value)
      conflicts.push({ fieldId: value.fieldId, previous: previous!, incoming: value.value });
    else merged.set(value.fieldId, value.value);
  }
  const choices = new Map<string, FieldResolution['choice']>();
  for (const resolution of input.resolutions ?? []) {
    if (
      !conflicts.some((c) => c.fieldId === resolution.fieldId) ||
      choices.has(resolution.fieldId) ||
      !['keep', 'replace'].includes(resolution.choice)
    )
      fail('INVALID_INPUT', 'resolutions', '只能逐个解决实际冲突，不允许重复或未知方案');
    choices.set(resolution.fieldId, resolution.choice);
  }
  for (const conflict of conflicts)
    if (choices.get(conflict.fieldId) === 'replace')
      merged.set(conflict.fieldId, conflict.incoming);
  const fieldValues = action.fieldSpecs.flatMap((f) =>
    merged.has(f.id) ? [{ fieldId: f.id, value: merged.get(f.id)! }] : [],
  );
  const rendered = renderActionContent(input.actionSource.content, action.fieldSpecs, fieldValues);
  const unresolvedFieldIds = conflicts.filter((c) => !choices.has(c.fieldId)).map((c) => c.fieldId);
  const inherited = inheritMaterialSources([cards[0], cards[1]]);
  const output: CompositeMaterial = {
    id: input.outputId,
    version: 1,
    kind: 'composite',
    state: 'available',
    createdAt: input.at,
    ...inherited,
    consumedBy: null,
    actionInstanceId: null,
    ownerAction: structuredClone(action.ownerAction),
    contentSnapshot: rendered.content,
    fieldSpecs: structuredClone(action.fieldSpecs),
    fieldValues,
  };
  return {
    inputs: structuredClone(input.inputs),
    output,
    conflicts,
    unresolvedFieldIds,
    missingFieldIds: rendered.missingFieldIds,
    canConfirm: unresolvedFieldIds.length === 0,
    readyForToday:
      unresolvedFieldIds.length === 0 && rendered.ready && rendered.content.presetMinutes !== null,
  };
}
/** Recompute from fresh reads; B4 must apply all three drafts in ONE transaction. No writes here. */
export function prepareSynthesisConsumption(input: SynthesisInput): Readonly<{
  draft: SynthesisDraft;
  consumed: readonly [HandCard, HandCard];
  output: CompositeMaterial;
}> {
  const draft = previewSynthesis(input);
  if (!draft.canConfirm) fail('FIELD_CONFLICT', 'resolutions', '请明确选择保留原值或采用新值');
  const consume = (expected: VersionRef): HandCard => {
    const card = readMaterial(input.context, expected);
    return {
      ...structuredClone(card),
      version: nextVersion(card.version),
      state: 'consumed',
      consumedBy: draft.output.id,
    };
  };
  return {
    draft,
    consumed: [consume(input.inputs[0]), consume(input.inputs[1])],
    output: structuredClone(draft.output),
  };
}
