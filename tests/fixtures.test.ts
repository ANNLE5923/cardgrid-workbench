import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {validatePlanner, type Planner} from '../src/planner.ts';

// 阶段4交付：验证 tests/fixtures/ 下所有 fixture 可通过 validatePlanner。
// 新增 fixture 时在此数组中注册即可自动覆盖。

const FIXTURES = [
  'four-templates.json',
  'routine-scenarios.json',
  'schedule-scenarios.json',
] as const;

function loadFixture(name: string): Planner {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  const data = JSON.parse(readFileSync(path, 'utf8'));
  delete data._comment;
  return data as Planner;
}

for (const name of FIXTURES) {
  test(`fixture ${name} 通过 validatePlanner`, () => {
    const p = loadFixture(name);
    const validated = validatePlanner(p);
    assert.ok(validated, 'validatePlanner 应返回验证后的 Planner');
  });
}

test('routine-scenarios 包含六种状态', () => {
  const p = loadFixture('routine-scenarios.json');
  const statuses = new Set(p.occurrences.map(o => o.status));
  assert.ok(statuses.has('missed'), '应有 missed');
  assert.ok(statuses.has('generated'), '应有 generated');
  assert.ok(statuses.has('skipped'), '应有 skipped');
  const ruleStatuses = new Set(p.rules.map(r => r.status));
  assert.ok(ruleStatuses.has('active'), '应有 active rule');
  assert.ok(ruleStatuses.has('paused'), '应有 paused rule');
  assert.ok(ruleStatuses.has('archived'), '应有 archived rule');
  assert.ok(p.tasks.some(t => t.makeupOf), '应有补做任务');
});

test('schedule-scenarios 包含三种当天例外', () => {
  const p = loadFixture('schedule-scenarios.json');
  const overrideTypes = new Set(p.days.flatMap(d => d.overrides.map(o => o.type)));
  assert.ok(overrideTypes.has('add_block'), '应有 add_block');
  assert.ok(overrideTypes.has('cancel_block'), '应有 cancel_block');
  assert.ok(overrideTypes.has('replace_template'), '应有 replace_template');
  // 至少有一个 fixed 块供冲突测试
  assert.ok(p.templates.some(t => t.blocks.some(b => b.kind === 'fixed')), '应有 fixed 块');
});
