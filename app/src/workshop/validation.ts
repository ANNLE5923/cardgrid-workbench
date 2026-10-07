import type { Content } from '../workspace/index.ts';
import { assertContent } from '../daily/model.ts';
import { assertDate, assertZone } from '../daily/time.ts';

export type WorkshopIssueCode =
  | 'INVALID_SHAPE'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'INVALID_VALUE'
  | 'DUPLICATE_ID'
  | 'MISSING_REFERENCE'
  | 'POOL_KIND_MISMATCH'
  | 'SLOT_POOL_KIND_MISMATCH'
  | 'HIERARCHY_CYCLE'
  | 'POOL_CAPACITY_EXCEEDED'
  | 'VERSION_CONFLICT'
  | 'SOURCE_CHANGED'
  | 'RULE_ZONE_CHANGED'
  | 'DELETE_FORBIDDEN'
  | 'INVALID_JSON';
export type WorkshopIssue = Readonly<{ code: WorkshopIssueCode; path: string; message: string }>;
type RecordValue = Record<string, unknown>;

/** Shape checks are shared by form candidates and parsed JSON; no normalization. */
export class WorkshopChecks {
  readonly issues: WorkshopIssue[] = [];
  issue(code: WorkshopIssueCode, path: string, message: string): void {
    this.issues.push({ code, path, message });
  }
  record(value: unknown, path: string): RecordValue | null {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
      this.issue('INVALID_SHAPE', path, '需要普通对象');
      return null;
    }
    return value as RecordValue;
  }
  exact(value: RecordValue, fields: readonly string[], path: string): void {
    for (const field of fields)
      if (!Object.hasOwn(value, field))
        this.issue('MISSING_FIELD', `${path}.${field}`, '缺少必填字段');
    for (const field of Object.keys(value))
      if (!fields.includes(field)) this.issue('UNKNOWN_FIELD', `${path}.${field}`, '未知字段');
  }
  text(value: unknown, path: string, allowEmpty = false): value is string {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
      this.issue('INVALID_VALUE', path, '需要非空字符串');
      return false;
    }
    return true;
  }
  nullableText(value: unknown, path: string, allowEmpty = false): void {
    if (value !== null) this.text(value, path, allowEmpty);
  }
  version(value: unknown, path: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < 1)
      this.issue('INVALID_VALUE', path, '版本必须为正安全整数');
  }
  oneOf(value: unknown, options: readonly unknown[], path: string): void {
    if (!options.includes(value))
      this.issue('INVALID_VALUE', path, `只支持 ${options.join(' / ')}`);
  }
  boolean(value: unknown, path: string): void {
    if (typeof value !== 'boolean') this.issue('INVALID_VALUE', path, '需要布尔值');
  }
  array(value: unknown, path: string): readonly unknown[] | null {
    if (!Array.isArray(value)) {
      this.issue('INVALID_SHAPE', path, '需要数组');
      return null;
    }
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i))
        this.issue('INVALID_SHAPE', `${path}[${i}]`, '数组不能含有空缺项');
    }
    return value;
  }
  ids(value: unknown, path: string): void {
    const items = this.array(value, path);
    if (!items) return;
    const seen = new Set<string>();
    items.forEach((id, i) => {
      if (!this.text(id, `${path}[${i}]`)) return;
      if (seen.has(id)) this.issue('DUPLICATE_ID', `${path}[${i}]`, '同一列表内标识重复');
      seen.add(id);
    });
  }
  entity(value: unknown, fields: readonly string[], path: string): RecordValue | null {
    const item = this.record(value, path);
    if (!item) return null;
    this.exact(item, fields, path);
    this.text(item.id, `${path}.id`);
    this.version(item.version, `${path}.version`);
    this.source(item.source, `${path}.source`);
    return item;
  }
  source(value: unknown, path: string): void {
    const item = this.record(value, path);
    if (!item) return;
    if (item.kind === 'manual') {
      this.exact(item, ['kind'], path);
      return;
    }
    if (item.kind === 'legacy') {
      this.exact(item, ['kind', 'sourceId', 'path'], path);
      this.text(item.sourceId, `${path}.sourceId`);
      this.text(item.path, `${path}.path`);
      return;
    }
    this.exact(item, ['kind', 'id'], path);
    this.oneOf(
      item.kind,
      ['definition', 'capture', 'occurrence', 'makeup', 'daily-copy'],
      `${path}.kind`,
    );
    this.text(item.id, `${path}.id`);
    // Resolving provenance into the complete workspace belongs to B3.
  }
  content(value: unknown, path: string): void {
    const item = this.record(value, path);
    if (!item) return;
    const start = this.issues.length;
    this.exact(
      item,
      [
        'title',
        'criteria',
        'presetMinutes',
        'color',
        'categoryId',
        'categoryLabel',
        'minimum',
        'projectIds',
        'goalIds',
        'projectLabels',
        'goalLabels',
      ],
      path,
    );
    this.text(item.title, `${path}.title`);
    this.text(item.criteria, `${path}.criteria`, true);
    this.text(item.color, `${path}.color`);
    this.boolean(item.minimum, `${path}.minimum`);
    this.nullableText(item.categoryId, `${path}.categoryId`);
    this.nullableText(item.categoryLabel, `${path}.categoryLabel`, true);
    this.ids(item.projectIds, `${path}.projectIds`);
    this.ids(item.goalIds, `${path}.goalIds`);
    for (const name of ['projectLabels', 'goalLabels']) {
      const labels = this.array(item[name], `${path}.${name}`);
      labels?.forEach((label, i) => {
        const entry = this.record(label, `${path}.${name}[${i}]`);
        if (!entry) return;
        this.exact(entry, ['id', 'label'], `${path}.${name}[${i}]`);
        this.text(entry.id, `${path}.${name}[${i}].id`);
        this.text(entry.label, `${path}.${name}[${i}].label`, true);
      });
    }
    if (
      item.presetMinutes !== null &&
      (!Number.isInteger(item.presetMinutes) ||
        (item.presetMinutes as number) < 5 ||
        (item.presetMinutes as number) > 1440 ||
        (item.presetMinutes as number) % 5)
    ) {
      this.issue(
        'INVALID_VALUE',
        `${path}.presetMinutes`,
        '预设时长须为 5—1440 分钟且为 5 的倍数，或 null',
      );
    }
    if (this.issues.length === start) {
      try {
        assertContent(item as Content);
      } catch (error) {
        this.issue('INVALID_VALUE', path, error instanceof Error ? error.message : '行动内容无效');
      }
    }
  }
  slot(value: unknown, path: string): void {
    const item = this.record(value, path);
    if (!item) return;
    this.exact(item, ['id', 'label', 'poolId', 'required', 'valueKind'], path);
    this.text(item.id, `${path}.id`);
    this.text(item.label, `${path}.label`);
    this.text(item.poolId, `${path}.poolId`);
    this.boolean(item.required, `${path}.required`);
    this.oneOf(item.valueKind, ['entry'], `${path}.valueKind`);
  }
  action(value: unknown, path: string): void {
    const item = this.entity(
      value,
      ['id', 'version', 'kind', 'content', 'slots', 'status', 'parentId', 'source'],
      path,
    );
    if (!item) return;
    this.oneOf(item.kind, ['action'], `${path}.kind`);
    this.content(item.content, `${path}.content`);
    this.oneOf(item.status, ['active', 'paused', 'archived'], `${path}.status`);
    this.nullableText(item.parentId, `${path}.parentId`);
    const slots = this.array(item.slots, `${path}.slots`);
    const labels = new Set<string>(),
      ids = new Set<string>();
    slots?.forEach((slot, i) => {
      this.slot(slot, `${path}.slots[${i}]`);
      const id = slot && typeof slot === 'object' ? (slot as RecordValue).id : undefined;
      if (typeof id === 'string') {
        if (ids.has(id))
          this.issue('DUPLICATE_ID', `${path}.slots[${i}].id`, '同一行动的槽位标识不能重复');
        ids.add(id);
      }
      const label = slot && typeof slot === 'object' ? (slot as RecordValue).label : undefined;
      if (typeof label !== 'string') return;
      if (labels.has(label))
        this.issue('INVALID_VALUE', `${path}.slots[${i}].label`, '同一行动的槽位文字标签不能重复');
      labels.add(label);
    });
  }
  book(value: unknown, path: string): void {
    const item = this.entity(
      value,
      ['id', 'version', 'kind', 'title', 'author', 'status', 'source'],
      path,
    );
    if (!item) return;
    this.oneOf(item.kind, ['book'], `${path}.kind`);
    this.text(item.title, `${path}.title`);
    this.nullableText(item.author, `${path}.author`, true);
    this.oneOf(item.status, ['active', 'archived'], `${path}.status`);
  }
  pool(value: unknown, path: string): void {
    const item = this.entity(
      value,
      ['id', 'version', 'name', 'poolKind', 'parentPoolId', 'memberIds', 'source'],
      path,
    );
    if (!item) return;
    this.text(item.name, `${path}.name`);
    this.oneOf(item.poolKind, ['action', 'book'], `${path}.poolKind`);
    this.nullableText(item.parentPoolId, `${path}.parentPoolId`);
    this.ids(item.memberIds, `${path}.memberIds`);
  }
  rule(value: unknown, path: string): void {
    const item = this.entity(
      value,
      [
        'id',
        'version',
        'name',
        'actionCardId',
        'schedule',
        'startDate',
        'zone',
        'status',
        'source',
      ],
      path,
    );
    if (!item) return;
    this.text(item.name, `${path}.name`);
    this.text(item.actionCardId, `${path}.actionCardId`);
    this.oneOf(item.status, ['active', 'paused', 'archived'], `${path}.status`);
    if (this.text(item.startDate, `${path}.startDate`)) {
      try {
        assertDate(item.startDate);
      } catch {
        this.issue('INVALID_VALUE', `${path}.startDate`, '需要有效的 YYYY-MM-DD 日期');
      }
    }
    if (this.text(item.zone, `${path}.zone`)) {
      try {
        assertZone(item.zone);
      } catch {
        this.issue('INVALID_VALUE', `${path}.zone`, '需要有效 IANA 时区');
      }
    }
    const schedule = this.record(item.schedule, `${path}.schedule`);
    if (!schedule) return;
    if (schedule.mode === 'daily') {
      this.exact(schedule, ['mode'], `${path}.schedule`);
      return;
    }
    this.exact(schedule, ['mode', 'weekdays'], `${path}.schedule`);
    this.oneOf(schedule.mode, ['weekdays'], `${path}.schedule.mode`);
    const weekdays = this.array(schedule.weekdays, `${path}.schedule.weekdays`);
    if (!weekdays) return;
    if (!weekdays.length)
      this.issue('INVALID_VALUE', `${path}.schedule.weekdays`, '指定星期至少包含一天');
    const seen = new Set<number>();
    weekdays.forEach((day, i) => {
      if (!Number.isInteger(day) || (day as number) < 0 || (day as number) > 6)
        this.issue(
          'INVALID_VALUE',
          `${path}.schedule.weekdays[${i}]`,
          '星期须为 0（日）至 6（六）',
        );
      else if (seen.has(day as number))
        this.issue('INVALID_VALUE', `${path}.schedule.weekdays[${i}]`, '星期重复');
      seen.add(day as number);
    });
  }
}

/** Validated JSON-shaped data only. Preserve text, array order and field presence. */
export function sameWorkshopValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameWorkshopValue(v, b[i]))
    );
  const left = a as RecordValue,
    right = b as RecordValue;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every(
      (key) => Object.hasOwn(right, key) && sameWorkshopValue(left[key], right[key]),
    )
  );
}

export function freezeCopy<T>(value: T): T {
  const result: T = structuredClone(value);
  function freeze(item: unknown): void {
    if (item !== null && typeof item === 'object') {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  }
  freeze(result);
  return result;
}
