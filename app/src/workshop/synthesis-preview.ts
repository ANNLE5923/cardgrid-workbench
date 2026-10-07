// A3 synthesis preview (temporary workshop rule; the formal synthesis rule ships
// in B2 and the atomic consume command in B4). Pure, no React/storage: given one
// action/composite material and one same-owner answer material it merges fields,
// reports same-field conflicts and missing required fields, and builds the
// composite output snapshot. Previewing never consumes; nothing here writes.
import type {
  FieldResolution,
  FieldSpec,
  FieldValue,
  HandCard,
  Scalar,
  SynthesisPreview,
  V06ErrorCode,
  V06Result,
} from '../workspace/v06.ts';
import type { Id, Instant, Token, VersionRef } from '../workspace/index.ts';

export type ActionMaterialCard = Extract<HandCard, { kind: 'action' | 'composite' }>;
export type AnswerMaterialCard = Extract<HandCard, { kind: 'answer' }>;

const fail = (code: V06ErrorCode, message: string, retry: 'edit' | 'reload'): V06Result<never> => ({
  ok: false,
  code,
  message,
  retry,
});

const scalarEqual = (a: Scalar, b: Scalar): boolean => a === b;
const valueOf = (fields: readonly FieldValue[], fieldId: Id): Scalar | undefined =>
  fields.find((f) => f.fieldId === fieldId)?.value;

const earliest = (a: Instant | null, b: Instant | null): Instant | null => {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b; // UTC ISO instants order lexicographically
};

export type BuildPreviewInput = Readonly<{
  token: Token;
  previewId: Id;
  outputId: Id;
  now: Instant;
  action: ActionMaterialCard;
  answer: AnswerMaterialCard;
  resolutions: readonly FieldResolution[];
}>;

export function buildSynthesisPreview(input: BuildPreviewInput): V06Result<SynthesisPreview> {
  const { action, answer } = input;

  // Eligibility: both materials must be available (not placed/consumed/expired).
  if (action.state !== 'available')
    return fail('MATERIAL_CONSUMED', '行动素材已打出、消耗或过期，请撤回或重新拿牌', 'reload');
  if (answer.state !== 'available')
    return fail('MATERIAL_CONSUMED', '答案素材已打出、消耗或过期，请重新取得答案', 'reload');
  if (action.id === answer.id)
    return fail('INVALID_INPUT', '同一张牌不能同时放入两个输入槽', 'edit');
  // Same-owner answer only (F2).
  if (answer.answer.ownerAction.id !== action.ownerAction.id)
    return fail(
      'ACTION_OWNER_MISMATCH',
      `答案归属行动「${answer.answer.ownerAction.id}」，与槽内行动「${action.ownerAction.id}」不一致`,
      'edit',
    );

  // Merge fields. Same field with different typed values is a conflict the user
  // must resolve per field (keep action value / replace with answer value).
  const actionFields = action.fieldValues;
  const answerFields = answer.answer.fieldValues;
  const specIds = new Set<Id>(action.fieldSpecs.map((s: FieldSpec) => s.id));
  const allFieldIds = [
    ...new Set([
      ...actionFields.map((f) => f.fieldId),
      ...answerFields.map((f) => f.fieldId),
      ...specIds,
    ]),
  ];

  const conflicts: { fieldId: Id; previous: Scalar; incoming: Scalar }[] = [];
  const resolutionById = new Map<Id, 'keep' | 'replace'>(
    input.resolutions.map((r) => [r.fieldId, r.choice]),
  );
  const merged: FieldValue[] = [];

  for (const fieldId of allFieldIds) {
    const hasAction = actionFields.some((f) => f.fieldId === fieldId);
    const hasAnswer = answerFields.some((f) => f.fieldId === fieldId);
    const actionValue = valueOf(actionFields, fieldId);
    const answerValue = valueOf(answerFields, fieldId);

    if (hasAction && hasAnswer && !scalarEqual(actionValue!, answerValue!)) {
      conflicts.push({ fieldId, previous: actionValue!, incoming: answerValue! });
      const choice = resolutionById.get(fieldId);
      // Unresolved conflict keeps the previous value but blocks readiness.
      merged.push({ fieldId, value: choice === 'replace' ? answerValue! : actionValue! });
    } else if (hasAction) {
      merged.push({ fieldId, value: actionValue! });
    } else {
      merged.push({ fieldId, value: answerValue! }); // empty -> fill from answer
    }
  }

  const unresolved = new Set(conflicts.map((c) => c.fieldId));
  for (const r of input.resolutions) unresolved.delete(r.fieldId);

  // Required fields must end up with a non-null value, otherwise the composite is
  // an explicit "待补全" intermediate that cannot be played in Today.
  const missingFieldIds = action.fieldSpecs
    .filter((s: FieldSpec) => s.required)
    .map((s: FieldSpec) => s.id)
    .filter((id: Id) => {
      const v = valueOf(merged, id);
      return v === undefined || v === null;
    });

  const inputs: readonly [VersionRef, VersionRef] = [
    { id: action.id, version: action.version },
    { id: answer.id, version: answer.version },
  ];

  const output = {
    id: input.outputId,
    version: 1,
    kind: 'composite',
    state: 'available',
    createdAt: input.now,
    actionInstanceId: action.actionInstanceId,
    ownerAction: action.ownerAction,
    contentSnapshot: action.contentSnapshot,
    fieldSpecs: action.fieldSpecs,
    fieldValues: merged,
    provenance: [...action.provenance, ...answer.provenance],
    inputIds: [...new Set([...action.inputIds, action.id, answer.id])],
    expiresAt: earliest(action.expiresAt, answer.expiresAt),
    consumedBy: null,
  } as Extract<HandCard, { kind: 'composite' }>;

  const sourceFingerprint = [
    action.id,
    action.version,
    answer.id,
    answer.version,
    ...merged.map((f) => `${f.fieldId}=${JSON.stringify(f.value)}`),
  ].join('|');

  const ready = unresolved.size === 0 && missingFieldIds.length === 0;

  return {
    ok: true,
    value: {
      previewId: input.previewId,
      token: input.token,
      inputs,
      sourceFingerprint,
      output,
      conflicts,
      missingFieldIds,
      ready,
    },
  };
}
