import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, ok } from './v3-fixtures.ts';
import { b4Harness } from '../../support/v06/b4-fixtures.ts';
import { createV06Host } from '../../../src/workspace/v06-host.ts';
import { upgradeV3ToV4 } from '../../../src/workspace/format.ts';

// v0.6.5 P0-B：readSafeOpen 对各代当前信封都必须只读打开、原文可往返导出、零写入，
// 且不隐式升级。解析器 parseSafeRecovery 与 dataFormat 无关，这里锁定该契约。

async function v3Host() {
  const legacy = harness({ version: 3 });
  const host = createV06Host({ store: legacy.store });
  return { legacy, host, expectedFormat: 'action-v3' as const };
}

async function v4Host() {
  const legacy = harness({ version: 3 });
  const v3 = legacy.evidence().raw as any;
  legacy.store.__setRaw({
    ...v3,
    dataFormat: 'action-v4',
    data: upgradeV3ToV4(v3.data),
  });
  const host = createV06Host({ store: legacy.store });
  return { legacy, host, expectedFormat: 'action-v4' as const };
}

async function v5Host() {
  const h = await b4Harness();
  return { legacy: h.legacy, host: h.host, expectedFormat: 'action-v5' as const };
}

for (const [name, make] of [
  ['action-v3', v3Host],
  ['action-v4', v4Host],
  ['action-v5', v5Host],
] as const) {
  test(`safe-open 矩阵：${name} 当前信封只读打开、原文往返、零写入、不升级`, async () => {
    const { legacy, host, expectedFormat } = await make();
    const before = legacy.evidence();

    const d = ok(await host.readSafeOpen());
    assert.equal(d.report.outer.dataFormat, expectedFormat);

    // 原文文本可往返：导出再解析与当前原始信封一致。
    assert.equal(typeof d.rawText, 'string');
    assert.deepEqual(JSON.parse(d.rawText!), before.raw);

    // 恢复点列表始终可用（数组；具体有无取决于历史写入）。
    assert.ok(Array.isArray(d.recoveryPoints));
    for (const p of d.recoveryPoints) {
      assert.equal(typeof p.key, 'string');
      assert.ok(p.report.outer.dataFormat !== '未知' || p.rawText !== null);
    }

    // 全程零写入：raw / recovery / 写计数都不变。
    assert.deepEqual(legacy.evidence(), before);

    // 正常 load 看到的 dataFormat 不变，证明诊断没有隐式升级当前数据。
    const loaded = await host.load();
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      const fmt = (loaded as any).value?.raw?.dataFormat;
      assert.equal(fmt, expectedFormat);
    }
  });
}
