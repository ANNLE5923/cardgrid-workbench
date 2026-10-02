import test from 'node:test';
import assert from 'node:assert/strict';
import {createCapture,type Planner} from '../src/planner.ts';
import {loadFixture} from './helpers.ts';

// Explicit time zones keep the regression reproducible on local machines and UTC CI.
// This file runs tests serially; always restore TZ for subsequent tests.
test('R2-02: createCapture 历史事件日期使用本地日历日（上海 / UTC）',()=>{
  const previousTZ=process.env.TZ;
  try{
    for(const [timezone,expected] of [['Asia/Shanghai','2026-09-21'],['UTC','2026-09-20']]){
      process.env.TZ=timezone;
      const p:Planner=loadFixture();
      createCapture(p,'凌晨捕获','quick_capture','2026-09-20T17:00:00.000Z');
      const ev=p.history.find(h=>h.type==='InboxItemCaptured')!;
      assert.equal(ev.date,expected,timezone);
    }
  }finally{
    if(previousTZ===undefined)delete process.env.TZ;
    else process.env.TZ=previousTZ;
  }
});

// The real R2-01 browser regression is in tests/browser/g0.mjs (C-* and transaction-abort).
// Keep the tracking item visible without counting an unconditional assertion as a pass.
test('R2-01 页面保存失败留输入：由浏览器 G0 测试验证',{skip:'运行 tests/browser/g0.mjs'},()=>{
  assert.ok(true);
});
