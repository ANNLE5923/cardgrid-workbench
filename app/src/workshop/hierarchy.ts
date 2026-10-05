/**
 * Workshop navigation over pools.
 * parentPoolId is NAVIGATION only and may cross poolKind (a book pool may hang under an action pool);
 * memberIds stay restricted to the pool's own kind and are not handled here.
 * Pure, node-safe and tolerant of missing parents / cycles (A1 validation normally rejects those).
 */
import type {Id, Pool} from '../workspace/index.ts';

export type PoolNode = Readonly<{id: Id; depth: number; pool: Pool}>;

const byId = (pools: readonly Pool[]): Map<Id, Pool> => new Map(pools.map(p => [p.id, p]));

/** Direct children of a parent; parentId === null returns the real top-level pools. */
export function childrenOf(pools: readonly Pool[], parentId: Id | null): readonly Pool[] {
  return pools.filter(p => p.parentPoolId === parentId);
}
/** Pools whose declared parent does not exist. A1 validation rejects these; navigation must not hide them. */
export function orphanPools(pools: readonly Pool[]): readonly Pool[] {
  const map = byId(pools);
  return pools.filter(p => p.parentPoolId !== null && !map.has(p.parentPoolId!));
}
/** Root layer: real top-level pools plus broken-link orphans so nothing disappears from the browser. */
export function rootPools(pools: readonly Pool[]): readonly Pool[] {
  const map = byId(pools);
  return pools.filter(p => p.parentPoolId === null || !map.has(p.parentPoolId!));
}
/** Root -> target id chain, including the target. Stops on a missing parent or a cycle. */
export function pathTo(pools: readonly Pool[], targetId: Id): readonly Id[] {
  const map = byId(pools);
  const chain: Id[] = [];
  const guard = new Set<Id>();
  let current: Pool | undefined = map.get(targetId);
  while (current) {
    if (guard.has(current.id)) break;
    guard.add(current.id);
    chain.unshift(current.id);
    current = current.parentPoolId === null ? undefined : map.get(current.parentPoolId);
  }
  return chain;
}
/** Every descendant id of the given pool (cycle-safe). */
export function descendantsOf(pools: readonly Pool[], ancestorId: Id): readonly Id[] {
  const out: Id[] = [];
  const guard = new Set<Id>([ancestorId]);
  let frontier: Id[] = [ancestorId];
  while (frontier.length) {
    const nextFrontier: Id[] = [];
    for (const parent of frontier) {
      for (const child of childrenOf(pools, parent)) {
        if (guard.has(child.id)) continue;
        guard.add(child.id); out.push(child.id); nextFrontier.push(child.id);
      }
    }
    frontier = nextFrontier;
  }
  return out;
}
/** Pools allowed to become self's parent: every pool except self and self's descendants (cycle guard).
 *  Crosses poolKind because parentPoolId is navigation, not membership. */
export function allowedParentPools(pools: readonly Pool[], selfId: Id | null): readonly Pool[] {
  const blocked = new Set<Id>(selfId ? [selfId, ...descendantsOf(pools, selfId)] : []);
  return pools.filter(p => !blocked.has(p.id));
}
/** Depth-first flattening from the root layer; orphans are appended at depth 0. */
export function buildPoolTree(pools: readonly Pool[]): readonly PoolNode[] {
  const nodes: PoolNode[] = [];
  const seen = new Set<Id>();
  const visit = (parent: Id, depth: number) => {
    for (const child of childrenOf(pools, parent)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      nodes.push({id: child.id, depth, pool: child});
      visit(child.id, depth + 1);
    }
  };
  for (const root of rootPools(pools)) {
    if (seen.has(root.id)) continue;
    seen.add(root.id);
    nodes.push({id: root.id, depth: 0, pool: root});
    visit(root.id, 1);
  }
  return nodes;
}
