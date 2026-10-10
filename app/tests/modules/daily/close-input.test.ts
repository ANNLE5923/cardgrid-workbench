import test from 'node:test';
import assert from 'node:assert/strict';
import type { DataV5 } from '../../../src/workspace/v06.ts';
import { materialBindings } from '../../../src/daily/close/close-input.ts';

/** materialBindings 只读取 handCards，用最小字段构造即可锁定"全量含已上表盘"这条接线承诺。 */
function card(partial: Record<string, unknown>): DataV5['handCards'][number] {
  return partial as unknown as DataV5['handCards'][number];
}

test('materials 取自全量 action/composite 卡（含已排进表盘、已到期），不收 answer', () => {
  const data = {
    handCards: [
      // 已排进表盘的行动素材：projectUnifiedHand 会把它过滤掉，但 materials 必须保留。
      card({
        kind: 'action',
        actionInstanceId: 'i-placed',
        state: 'available',
        consumedBy: null,
        expiresAt: null,
      }),
      // 已到期的合成素材：跨日计划锁定依赖它被纳入。
      card({
        kind: 'composite',
        actionInstanceId: 'i-expired',
        state: 'expired',
        consumedBy: null,
        expiresAt: '2026-10-10T16:00:00Z',
      }),
      // 已消费素材也要带上（MATERIAL_CONSUMED 门禁）。
      card({
        kind: 'action',
        actionInstanceId: 'i-consumed',
        state: 'consumed',
        consumedBy: 'fact-1',
        expiresAt: null,
      }),
      // 答案卡没有 actionInstanceId，不进入素材绑定。
      card({ kind: 'answer' }),
    ],
  } as unknown as DataV5;

  const bindings = materialBindings(data);
  assert.deepEqual(bindings.map((b) => b.instanceId).sort(), [
    'i-consumed',
    'i-expired',
    'i-placed',
  ]);
  const placed = bindings.find((b) => b.instanceId === 'i-placed');
  assert.equal(placed?.state, 'available');
  const expired = bindings.find((b) => b.instanceId === 'i-expired');
  assert.equal(expired?.state, 'expired');
});
