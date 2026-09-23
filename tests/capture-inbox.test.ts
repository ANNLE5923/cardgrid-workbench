import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveCapture,bootstrap,createCapture,resolveCapture,validatePlanner,type Planner,type Capture} from '../src/planner.ts';
import {loadFixture,MON} from './helpers.ts';

// F-004 Quick Capture / F-005 Inbox / INV-010
// 注意：planner 层没有"创建 capture"的领域命令（Quick Capture 的写入在页面层，阶段2才做）。
// 这里直接构造 unprocessed capture 推入 planner.captures，等价于"Quick Capture 已经产生了一条 InboxItem"。

function pushCapture(p:Planner,partial:Partial<Capture>={}):Capture {
  const c:Capture={id:partial.id||'cap-1',text:partial.text||'小说工作台增加人物时间线',at:partial.at||new Date().toISOString(),source:partial.source||'quick_capture',status:partial.status||'unprocessed',target:partial.target||''};
  p.captures.push(c);
  return c;
}

test('createCapture 只写入领域 Inbox，不创建任务并记录事件',()=>{
  const p=loadFixture();
  const c=createCapture(p,'  临时想法  ','quick_capture',`${MON}T09:00:00.000Z`);
  assert.equal(c.text,'临时想法'); assert.equal(c.status,'unprocessed'); assert.equal(p.tasks.length,0);
  assert.ok(p.history.some(h=>h.type==='InboxItemCaptured'&&h.entity===c.id));
});

test('archiveCapture 将未处理记录归档且可重复调用',()=>{
  const p=loadFixture(); const c=createCapture(p,'稍后处理',undefined,`${MON}T09:00:00.000Z`);
  archiveCapture(p,c.id,MON); archiveCapture(p,c.id,MON);
  assert.equal(c.status,'archived');
  assert.equal(p.history.filter(h=>h.type==='InboxItemArchived').length,1);
  assert.throws(()=>resolveCapture(p,c.id,'不能转换',MON,MON));
});

test('Quick Capture 只产生 unprocessed InboxItem，不自动建 Card、不进 Today（T-006 / AC-004-01）',()=>{
  const p=loadFixture();
  const beforeTasks=p.tasks.length;
  pushCapture(p);
  // 捕获本身不是 Card：tasks 没有新增，capture 是 unprocessed
  assert.equal(p.tasks.length,beforeTasks);
  assert.equal(p.captures[0].status,'unprocessed');
  assert.equal(p.captures[0].target,'');
  // 合法保存
  assert.doesNotThrow(()=>validatePlanner(p));
});

test('resolveCapture 把 InboxItem 转成 Card：capture→resolved，target 指向新 task',()=>{
  const p=loadFixture();
  pushCapture(p,{id:'cap-1'});
  const task=resolveCapture(p,'cap-1','小说工作台增加人物时间线',MON,MON);
  assert.equal(p.captures[0].status,'resolved');
  assert.equal(p.captures[0].target,task.id);
  assert.equal(task.title,'小说工作台增加人物时间线');
  // 给了日期 → planned；不给日期 → inbox
  assert.equal(task.date,MON);
  assert.equal(task.status,'planned');
  // 原始文本仍可追溯（INV-010）
  assert.equal(p.captures[0].text,'小说工作台增加人物时间线');
  assert.ok(p.history.some(h=>h.type==='InboxItemResolved'));
});

test('resolveCapture 不带日期时，新 Card 停在 inbox，不自动进 Today（AC-004-05 / T-006）',()=>{
  const p=loadFixture();
  pushCapture(p,{id:'cap-2'});
  const task=resolveCapture(p,'cap-2','给小说工作台加时间线','',MON);
  assert.equal(task.status,'inbox');
  assert.equal(task.date,'');
  // 它不在任何 day 的 top3 里
  for(const d of p.days)assert.ok(!d.top3.includes(task.id));
});

test('同一 InboxItem 重复 resolve 不产生第二个 Card（AC-005-04 / 规则 D）',()=>{
  const p=loadFixture();
  pushCapture(p,{id:'cap-3'});
  const first=resolveCapture(p,'cap-3','标题A',MON,MON);
  const taskCount=p.tasks.length;
  const second=resolveCapture(p,'cap-3','标题B',MON,MON);
  assert.equal(second.id,first.id);
  assert.equal(p.tasks.length,taskCount); // 没有第二个 Card
  assert.equal(p.captures[0].status,'resolved');
});

test('discarded 的 InboxItem 不能再 resolve',()=>{
  const p=loadFixture();
  pushCapture(p,{id:'cap-4',status:'discarded'});
  assert.throws(()=>resolveCapture(p,'cap-4','x',MON,MON));
});

test('bootstrap 不会把 unprocessed capture 变成 routine occurrence',()=>{
  const p=loadFixture();
  pushCapture(p,{id:'cap-5'});
  const after=bootstrap(p,MON);
  // capture 原样保留，没有因为 bootstrap 被解析成 Card
  assert.equal(after.captures.length,1);
  assert.equal(after.captures[0].status,'unprocessed');
});
