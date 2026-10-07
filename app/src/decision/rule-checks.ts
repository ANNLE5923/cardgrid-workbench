import type {
  ActionCardV5,
  AnswerSnapshot,
  FieldSpec,
  FieldValue,
  Scalar,
  V06ErrorCode,
} from '../workspace/v06.ts';
import type { VersionRef } from '../workspace/index.ts';
import { validateV06Dto, V06ContractError } from '../workspace/v06.ts';

export function fail(code: V06ErrorCode, field: string, message: string): never {
  throw new V06ContractError(code, field, message);
}
export function id(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_INPUT', field, '需要独立的非空 ID');
}
export function ref(value: VersionRef, field: string): void {
  id(value.id, `${field}.id`);
  if (!Number.isSafeInteger(value.version) || value.version < 1)
    fail('INVALID_INPUT', `${field}.version`, '版本须为正整数');
}
export function uniqueEntity<T extends { id: string }>(
  values: readonly T[],
  entityId: string,
  field: string,
): T {
  id(entityId, field);
  const matches = values.filter((v) => v.id === entityId);
  if (matches.length !== 1)
    fail('INVALID_INPUT', field, matches.length ? 'ID 不唯一，不能猜测来源' : '引用不存在');
  return matches[0];
}
export function validateFields(fields: readonly FieldSpec[]): void {
  const ids = new Set<string>(),
    labels = new Set<string>();
  for (const field of fields) {
    if (ids.has(field.id) || labels.has(field.label))
      fail('INVALID_INPUT', 'fields', '字段 ID 和文字标签必须各自唯一');
    ids.add(field.id);
    labels.add(field.label);
  }
}
export function validateAction(action: ActionCardV5): void {
  validateV06Dto('action', action);
  validateFields(action.fields);
}
export function validateAnswer(answer: AnswerSnapshot): void {
  validateV06Dto('answer', answer);
  if (answer.entry.status !== 'active')
    fail('ENTRY_UNAVAILABLE', 'answer.entry', '不能从已归档条目生成新答案');
  if (
    !answer.sourceDecks.length ||
    new Set(answer.sourceDecks.map((d) => d.id)).size !== answer.sourceDecks.length
  )
    fail('INVALID_INPUT', 'answer.sourceDecks', '答案必须保留唯一的候选来源牌堆');
  const expected = new Map<string, Scalar>();
  const mapped = new Set<string>();
  for (const mapping of answer.mappings) {
    if (mapped.has(mapping.fieldId))
      fail('INVALID_INPUT', 'answer.mappings', '不能重复映射同一字段');
    mapped.add(mapping.fieldId);
    const key = mapping.entryPath.slice('attributes.'.length);
    if (mapping.entryPath === 'title') expected.set(mapping.fieldId, answer.entry.title);
    else if (Object.hasOwn(answer.entry.attributes, key))
      expected.set(mapping.fieldId, answer.entry.attributes[key]);
  }
  const seen = new Set<string>();
  for (const value of answer.fieldValues) {
    if (
      seen.has(value.fieldId) ||
      !expected.has(value.fieldId) ||
      expected.get(value.fieldId) !== value.value
    )
      fail('INVALID_INPUT', 'answer.fieldValues', '字段结果与已冻结条目或映射不一致');
    seen.add(value.fieldId);
  }
  if (seen.size !== expected.size)
    fail('INVALID_INPUT', 'answer.fieldValues', '缺少已映射的字段快照');
}
export function scalarMatches(value: Scalar, field: FieldSpec, path: string): void {
  const expectedType = field.valueType === 'text' ? 'string' : field.valueType;
  if (
    value !== null &&
    (typeof value !== expectedType || (typeof value === 'number' && !Number.isFinite(value)))
  )
    fail('INVALID_INPUT', path, '字段类型与行动定义不一致，不能自动转换');
}
export function validateFieldValues(
  fields: readonly FieldSpec[],
  values: readonly FieldValue[],
): void {
  validateFields(fields);
  const seen = new Set<string>();
  for (const value of values) {
    const field = fields.find((f) => f.id === value.fieldId);
    if (!field || seen.has(value.fieldId))
      fail('INVALID_INPUT', 'fieldValues', '值对应的字段未知或重复');
    seen.add(value.fieldId);
    scalarMatches(value.value, field, `fieldValues.${value.fieldId}`);
  }
}
