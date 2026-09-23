import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveCapture,createCapture,discardCapture,resolveCapture,validatePlanner} from '../src/planner.ts';
import {loadFixture,MON} from './helpers.ts';

// F-004/F-005 Quick Capture → Inbox → Card 的页面层命令（阶段2接通）
// createCapture / discardCapture / archiveCapture 由主线补进 planner.ts；
// 这里覆盖它们的状态流、幂等和与 resolveCapture 的衔接。

test('createCapture：产生 unprocessed capture，不建 task、不进 Today（AC-004-01 / T-006）',()=>{
  const p=loadFixture();
  const taskCount=p.tasks.length;
  const c=createCapture(p,'小说工作台增加时间线','quick_capture');
  assert.equal(c.status,'unprocessed');
  assert.equal(c.target,'');
  assert.equal(p.captures.length,1);
  assert.equal(p.tasks.length,taskCount); // 没有自动建 Card
  assert.ok(Number.isFinite(Date.parse(c.at)));
  assert.ok(p.history.some(h=>h.type==='InboxItemCaptured'));
  assert.doesNotThrow(()=>validatePlanner(p));
});

test('createCapture 拒绝空文本',()=>{
  const p=loadFixture();
  assert.throws(()=>createCapture(p,'   '));
  assert.equal(p.captures.length,0);
});

test('discardCapture：unprocessed→discarded，幂等；resolved 不能丢弃（AC-005-05）',()=>{
  const p=loadFixture();
  const c=createCapture(p,'待丢弃');
  discardCapture(p,c.id,MON);
  assert.equal(p.captures.find(x=>x.id===c.id)!.status,'discarded');
  assert.ok(p.history.some(h=>h.type==='InboxItemDiscarded'));
  // 幂等
  discardCapture(p,c.id,MON);
  assert.equal(p.captures.filter(x=>x.status==='discarded').length,1);
  // resolved 不能丢弃
  const c2=createCapture(p,'转Card');
  resolveCapture(p,c2.id,'标题',MON,MON);
  assert.throws(()=>discardCapture(p,c2.id,MON));
});

test('archiveCapture：unprocessed→archived，幂等；resolved 不能归档',()=>{
  const p=loadFixture();
  const c=createCapture(p,'待归档');
  archiveCapture(p,c.id,MON);
  assert.equal(p.captures.find(x=>x.id===c.id)!.status,'archived');
  assert.ok(p.history.some(h=>h.type==='InboxItemArchived'));
  archiveCapture(p,c.id,MON); // 幂等
  assert.equal(p.captures.filter(x=>x.status==='archived').length,1);
  const c2=createCapture(p,'转Card2');
  resolveCapture(p,c2.id,'标题',MON,MON);
  assert.throws(()=>archiveCapture(p,c2.id,MON));
});

test('串联：create → resolve → 原始文本可追溯，重复 resolve 不产生第二个 Card（AC-005-04 / INV-010）',()=>{
  const p=loadFixture();
  const c=createCapture(p,'给小说工作台加时间线');
  const t=resolveCapture(p,c.id,'给小说工作台加时间线','',MON); // 不给日期 → inbox
  assert.equal(t.status,'inbox');
  assert.equal(t.date,'');
  assert.equal(p.captures.find(x=>x.id===c.id)!.status,'resolved');
  assert.equal(p.captures.find(x=>x.id===c.id)!.text,'给小说工作台加时间线'); // 原文保留
  const again=resolveCapture(p,c.id,'另一个标题','',MON);
  assert.equal(again.id,t.id); // 幂等
  assert.equal(p.tasks.filter(x=>x.source===c.id).length,1);
});

test('discarded 后不能再 resolve',()=>{
  const p=loadFixture();
  const c=createCapture(p,'要丢的');
  discardCapture(p,c.id,MON);
  assert.throws(()=>resolveCapture(p,c.id,'x',MON,MON));
});

test('完整 Inbox 操作流后仍通过 validatePlanner',()=>{
  const p=loadFixture();
  const a=createCapture(p,'想法A');
  const b=createCapture(p,'想法B');
  const c=createCapture(p,'想法C');
  resolveCapture(p,a.id,'想法A',MON,MON);
  discardCapture(p,b.id,MON);
  archiveCapture(p,c.id,MON);
  assert.doesNotThrow(()=>validatePlanner(p));
  assert.equal(p.captures.find(x=>x.id===a.id)!.status,'resolved');
  assert.equal(p.captures.find(x=>x.id===b.id)!.status,'discarded');
  assert.equal(p.captures.find(x=>x.id===c.id)!.status,'archived');
});
