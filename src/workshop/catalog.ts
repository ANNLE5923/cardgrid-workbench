import type {ActionCard, BookEntry, GenerationRule, Pool} from '../workspace/index.ts';
import {WorkshopChecks, freezeCopy, sameWorkshopValue, type WorkshopIssue} from './validation.ts';

/** A business projection, not Data v3, a config package or a replacement workspace. */
export type WorkshopCatalog = Readonly<{
  actionCards: readonly ActionCard[]; bookEntries: readonly BookEntry[];
  pools: readonly Pool[]; generationRules: readonly GenerationRule[];
}>;
export type WorkshopValidation<T = WorkshopCatalog> =
  | Readonly<{ok: true; value: T}>
  | Readonly<{ok: false; issues: readonly WorkshopIssue[]}>;
export const workshopCollections = ['actionCards', 'bookEntries', 'pools', 'generationRules'] as const;
const collections = workshopCollections;
export type WorkshopEntity = WorkshopCatalog[keyof WorkshopCatalog][number];
export function validateWorkshopEntity(collection: keyof WorkshopCatalog, input: unknown): WorkshopValidation<WorkshopEntity> {
  const checks = new WorkshopChecks();
  switch (collection) {
    case 'actionCards': checks.action(input, collection); break;
    case 'bookEntries': checks.book(input, collection); break;
    case 'pools': checks.pool(input, collection); break;
    case 'generationRules': checks.rule(input, collection); break;
    default: checks.issue('INVALID_VALUE', 'collection', '未知工坊对象种类');
  }
  return checks.issues.length ? {ok: false, issues: checks.issues} : {ok: true, value: freezeCopy(input as WorkshopEntity)};
}

function unique(items: readonly Readonly<{id: string}>[], path: string, checks: WorkshopChecks): void {
  const ids = new Set<string>();
  items.forEach((item, i) => {
    if (ids.has(item.id)) checks.issue('DUPLICATE_ID', `${path}[${i}].id`, '同种对象的标识重复');
    ids.add(item.id);
  });
}

function hierarchy<T extends Readonly<{id: string}>>(
  items: readonly T[], parent: (item: T) => string | null, field: string, collection: string, checks: WorkshopChecks,
): void {
  const byId = new Map(items.map(item => [item.id, item]));
  const done = new Set<string>();
  items.forEach((item, index) => {
    const parentId = parent(item);
    if (parentId !== null && !byId.has(parentId)) checks.issue('MISSING_REFERENCE', `${collection}[${index}].${field}`, '上层对象不存在');
    if (done.has(item.id)) return;
    const seen = new Set<string>(); let current: T | undefined = item;
    while (current && !done.has(current.id)) {
      if (seen.has(current.id)) {checks.issue('HIERARCHY_CYCLE', `${collection}[${index}].${field}`, '层级形成循环'); break;}
      seen.add(current.id); const next = parent(current); current = next === null ? undefined : byId.get(next);
    }
    seen.forEach(id => done.add(id));
  });
}

function references(catalog: WorkshopCatalog, checks: WorkshopChecks): void {
  const actions = new Set(catalog.actionCards.map(card => card.id));
  const books = new Set(catalog.bookEntries.map(book => book.id));
  const pools = new Map(catalog.pools.map(pool => [pool.id, pool]));
  for (const name of collections) unique(catalog[name], name, checks);
  hierarchy(catalog.actionCards, card => card.parentId, 'parentId', 'actionCards', checks);
  hierarchy(catalog.pools, pool => pool.parentPoolId, 'parentPoolId', 'pools', checks);
  catalog.pools.forEach((pool, i) => {
    const allowed = pool.poolKind === 'action' ? actions : books;
    const other = pool.poolKind === 'action' ? books : actions;
    pool.memberIds.forEach((id, j) => {
      if (allowed.has(id)) return; // IDs have a namespace, selected explicitly by poolKind.
      const code = other.has(id) ? 'POOL_KIND_MISMATCH' : 'MISSING_REFERENCE';
      checks.issue(code, `pools[${i}].memberIds[${j}]`, other.has(id) ? '行动池与书目池不能混入异种成员' : '成员对象不存在');
    });
    // parentPoolId expresses navigation, not membership or draw dependency.
  });
  catalog.actionCards.forEach((card, i) => {
    unique(card.slots, `actionCards[${i}].slots`, checks);
    card.slots.forEach((slot, j) => {
      const pool = pools.get(slot.poolId), field = `actionCards[${i}].slots[${j}].poolId`;
      if (!pool) checks.issue('MISSING_REFERENCE', field, '预留位绑定的牌堆不存在');
      // valueKind:entry and the frozen SlotSelection.entrySnapshot are BookEntry.
      else if (pool.poolKind !== 'book') checks.issue('SLOT_POOL_KIND_MISMATCH', field, '词条预留位须绑定书目池，不能递归绑定行动池');
      // Empty/archived-only pools are valid workshop configuration. B2/B3 determine readiness.
    });
  });
  catalog.generationRules.forEach((rule, i) => {
    if (!actions.has(rule.actionCardId)) checks.issue('MISSING_REFERENCE', `generationRules[${i}].actionCardId`, '生成规则必须引用存在的行动原卡，不能引用书目或库存副本');
  });
}

export function validateWorkshopCatalog(input: unknown): WorkshopValidation {
  const checks = new WorkshopChecks(), record = checks.record(input, 'workshop');
  if (!record) return {ok: false, issues: checks.issues};
  checks.exact(record, collections, 'workshop');
  for (const collection of collections) {
    const items = checks.array(record[collection], collection);
    items?.forEach((item, i) => {
      const field = `${collection}[${i}]`;
      switch (collection) {
        case 'actionCards': checks.action(item, field); break;
        case 'bookEntries': checks.book(item, field); break;
        case 'pools': checks.pool(item, field); break;
        case 'generationRules': checks.rule(item, field); break;
      }
    });
  }
  if (checks.issues.length) return {ok: false, issues: checks.issues};
  const catalog = input as WorkshopCatalog; references(catalog, checks);
  return checks.issues.length ? {ok: false, issues: checks.issues} : {ok: true, value: freezeCopy(catalog)};
}

/** JSON editing uses the same shape and business validator as form candidates. */
export function parseWorkshopJson(text: string): WorkshopValidation {
  let value: unknown;
  try {value = JSON.parse(text);} catch {return {ok: false, issues: [{code: 'INVALID_JSON', path: 'workshop', message: 'JSON 无法解析'}]};}
  return validateWorkshopCatalog(value);
}

/** No version bump, persistence or generation is hidden inside validation. */
export function validateWorkshopChange(before: unknown, after: unknown): WorkshopValidation {
  const previous = validateWorkshopCatalog(before), next = validateWorkshopCatalog(after);
  if (!previous.ok) return {ok: false, issues: previous.issues.map(issue => ({...issue, path: `before.${issue.path}`}))};
  if (!next.ok) return next;
  const checks = new WorkshopChecks();
  for (const collection of collections) {
    const old = new Map(previous.value[collection].map(item => [item.id, item]));
    const replacements = new Map(next.value[collection].map(item => [item.id, item]));
    for (const item of old.values()) {
      if (!replacements.has(item.id)) checks.issue('DELETE_FORBIDDEN', collection, '既有对象不直接删除；原卡、书目和规则可归档，牌堆保留或调整配置');
    }
    next.value[collection].forEach((item, i) => {
      const original = old.get(item.id), field = `${collection}[${i}]`;
      if (!original) {if (item.version !== 1) checks.issue('VERSION_CONFLICT', `${field}.version`, '新对象从版本 1 开始'); return;}
      if (!sameWorkshopValue(original.source, item.source)) checks.issue('SOURCE_CHANGED', `${field}.source`, '既有对象的创建来源不可替换');
      const {version: _oldVersion, ...oldFields} = original;
      const {version: _newVersion, ...newFields} = item;
      const expected = sameWorkshopValue(oldFields, newFields) ? original.version : original.version + 1;
      if (item.version !== expected) checks.issue('VERSION_CONFLICT', `${field}.version`, '修改对象须恰好增加一个版本；未修改对象保留版本');
      if (collection === 'generationRules' && (original as GenerationRule).zone !== (item as GenerationRule).zone)
        checks.issue('RULE_ZONE_CHANGED', `${field}.zone`, '规则时区已冻结，更换时区需建立新规则');
    });
  }
  return checks.issues.length ? {ok: false, issues: checks.issues} : next;
}
