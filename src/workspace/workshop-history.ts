import type {DataV3} from './contracts-v3.ts';
import type {History, Instant, LocalDate} from './contracts.ts';
import {validateWorkshopEntity, type WorkshopCatalog, type WorkshopEntity} from '../workshop/model.ts';
import {sameValue} from '../daily/model.ts';
import {assertInstant, compareInstants, dateAt} from '../daily/time.ts';

export const workshopKinds = {actionCards: 'action-card', bookEntries: 'book-entry', pools: 'pool', generationRules: 'generation-rule'} as const;
export function workshopCatalog(data: DataV3): WorkshopCatalog {
  return {actionCards: data.actionCards, bookEntries: data.bookEntries, pools: data.pools, generationRules: data.generationRules};
}
export function versionSnapshot<K extends keyof WorkshopCatalog>(data: DataV3, collection: K, id: string, version: number): WorkshopCatalog[K][number] | null {
  const record = data.planner.history.find(h => h.entity.kind === workshopKinds[collection] && 'id' in h.entity && h.entity.id === id
    && (h.after as {version?: number} | null)?.version === version);
  return (record?.after ?? null) as WorkshopCatalog[K][number] | null;
}
export function historicalWorkshopEntity<K extends keyof WorkshopCatalog>(
  data: DataV3, collection: K, id: string, sourceDate: LocalDate, zone: string, at: Instant, throughIndex = data.planner.history.length,
): WorkshopCatalog[K][number] | null {
  let result: WorkshopCatalog[K][number] | null = null;
  for (const history of data.planner.history.slice(0, throughIndex)) {
    if (history.entity.kind === workshopKinds[collection] && 'id' in history.entity && history.entity.id === id
      && compareInstants(history.at, at) <= 0 && dateAt(history.at, zone) <= sourceDate) result = history.after as WorkshopCatalog[K][number];
  }
  return result;
}
export function historicalInstantEntity<K extends keyof WorkshopCatalog>(data: DataV3, collection: K, id: string, at: Instant, throughIndex: number): WorkshopCatalog[K][number] | null {
  let result: WorkshopCatalog[K][number] | null = null;
  for (const history of data.planner.history.slice(0, throughIndex)) {
    if (history.entity.kind === workshopKinds[collection] && 'id' in history.entity && history.entity.id === id && compareInstants(history.at, at) <= 0)
      result = history.after as WorkshopCatalog[K][number];
  }
  return result;
}
export function workshopRevisionHistory(data: DataV3): History[] {
  return data.planner.history.filter(h => Object.values(workshopKinds).some(kind => kind === h.entity.kind));
}
/** Complete append-only chains make old-date generation and backup validation reproducible. */
export function assertWorkshopHistory(data: DataV3): void {
  const heads = new Map<string, {entity: WorkshopEntity; at: string}>();
  for (const history of workshopRevisionHistory(data)) {
    const collection = (Object.keys(workshopKinds) as (keyof WorkshopCatalog)[]).find(k => workshopKinds[k] === history.entity.kind)!;
    const next = validateWorkshopEntity(collection, history.after);
    if (!next.ok) throw new Error(`历史对象字段无效: ${next.issues[0].path}`);
    const id = 'id' in history.entity ? history.entity.id : '';
    if (next.value.id !== id) throw new Error('版本历史对象身份不匹配');
    assertInstant(history.at);
    const key = JSON.stringify([collection, id]), previous = heads.get(key);
    if (!previous) {
      if (history.before !== null || next.value.version !== 1) throw new Error('版本历史缺少创建记录');
    } else {
      if (!sameValue(previous.entity, history.before) || next.value.version !== previous.entity.version + 1) throw new Error('版本历史链不连续');
      if (compareInstants(history.at, previous.at) < 0) throw new Error('版本历史保存时间不能倒退');
      if (!sameValue(next.value.source, previous.entity.source)) throw new Error('版本历史创建来源被替换');
      if (collection === 'generationRules' && (next.value as DataV3['generationRules'][number]).zone !== (previous.entity as DataV3['generationRules'][number]).zone)
        throw new Error('版本历史规则时区被替换');
    }
    heads.set(key, {entity: next.value, at: history.at});
  }
  for (const collection of Object.keys(workshopKinds) as (keyof WorkshopCatalog)[]) {
    for (const item of data[collection]) {
      const key = JSON.stringify([collection, item.id]);
      if (!sameValue(heads.get(key)?.entity, item)) throw new Error('当前工坊对象缺少匹配版本历史');
      heads.delete(key);
    }
  }
  if (heads.size) throw new Error('版本历史对象不能直接删除');
}
