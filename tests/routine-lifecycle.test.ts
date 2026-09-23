import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrap,changeStatus,makeup} from '../src/planner.ts';
import {loadFixture,MON,TUE} from './helpers.ts';

// F-006/F-007/F-008 Routine 生命周期：不重复、跳过、错过、补做不改历史
// 对应 AC-006/007/008、T-002/T-003/T-004、INV-001/002/009/012

function routineTask(p:ReturnType<typeof bootstrap>,ruleId:string,day:string){
  const o=p.occurrences.find(o=>o.rule===ruleId&&o.date===day)!;
  return {occurrence:o,task:p.tasks.find(t=>t.id===o.task)!};
}

test('今天跳过 routine：occurrence→skipped，rule 仍 active，明天照常生成（T-002）',()=>{
  let p=bootstrap(loadFixture(),MON);
  const {task}=routineTask(p,'r-routine-a',MON);
  changeStatus(p,task.id,'skipped',MON);
  assert.equal(p.occurrences.find(o=>o.date===MON)!.status,'skipped');
  assert.equal(p.rules.find(r=>r.id==='r-routine-a')!.status,'active'); // 规则本身不变
  // 第二天：周一 skipped 不会被改 missed，周二新 occurrence 正常生成
  p=bootstrap(p,TUE);
  assert.equal(p.occurrences.find(o=>o.date===MON)!.status,'skipped');
  assert.equal(p.occurrences.filter(o=>o.date===TUE&&o.rule==='r-routine-a').length,1);
});

test('今天完成 routine：occurrence→completed',()=>{
  const p=bootstrap(loadFixture(),MON);
  const {task}=routineTask(p,'r-routine-a',MON);
  changeStatus(p,task.id,'done',MON);
  assert.equal(p.occurrences.find(o=>o.date===MON)!.status,'completed');
  assert.equal(task.status,'done');
});

test('未处理到第二天：昨天 generated→missed，今天新 occurrence 正常生成（T-003）',()=>{
  let p=bootstrap(loadFixture(),MON);
  const monId=p.occurrences.find(o=>o.date===MON)!.id;
  p=bootstrap(p,TUE);
  assert.equal(p.occurrences.find(o=>o.id===monId)!.status,'missed');
  assert.ok(p.occurrences.some(o=>o.date===TUE));
});

test('补做：原 occurrence 保持 missed 且日期不变，新 task 指向 source_occurrence（T-004 / INV-002）',()=>{
  let p=bootstrap(loadFixture(),MON);
  const monOccId=p.occurrences.find(o=>o.date===MON&&o.rule==='r-routine-a')!.id;
  p=bootstrap(p,TUE); // 周一 → missed
  const before=structuredClone(p.occurrences.find(o=>o.id===monOccId)!);
  const task=makeup(p,monOccId,TUE);
  // 原事实不动
  const after=p.occurrences.find(o=>o.id===monOccId)!;
  assert.equal(after.date,before.date);
  assert.equal(after.status,'missed');
  // 新补做任务在今天，关联 source
  assert.equal(task.date,TUE);
  assert.equal(task.makeupOf,monOccId);
  assert.equal(task.status,'planned');
  assert.ok(task.title.startsWith('补做 · '));
  assert.ok(p.history.some(h=>h.type==='RoutineOccurrenceMakeupCreated'));
});

test('补做幂等：对同一 missed occurrence 重复补做不产生第二个 task',()=>{
  let p=bootstrap(loadFixture(),MON);
  const monOccId=p.occurrences.find(o=>o.date===MON&&o.rule==='r-routine-a')!.id;
  p=bootstrap(p,TUE);
  const first=makeup(p,monOccId,TUE);
  const count=p.tasks.filter(t=>t.makeupOf===monOccId).length;
  const second=makeup(p,monOccId,TUE);
  assert.equal(second.id,first.id);
  assert.equal(p.tasks.filter(t=>t.makeupOf===monOccId).length,count);
});

test('补做只允许 missed/skipped；对当天 generated 不能补做',()=>{
  const p=bootstrap(loadFixture(),MON);
  const monOccId=p.occurrences.find(o=>o.date===MON&&o.rule==='r-routine-a')!.id;
  assert.throws(()=>makeup(p,monOccId,MON)); // 当天 generated，不是 missed/skipped
});

test('过去的 routine 不能直接改状态，必须走补做（INV-002）',()=>{
  let p=bootstrap(loadFixture(),MON);
  const {task}=routineTask(p,'r-routine-a',MON);
  p=bootstrap(p,TUE); // 周一 → missed
  assert.throws(()=>changeStatus(p,task.id,'done',TUE),/过去的例行/);
});

test('Card done → reopened：两条事件都保留，原完成历史不被删除（AC-015-02 / INV-009）',()=>{
  const p=bootstrap(loadFixture(),MON);
  const {task}=routineTask(p,'r-routine-a',MON);
  changeStatus(p,task.id,'done',MON);
  changeStatus(p,task.id,'doing',MON);
  const types=p.history.map(h=>h.type);
  assert.ok(types.includes('CardCompleted'));
  assert.ok(types.includes('CardReopened'));
  assert.equal(task.status,'doing');
});
