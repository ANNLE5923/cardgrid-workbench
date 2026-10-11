import test from 'node:test';
import assert from 'node:assert/strict';
import { b4Harness, ok } from '../../support/v06/b4-fixtures.ts';

// v0.6.5 P0-A：Data v5 当前数据认证失败时，readSafeOpen 仍能只读打开，
// 直读当前信封与 recovery/previous，全程不写入、不隐式升级、不抛业务错误。

test('safe-open: healthy v5 只读诊断返回当前信封与 previous，且零写入', async () => {
  const h = await b4Harness();
  const before = h.legacy.evidence();
  const d = ok(await h.host.readSafeOpen());
  assert.equal(d.report.outer.dataFormat, 'action-v5');
  assert.equal(d.report.outer.schemaVersion, '4');
  assert.equal(typeof d.rawText, 'string');
  assert.ok(d.rawText!.includes('"dataFormat": "action-v5"'));
  assert.equal(d.recoveryPoints.length, 1);
  const previous = d.recoveryPoints[0];
  assert.equal(previous.key, 'previous');
  assert.equal(previous.report.outer.dataFormat, 'action-v5');
  const parsed = JSON.parse(previous.rawText!);
  assert.equal(parsed.data.version, 5, 'previous 里是一份可识别的 v5 信封');
  // 只读诊断不得产生任何写入。
  assert.deepEqual(h.legacy.evidence(), before);
});

const tamperCases = [
  [
    '未知根字段',
    (data: any) => {
      data.unknownSafeOpenMarker = true;
    },
  ],
  [
    '嵌套未知字段',
    (data: any) => {
      data.actionCards[0].unexpectedNestedMarker = 'x';
    },
  ],
  [
    '缺失必填字段',
    (data: any) => {
      delete data.workspaceId;
    },
  ],
] as const;

for (const [name, mutate] of tamperCases) {
  test(`safe-open: 当前 v5 损坏（${name}）时 load 失败但安全诊断仍可读，且零写入`, async () => {
    const h = await b4Harness();
    const cur = structuredClone(h.legacy.evidence().raw) as any;
    mutate(cur.data);
    h.legacy.store.__setRaw(cur);

    const load = await h.host.load();
    assert.equal(load.ok, false, '损坏的 v5 必须被正常 load 拒绝');

    const before = h.legacy.evidence();
    const d = ok(await h.host.readSafeOpen());
    assert.equal(d.report.outer.dataFormat, 'action-v5', '诊断仍能认出信封外壳');
    assert.equal(typeof d.rawText, 'string');
    // 上一份好数据仍在恢复点里、可解析、可导出。
    assert.equal(d.recoveryPoints.length, 1);
    const previous = d.recoveryPoints[0];
    assert.equal(previous.report.outer.dataFormat, 'action-v5');
    assert.equal(previous.report.totals.malformed, 0, 'previous 本身结构完好');
    const parsed = JSON.parse(previous.rawText!);
    assert.equal(parsed.data.version, 5);
    // 诊断全程只读。
    assert.deepEqual(h.legacy.evidence(), before);
    // 损坏后再次 load 仍失败，证明诊断没有顺手“修复/升级”当前数据。
    const reload = await h.host.load();
    assert.equal(reload.ok, false);
  });
}

test('safe-open: 当前信封不是对象时诊断也不抛错，仍列出恢复点且零写入', async () => {
  const h = await b4Harness();
  h.legacy.store.__setRaw(null);
  const load = await h.host.load();
  assert.equal(load.ok, false);

  const before = h.legacy.evidence();
  const d = ok(await h.host.readSafeOpen());
  assert.equal(d.rawText, 'null');
  assert.ok(d.report.problems.some((p) => p.message.includes('信封不是一个对象')));
  assert.equal(d.recoveryPoints.length, 1);
  assert.equal(d.recoveryPoints[0].report.outer.dataFormat, 'action-v5');
  assert.deepEqual(h.legacy.evidence(), before);
});
