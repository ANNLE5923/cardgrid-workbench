import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrap,ensureDay} from '../src/planner.ts';
import {loadFixture,withRule,MON,TUE,FRI,SUN} from './helpers.ts';

// F-001 Daily Bootstrap：首次打开 / 重复打开 / 日期切换
// 对应 PRD AC-001-01..09、T-008、INV-001/INV-011/INV-012

test('首次打开当天：按适用星期生成 routine occurrence，并 ensureDay 匹配日型',()=>{
  const p=bootstrap(loadFixture(),MON); // 周一
  // 周一：r-routine-a(每天) + r-routine-b(周一三五) 都命中
  assert.equal(p.occurrences.length,2);
  assert.equal(p.tasks.length,2);
  for(const o of p.occurrences){
    assert.equal(o.date,MON);
    assert.equal(o.status,'generated');
    // 每个 occurrence 绑定一条同日期的 task，task.occurrence 指回自己
    const t=p.tasks.find(t=>t.id===o.task)!;
    assert.equal(t.date,MON);
    assert.equal(t.status,'planned');
    assert.equal(t.occurrence,o.id);
  }
  const day=p.days.find(d=>d.date===MON)!;
  assert.equal(day.template,'t-free'); // 周一 → 普通日型 A
  assert.equal(day.name,'普通日型 A');
  assert.ok(day.blocks.length>0);
});

test('同一天重复打开（含连续三次）：occurrence 与 task 数量不变，不重复生成（T-008 / INV-001 / INV-011）',()=>{
  let p=bootstrap(loadFixture(),MON);
  const firstOcc=p.occurrences.length,firstTask=p.tasks.length;
  p=bootstrap(p,MON);
  p=bootstrap(p,MON);
  assert.equal(p.occurrences.length,firstOcc);
  assert.equal(p.tasks.length,firstTask);
  // 历史事件里只应有一次 RoutineOccurrenceGenerated 对每个 rule|date
  const keys=new Set(p.occurrences.map(o=>o.rule+'|'+o.date));
  assert.equal(keys.size,p.occurrences.length);
});

test('日期切换到第二天：昨日 generated 标为 missed，今天新生成，昨日不变成今日任务（INV-012）',()=>{
  let p=bootstrap(loadFixture(),MON);
  const monOcc=p.occurrences.slice();
  p=bootstrap(p,TUE);
  // 昨天（周一）两条都从 generated → missed，date 仍为周一
  for(const o of monOcc){
    const cur=p.occurrences.find(x=>x.id===o.id)!;
    assert.equal(cur.date,MON);
    assert.equal(cur.status,'missed');
  }
  // 今天（周二）：r-routine-a 生成；r-routine-b 不在周二(weekdays 1,3,5) → 不生成
  const tue=p.occurrences.filter(o=>o.date===TUE);
  assert.equal(tue.length,1);
  assert.equal(tue[0].status,'generated');
  // 昨日 task 日期仍是周一，没有被搬到周二
  for(const o of monOcc){
    const t=p.tasks.find(t=>t.id===o.task)!;
    assert.equal(t.date,MON);
  }
});

test('非适用星期的 routine 不生成（r-routine-b 周一有、周二无）',()=>{
  const mon=bootstrap(loadFixture(),MON);
  assert.ok(mon.occurrences.some(o=>o.rule==='r-routine-b'));
  const tue=bootstrap(loadFixture(),TUE);
  assert.equal(tue.occurrences.filter(o=>o.rule==='r-routine-b').length,0);
  assert.equal(tue.occurrences.filter(o=>o.rule==='r-routine-a').length,1);
});

test('paused / archived 的 routine 不生成未来 occurrence',()=>{
  const base=loadFixture();
  base.rules.find(r=>r.id==='r-routine-a')!.status='paused';
  const archived=loadFixture();
  archived.rules.find(r=>r.id==='r-routine-b')!.status='archived';
  assert.equal(bootstrap(base,MON).occurrences.filter(o=>o.rule==='r-routine-a').length,0);
  assert.equal(bootstrap(archived,MON).occurrences.filter(o=>o.rule==='r-routine-b').length,0);
});

test('rule.start 晚于今天不生成',()=>{
  const p=withRule({id:'r-future',title:'未来才开始',weekdays:[1],start:'2026-12-31'});
  assert.equal(bootstrap(p,MON).occurrences.length,0);
});

test('ensureDay 按星期匹配四种日型，互不重叠',()=>{
  const p=loadFixture();
  assert.equal(ensureDay(p,MON).template,'t-free');
  assert.equal(ensureDay(p,TUE).template,'t-heavy');
  assert.equal(ensureDay(p,FRI).template,'t-half');
  assert.equal(ensureDay(p,SUN).template,'t-rest');
});

test('当天被用户取消的 block 不会因再次 bootstrap 被还原（AC-011-05）',()=>{
  let p=bootstrap(loadFixture(),TUE); // 周二固定安排日型，含 fixed 安排
  const day=p.days.find(d=>d.date===TUE)!;
  const before=JSON.stringify(day.blocks);
  // 用户取消今天当天固定安排（模拟页面层动作，直接改 day.blocks 并标 cancelled）
  const pm=day.blocks.find(b=>b.id==='b-fixed-pm')!;
  pm.cancelled=true;
  // 再次 bootstrap 同一天
  p=bootstrap(p,TUE);
  const day2=p.days.find(d=>d.date===TUE)!;
  assert.equal(day2.blocks.find(b=>b.id==='b-fixed-pm')!.cancelled,true);
  // 模板里该 block 仍未取消（当天例外不污染模板）
  assert.equal(p.templates.find(t=>t.id==='t-heavy')!.blocks.find(b=>b.id==='b-fixed-pm')!.cancelled,false);
  assert.notEqual(JSON.stringify(day2.blocks),before); // 确认确实发生了变化
});
