// 3F counterexamples against actual production adapter; synthetic authoritative read models.
import assert from 'node:assert/strict';
import test from 'node:test';
import {inspectSnapshot} from '../../src/action-commands.ts';
import {projectDay} from '../../src/action-projection.ts';
import {fingerprint} from '../../src/workspace-format.ts';
import {plannedRange} from '../../src/action-time.ts';
import {projectionAdapter} from '../../src/components/time-dial/projection-adapter.ts';
import {hand,planned,fixed,confirmed,envelope,old} from '../fixtures/action/independent.ts';

async function view(data=hand(),date='2026-09-28',zone='Asia/Shanghai'){
 return projectDay(await inspectSnapshot(envelope(data)),{date,zone},'2026-12-01T00:00:00Z');
}
test('N01 legacy 09:02-09:09 retains minute precision',async()=>{
 const d=hand(),raw=old();raw.planner.days[0].date='2026-09-28';raw.planner.days[0].blocks[0].start=542;raw.planner.days[0].blocks[0].end=549;
 d.legacySources=[{id:'old-source',format:'cardgrid-v1-p1a',fingerprint:await fingerprint(raw),importedAt:'2026-09-28T02:00:00Z',raw}];
 d.settings.zone='Asia/Shanghai';
 // Explicit known legacy range is a legal ProductionDayView shape; raw old data is retained, never migrated.
 const v=await view(d);const known={source:{kind:'legacy',sourceId:'old-source',path:'planner.days.0.blocks.0'},title:'旧分钟区间',occupancy:'known',range:{startAt:'2026-09-28T01:02:00Z',endAt:'2026-09-28T01:09:00Z',zone:'Asia/Shanghai'}};
 const scene=projectionAdapter.buildScene({...v,legacyItems:[known]});
 const item=scene.items.find(i=>i.source==='legacy');
 assert.ok(item);assert.deepEqual([item.startMinute,item.endMinute],[542,549]);
});
test('N02 legacy spanning the entire viewed date remains drawn',async()=>{
 const v=await view();const li={source:{kind:'legacy',sourceId:'archive',path:'blocks.1'},title:'多日旧占用',occupancy:'known',range:{startAt:'2026-09-27T15:00:00Z',endAt:'2026-09-29T01:00:00Z',zone:'Asia/Shanghai'}};
 const s=projectionAdapter.buildScene({...v,legacyItems:[li]});const item=s.items.find(i=>i.source==='legacy');
 assert.ok(item,'spanning legacy occupancy must not disappear');assert.deepEqual([item.startMinute,item.endMinute],[0,1440]);
});
test('N03 DST spring axis preserves authority gap 02:00-03:00',async()=>{
 const v=await view(hand(),'2026-03-08','America/New_York');const s=projectionAdapter.buildScene(v);
 assert.deepEqual(s.axis.map(a=>[a.half,a.startMinute,a.endMinute]),[['inner',0,120],['inner',180,720],['outer',720,1440]]);
});
test('N04 DST missing hour overview cannot invent an event',async()=>{
 const d=planned();d.settings.zone='America/New_York';d.planner.instances[0].currentContent.presetMinutes=120;d.planner.plans[0].contentSnapshot.presetMinutes=120;
 d.planner.plans[0].range=plannedRange({date:'2026-03-08',time:'01:30',zone:'America/New_York'},120);
 const v=await view(d,'2026-03-08','America/New_York');assert.equal(v.segments.filter(s=>s.kind==='plan').length,2);
 const scene=projectionAdapter.buildScene(v);assert.equal(projectionAdapter.hourOverview(scene,2).filter(i=>i.source==='plan').length,0,'no real fragment covers missing 02:00 hour');
});
test('N05 same id in plan/fixed namespaces retains both source items',async()=>{
 const d=planned();d.planner.fixed=[{...fixed().planner.fixed[0],id:'p'}];const v=await view(d);
 assert.ok(v.plans.some(p=>p.planId==='p'));assert.ok(v.fixed.some(x=>x.commitmentId==='p'));
 const s=projectionAdapter.buildScene(v);assert.equal(s.items.filter(i=>i.source==='plan'||i.source==='fixed').length,2);
});
test('N06 unprepared template is projected readonly, not a saved fixed source',async()=>{
 const v=await view();const range=plannedRange({date:v.date,time:'09:00',zone:v.zone},30);
 const s=projectionAdapter.buildScene({...v,segments:[{id:'synthetic-template-segment',sourceId:'template-projection:2026-09-28:t:e',kind:'fixed',title:'模板项（未保存模板）',sourceRange:range,clippedRange:range,startDate:v.date,half:0,startMinuteOfHalf:540,endMinuteOfHalf:570,label:'09:00—09:30',offsetLabel:'+08:00',locked:true,continuesBefore:false,continuesAfter:false}],fixed:[]});
 assert.equal(s.items[0].source,'projected-readonly');assert.equal(s.items[0].readOnly,true);
});
test('N07 fact detail distinguishes actual 09:20-10:00 from reference 09:00-09:30',async()=>{
 const v=await view(confirmed());const s=projectionAdapter.buildScene(v);const f=s.items.find(i=>i.source==='fact');
 assert.ok(f);assert.deepEqual([f.startMinute,f.endMinute],[560,600],'actual time must not expand to planned reference bounding box');
});
test('N08 scene retains authority token to reject old actions',async()=>{
 const v=await view();const s=projectionAdapter.buildScene(v);assert.deepEqual(s.token,v.token);
});
