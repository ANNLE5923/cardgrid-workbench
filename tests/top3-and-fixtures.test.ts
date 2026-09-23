import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrap,newTask,top3,validatePlanner} from '../src/planner.ts';
import {loadFixture,MON,TUE,FRI,SUN} from './helpers.ts';

// F-012 Top3：最多 3、不改 Card 状态（AC-012、INV-006/007）
// 以及四种日型 fixture 自身合法性

test('Top3 最多 3 个，重复 id 或不存在的 id 都拒绝',()=>{
  const p=bootstrap(loadFixture(),MON);
  const ids=p.tasks.filter(t=>t.source==='routine').map(t=>t.id);
  top3(p,MON,ids.slice(0,2),MON);
  assert.equal(p.days[0].top3.length,2);
  assert.throws(()=>top3(p,MON,[...ids.slice(0,2),ids[0]],MON)); // 重复
  assert.throws(()=>top3(p,MON,['nope-1','nope-2','nope-3'],MON)); // 不存在
  assert.throws(()=>top3(p,MON,['a','b','c','d'],MON)); // 超过 3
});

test('Top3 不改变 Card 的业务状态（INV-007）',()=>{
  const p=bootstrap(loadFixture(),MON);
  const task=p.tasks.find(t=>t.source==='routine')!;
  const beforeStatus=task.status;
  top3(p,MON,[task.id],MON);
  assert.equal(task.status,beforeStatus);
  assert.ok(p.history.some(h=>h.type==='Top3Changed'));
});

test('Top3 允许 0/1/2/3 个，移除不取消 Card',()=>{
  const p=bootstrap(loadFixture(),MON);
  const task=p.tasks.find(t=>t.source==='routine')!;
  top3(p,MON,[task.id],MON);
  top3(p,MON,[],MON); // 清空
  assert.deepEqual(p.days[0].top3,[]);
  assert.ok(p.tasks.some(t=>t.id===task.id)); // Card 仍在
});

// --- 四种日型 fixture 合法性 ---

test('fixture：four-templates.json 通过 validatePlanner，且包含四种日型',()=>{
  const p=validatePlanner(loadFixture());
  assert.equal(p.templates.length,4);
  const names=p.templates.map(t=>t.name);
  assert.ok(names.includes('普通日型 A'));
  assert.ok(names.includes('固定安排日型'));
  assert.ok(names.includes('普通日型 B'));
  assert.ok(names.includes('轻量日型'));
});

test('fixture：四种日型 weekdays 互不重叠，覆盖七天',()=>{
  const p=loadFixture();
  const all=new Set<number>();
  for(const t of p.templates){
    for(const w of t.weekdays){
      assert.ok(!all.has(w),`星期${w} 被多个模板占用`);
      all.add(w);
    }
  }
  assert.equal(all.size,7); // 0..6 全覆盖
});

test('fixture：每个模板内部 blocks 无冲突，且 fixed/flexible 可区分',()=>{
  const p=loadFixture();
  for(const t of p.templates){
    for(const b of t.blocks){
      assert.ok(b.start<b.end);
      assert.ok(['fixed','flexible'].includes(b.kind));
    }
    // 两两不重叠
    for(let i=0;i<t.blocks.length;i++)for(let j=i+1;j<t.blocks.length;j++){
      const a=t.blocks[i],c=t.blocks[j];
      assert.ok(!(a.start<c.end&&c.start<a.end),`模板${t.name}内部时间块重叠`);
    }
  }
  // 固定安排日型必须有 fixed；轻量日型以 flexible 为主
  assert.ok(p.templates.find(t=>t.id==='t-heavy')!.blocks.some(b=>b.kind==='fixed'));
});

test('fixture：一周内各天 bootstrap 匹配到预期日型',()=>{
  for(const [d,expected] of [[MON,'t-free'],[TUE,'t-heavy'],[FRI,'t-half'],[SUN,'t-rest']] as const){
    const p=bootstrap(loadFixture(),d);
    assert.equal(p.days[0].template,expected,d);
  }
});

test('fixture：bootstrap 后 routine task 与 day 关联满足保存契约',()=>{
  const p=bootstrap(loadFixture(),MON);
  assert.doesNotThrow(()=>validatePlanner(p));
  // 新增一个 inbox task 并放进 top3，验证完整闭环
  const t=newTask('手动事项',MON);
  p.tasks.push(t);
  top3(p,MON,[t.id],MON);
  assert.doesNotThrow(()=>validatePlanner(p));
});
