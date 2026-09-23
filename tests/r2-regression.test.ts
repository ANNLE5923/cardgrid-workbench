import test from 'node:test';
import assert from 'node:assert/strict';
import {createCapture,type Planner} from '../src/planner.ts';
import {loadFixture} from './helpers.ts';

// R2-02 回归：createCapture 写历史时应使用本地日历日，而非 UTC 日期。
// 当前 planner.ts:55 用 at.slice(0,10) 取 UTC 日期，在 UTC+8 凌晨捕获会归到昨天。
// 责任在主线改 planner.ts；这里先 skip 标记，主线修完去掉 skip 即变绿。
test('R2-02: createCapture 历史事件日期使用本地日历日',()=>{
  const p:Planner=loadFixture();
  // Asia/Shanghai (UTC+8)：UTC 2026-09-20 17:00 = 本地 2026-09-21 01:00
  createCapture(p,'凌晨捕获','quick_capture','2026-09-20T17:00:00.000Z');
  const ev=p.history.find(h=>h.type==='InboxItemCaptured')!;
  // at.slice(0,10) 当前会给出 '2026-09-20'；正确应为本地日 '2026-09-21'
  assert.equal(ev.date,'2026-09-21');
});

// R2-01 是页面层保存契约（onSave 返回 boolean、成功才清空输入、busy 互斥）。
// 这些行为依赖 React 组件和 store.commit，无 jsdom/Playwright 无法在 node:test 覆盖。
// 回归方式：手动浏览器走查——在另一窗口提交导致 revision 冲突时，
// Quick Capture 输入框文本应保留、Inbox 编辑面板应不关闭。
test('R2-01 页面保存失败保留输入：依赖浏览器手动复验，无自动化用例',()=>{
  // 占位：此测试恒过，仅用于在测试列表里留下 R2-01 的追踪锚点。
  assert.ok(true);
});
