import test from 'node:test';
import assert from 'node:assert/strict';
import type {Id, Pool} from '../../../src/workspace/index.ts';
import {
  buildPoolTree, childrenOf, descendantsOf, allowedParentPools,
  orphanPools, pathTo, rootPools,
} from '../../../src/workshop/hierarchy.ts';

function pool(id: Id, poolKind: Pool['poolKind'], parentPoolId: Id | null, name = id): Pool {
  return {id, version: 1, name, poolKind, parentPoolId, memberIds: [], source: {kind: 'manual'}};
}
// P_A(action,root) -> P_B(book, cross-kind) -> P_C(book); P_A -> P_D(action)
// P_E(book,root); P_O(book, broken parent => orphan)
const pools: readonly Pool[] = [
  pool('P_A', 'action', null),
  pool('P_B', 'book', 'P_A'),
  pool('P_C', 'book', 'P_B'),
  pool('P_D', 'action', 'P_A'),
  pool('P_E', 'book', null),
  pool('P_O', 'book', 'MISSING'),
];

test('root layer includes real top-level pools plus broken-link orphans', () => {
  assert.deepEqual(new Set(rootPools(pools).map(p => p.id)), new Set(['P_A', 'P_E', 'P_O']));
  assert.deepEqual(orphanPools(pools).map(p => p.id), ['P_O']);
});

test('children resolve by parent, and null parent excludes orphans', () => {
  assert.deepEqual(new Set(childrenOf(pools, null).map(p => p.id)), new Set(['P_A', 'P_E']));
  assert.deepEqual(new Set(childrenOf(pools, 'P_A').map(p => p.id)), new Set(['P_B', 'P_D']));
  assert.deepEqual(childrenOf(pools, 'P_B').map(p => p.id), ['P_C']);
});

test('pathTo gives the root -> target breadcrumb chain', () => {
  assert.deepEqual(pathTo(pools, 'P_C'), ['P_A', 'P_B', 'P_C']);
  assert.deepEqual(pathTo(pools, 'P_A'), ['P_A']);
  assert.deepEqual(pathTo(pools, 'P_O'), ['P_O']); // broken parent stops at the orphan
});

test('descendantsOf lists the whole subtree (cycle-safe)', () => {
  assert.deepEqual(new Set(descendantsOf(pools, 'P_A')), new Set(['P_B', 'P_C', 'P_D']));
  assert.deepEqual(descendantsOf(pools, 'P_C'), []);
});

test('allowed parents cross poolKind but exclude self and descendants to prevent cycles', () => {
  // P_C may be hung under an action pool (P_A/P_D) but not under itself.
  assert.deepEqual(new Set(allowedParentPools(pools, 'P_C').map(p => p.id)),
    new Set(['P_A', 'P_B', 'P_D', 'P_E', 'P_O']));
  // P_B cannot choose itself or its descendant P_C; cross-kind parent P_A stays available.
  assert.deepEqual(new Set(allowedParentPools(pools, 'P_B').map(p => p.id)),
    new Set(['P_A', 'P_D', 'P_E', 'P_O']));
  // A brand-new pool (no self id) can choose any existing pool, across kinds.
  assert.deepEqual(new Set(allowedParentPools(pools, null).map(p => p.id)),
    new Set(['P_A', 'P_B', 'P_C', 'P_D', 'P_E', 'P_O']));
});

test('buildPoolTree reports correct depths and keeps every pool', () => {
  const depth = new Map(buildPoolTree(pools).map(n => [n.id, n.depth]));
  assert.equal(depth.get('P_A'), 0);
  assert.equal(depth.get('P_B'), 1);
  assert.equal(depth.get('P_C'), 2);
  assert.equal(depth.get('P_D'), 1);
  assert.equal(depth.get('P_E'), 0);
  assert.equal(depth.get('P_O'), 0);
  assert.equal(buildPoolTree(pools).length, 6);
});
