import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrap,setTodayMode,top3,validatePlanner,type Planner} from '../src/planner.ts';
import {loadFixture,MON} from './helpers.ts';

// F-013 Minimum Day / INV-008：切换最低运行模式不得删除或改期原计划。
// 注意：planner.ts 当前没有 SetTodayMode 领域命令，Day.minimum 是裸布尔字段，
// 也没有写 TodayModeChanged 历史事件——这是阶段1记录的实现缺口（见交接文档）。
// 本测试只验证"切换 minimum 这个标志本身不会破坏原计划数据"这一不变量。

function dayOf(p:Planner,date:string){return p.days.find(d=>d.date===date)!;}

test('进入 Minimum Day：原 blocks / top3 / tasks 全部保留，不删除不改期（AC-013-03 / INV-008）',()=>{
  let p=bootstrap(loadFixture(),MON);
  // 先选一个 routine task 进 top3，让 day 有非空 top3
  const routineTask=p.tasks.find(t=>t.source==='routine')!;
  top3(p,MON,[routineTask.id],MON);
  const beforeBlocks=structuredClone(dayOf(p,MON).blocks);
  const beforeTop3=structuredClone(dayOf(p,MON).top3);
  const beforeTaskCount=p.tasks.length;

  // 用户切换到 Minimum Day（领域层目前只是翻转标志）
  setTodayMode(p,MON,true,MON);

  assert.equal(dayOf(p,MON).minimum,true);
  assert.deepEqual(dayOf(p,MON).blocks,beforeBlocks);
  assert.deepEqual(dayOf(p,MON).top3,beforeTop3);
  assert.equal(p.tasks.length,beforeTaskCount);
  // 原 routine task 仍在、日期仍在今天
  assert.ok(p.tasks.find(t=>t.id===routineTask.id));
  assert.doesNotThrow(()=>validatePlanner(p));
});

test('退出 Minimum Day：原计划完整可见，不重新生成任务（AC-013-05）',()=>{
  let p=bootstrap(loadFixture(),MON);
  const routineTask=p.tasks.find(t=>t.source==='routine')!;
  top3(p,MON,[routineTask.id],MON);
  setTodayMode(p,MON,true,MON);
  const taskCountBeforeExit=p.tasks.length;
  const blocksBeforeExit=structuredClone(dayOf(p,MON).blocks);

  setTodayMode(p,MON,false,MON);
  assert.equal(dayOf(p,MON).minimum,false);
  assert.equal(p.tasks.length,taskCountBeforeExit); // 没有重新生成
  assert.deepEqual(dayOf(p,MON).blocks,blocksBeforeExit);
  assert.deepEqual(dayOf(p,MON).top3,[routineTask.id]);
});

test('Minimum Day 只是标志翻转，不影响 routine occurrence 状态',()=>{
  let p=bootstrap(loadFixture(),MON);
  const occStatusBefore=structuredClone(p.occurrences.map(o=>o.status));
  setTodayMode(p,MON,true,MON);
  assert.deepEqual(p.occurrences.map(o=>o.status),occStatusBefore);
});
