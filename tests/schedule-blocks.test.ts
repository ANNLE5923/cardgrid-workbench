import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrap,cancelBlock,conflict,putBlock,replaceTemplate,updateTemplate,validatePlanner,type Block} from '../src/planner.ts';
import {loadFixture,MON,TUE} from './helpers.ts';

// F-010/F-011 ScheduleOverride / TimeBlock：Fixed/Flexible 冲突、当天例外不污染模板
// 对应 AC-010/011、T-001/T-007、INV-003/004/005

function mk(id:string,title:string,start:number,end:number,kind:Block['kind']):Block{
  return {id,title,start,end,kind,task:'',cancelled:false};
}

test('conflict() 能识别 fixed 与 flexible 的时间重叠（INV-005 基础）',()=>{
  const fixed=mk('b-fixed','上课',840,960,'fixed'); // 14:00-16:00
  const flex=mk('b-flex','自习',900,960,'flexible'); // 15:00-16:00
  assert.equal(conflict([fixed],flex)!.id,'b-fixed');
  // 刚好相接不算冲突
  const justAfter=mk('b-just','下一段',960,1020,'flexible');
  assert.equal(conflict([fixed],justAfter),undefined);
});

test('putBlock：与 fixed 冲突时抛错且不写入（T-007 / INV-005）',()=>{
  const p=bootstrap(loadFixture(),TUE); // 周二固定安排日型，含 14:00-16:00 fixed 固定安排
  const before=p.days[0].blocks.length;
  assert.throws(()=>putBlock(p,TUE,mk('b-run','临时自习',900,960,'flexible'),TUE),/固定/);
  assert.equal(p.days[0].blocks.length,before); // 没有写入
  assert.doesNotThrow(()=>validatePlanner(p));
});

test('putBlock：与已存在 flexible 重叠也阻止（不静默覆盖）',()=>{
  const p=bootstrap(loadFixture(),TUE);
  // b-dinner 17:00-18:00 (1020-1080) flexible
  assert.throws(()=>putBlock(p,TUE,mk('b-x','撞晚饭',1050,1100,'flexible'),TUE));
});

test('putBlock：无冲突时新增 block 并记录 add_block 例外',()=>{
  const p=bootstrap(loadFixture(),TUE);
  putBlock(p,TUE,mk('b-new','夜跑',1290,1320,'flexible'),TUE); // 21:30-22:00，不撞
  assert.ok(p.days[0].blocks.some(b=>b.id==='b-new'));
  assert.ok(p.days[0].overrides.some(o=>o.type==='add_block'));
});

test('cancelBlock：只取消今天的 block，模板不变（T-001 / AC-010-02 / INV-003）',()=>{
  const p=bootstrap(loadFixture(),TUE);
  cancelBlock(p,TUE,'b-fixed-pm',TUE);
  // 当天
  assert.equal(p.days[0].blocks.find(b=>b.id==='b-fixed-pm')!.cancelled,true);
  assert.ok(p.days[0].overrides.some(o=>o.type==='cancel_block'));
  // 模板里仍未取消
  const tpl=p.templates.find(t=>t.id==='t-heavy')!;
  assert.equal(tpl.blocks.find(b=>b.id==='b-fixed-pm')!.cancelled,false);
  assert.doesNotThrow(()=>validatePlanner(p));
});

test('replaceTemplate：只改当天使用的日型，不修改模板定义本身（AC-010-01 / INV-003）',()=>{
  const p=bootstrap(loadFixture(),MON); // 周一默认普通日型 A
  replaceTemplate(p,MON,'t-heavy',MON);
  assert.equal(p.days[0].template,'t-heavy');
  assert.equal(p.days[0].name,'固定安排日型');
  // 模板数组没变
  assert.equal(p.templates.length,4);
  assert.ok(p.templates.some(t=>t.id==='t-free'));
  assert.ok(p.days[0].overrides.some(o=>o.type==='replace_template'));
});

test('模板内部 blocks 不允许相互冲突（validatePlanner 拒绝）',()=>{
  const p=loadFixture();
  const bad=JSON.parse(JSON.stringify(p.templates[1]));
  bad.blocks.push({id:'b-bad',title:'撞',start:900,end:950,kind:'flexible',task:'',cancelled:false});
  p.templates[1]=bad;
  assert.throws(()=>validatePlanner(p));
});

test('当天新增的 block 在再次 bootstrap 后保留（AC-011-05）',()=>{
  let p=bootstrap(loadFixture(),TUE);
  putBlock(p,TUE,mk('b-keep','夜跑',1290,1320,'flexible'),TUE);
  p=bootstrap(p,TUE); // 再次启动
  assert.ok(p.days.find(d=>d.date===TUE)!.blocks.some(b=>b.id==='b-keep'));
});

test('updateTemplate 修改模板，不改写已存在的当天例外',()=>{
  const p=loadFixture(); const day='2026-09-22'; const t=p.templates.find(t=>t.id==='t-heavy')!;
  const boot=bootstrap(p,day); const beforeDay=boot.days.find(d=>d.date===day)!; p.days=boot.days; p.tasks=boot.tasks; p.occurrences=boot.occurrences; p.history=boot.history; const nextBlocks=structuredClone(t.blocks); nextBlocks[0].title='改名固定安排';
  updateTemplate(p,t.id,t.name,nextBlocks,day);
  assert.equal(p.templates.find(x=>x.id===t.id)!.blocks[0].title,'改名固定安排');
  assert.equal(p.days.find(d=>d.date===day)!.blocks[0].title,beforeDay.blocks[0].title);
});

test('updateTemplate 拒绝模板内部冲突且保留原模板',()=>{
  const p=loadFixture(); const t=p.templates.find(t=>t.id==='t-heavy')!; const blocks=structuredClone(t.blocks); blocks[1].start=blocks[0].start+10;
  assert.throws(()=>updateTemplate(p,t.id,t.name,blocks));
  assert.notEqual(p.templates.find(x=>x.id===t.id)!.blocks[1].start,blocks[0].start+10);
});

test('历史日期安排不可修改',()=>{
  const p=loadFixture(); const past='2026-09-20'; const t=p.templates.find(t=>t.id==='t-free')!;
  assert.throws(()=>replaceTemplate(p,past,t.id,'2026-09-22'),/过去日期的安排不可修改/);
});
