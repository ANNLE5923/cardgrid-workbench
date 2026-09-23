import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {emptyPlanner,type Planner,type Rule} from '../src/planner.ts';

// 四种日型 fixture：普通日型 A[1,3,4,6] / 固定安排日型[2] / 普通日型 B[5] / 轻量日型[0]
// 周一 2026-09-21 起，一周正好覆盖全部四种日型，且 weekdays 互不重叠。
export function loadFixture():Planner {
  const path=fileURLToPath(new URL('./fixtures/four-templates.json',import.meta.url));
  return JSON.parse(readFileSync(path,'utf8')) as Planner;
}

export function rule(p:Planner,id:string):Rule {
  const r=p.rules.find(r=>r.id===id);
  if(!r)throw Error('规则不存在: '+id);
  return r;
}

// 构造一个空 Planner 并推入单条 active rule，用于只关心某一条规则的用例。
export function withRule(partial:Partial<Rule> & Pick<Rule,'id'|'title'|'weekdays'>):Planner {
  const p=emptyPlanner();
  p.rules.push({id:partial.id,name:partial.name||partial.title,title:partial.title,weekdays:partial.weekdays,status:partial.status||'active',start:partial.start||'2026-01-01',criteria:partial.criteria||'',minimum:partial.minimum||false,goals:[],projects:[]});
  return p;
}

export const MON='2026-09-21';   // 周一 → 普通日型 A
export const TUE='2026-09-22';   // 周二 → 固定安排日型
export const FRI='2026-09-25';   // 周五 → 普通日型 B
export const SUN='2026-09-27';   // 周日 → 轻量日型
