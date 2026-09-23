import test from 'node:test';
import assert from 'node:assert/strict';
import {bootstrap,emptyPlanner,makeup,newTask,type Planner} from '../src/planner.ts';

function fixture():Planner { const p=emptyPlanner(); p.rules.push({id:'r1',name:'晨间',title:'晨间习惯',weekdays:[1],status:'active',start:'2026-01-01',criteria:'',minimum:false,goals:[],projects:[]}); return p; }
test('bootstrap 同一天幂等，且不会把昨日未完成搬到今天',()=>{ const first=bootstrap(fixture(),'2026-09-21'); const second=bootstrap(first,'2026-09-21'); assert.equal(second.occurrences.length,1); assert.equal(second.tasks.length,1); const other=bootstrap(second,'2026-09-22'); assert.equal(other.occurrences.length,1); assert.equal(other.occurrences[0].date,'2026-09-21'); assert.equal(other.occurrences[0].status,'missed'); });
test('补做创建新任务，不改写原 occurrence',()=>{ const prepared=bootstrap(fixture(),'2026-09-21'); prepared.occurrences[0].status='missed'; const original=structuredClone(prepared.occurrences[0]); const task=makeup(prepared,original.id,'2026-09-22'); assert.equal(prepared.occurrences[0].date,original.date); assert.equal(prepared.occurrences[0].status,'missed'); assert.equal(task.makeupOf,original.id); assert.equal(prepared.tasks.filter(t=>t.makeupOf===original.id).length,1); assert.equal(makeup(prepared,original.id,'2026-09-22').id,task.id); });
test('新任务的日期和状态满足保存契约',()=>{ const p=emptyPlanner(); const task=newTask('一次性事项','2026-09-21'); p.tasks.push(task); assert.equal(p.tasks[0].status,'planned'); assert.equal(p.tasks[0].date,'2026-09-21'); });
