import type {Pool} from '../workspace/index.ts';
import type {WorkshopIssue} from './validation.ts';

/** Per-pool membership, including archived members; parents are navigation only. */
export const POOL_CAPACITY = 100;

export function poolCapacityIssue(pool: Pick<Pool, 'memberIds'>, path = 'pool'): WorkshopIssue | null {
  return pool.memberIds.length > POOL_CAPACITY
    ? {code: 'POOL_CAPACITY_EXCEEDED', path: `${path}.memberIds`, message: `每个卡池最多 ${POOL_CAPACITY} 张，请移出超额成员`}
    : null;
}
