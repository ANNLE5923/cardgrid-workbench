/**
 * Design checks only. These reference formulas do NOT implement a production dial.
 * 3B must reuse the vectors against its actual exported adapter/geometry functions.
 * In-memory synthetic data only; no IDB/browser/client creation and no user data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { segmentsFor, projectDay } from '../../src/daily/projection.ts';
import { ActionTimeError, dayRange, displayInstant, elapsedMinutes, intersectRanges, nextDate, plannedRange, resolveLocal } from '../../src/daily/schedule/time.ts';
import { inspectSnapshot } from '../../src/workspace/commands.ts';
import { emptyActionData } from '../../src/workspace/format.ts';
import { planned, confirmed, fixed, hand, content, envelope, AT } from '../../tests/fixtures/action/independent.ts';

import type { DataV2 } from '../../src/workspace/contracts.ts';

const vectors = JSON.parse(readFileSync(new URL('./3A-regression-vectors.json', import.meta.url), 'utf8'));
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const rotation = (f: number) => 180 - f / 720 * 360;
const delta = (a: number, b: number) => ((b - a + 540) % 360) - 180;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

for (const v of vectors.rotation) test(`G01 rotation ${v.focus}`, () => assert.equal(rotation(v.focus), v.rotation));
for (const v of vectors.arc) test(`G02 arc length ${v.minutes}`, () => {
  assert.equal(v.minutes / 720 * 360, v.degrees);
  if (v.units !== null) assert.equal(v.minutes / 5, v.units);
});
for (const v of vectors.rotate) test(`G03 unwrapped bounded rotation ${v.previous}->${v.next}/${v.focus}`, () => {
  assert.equal(clamp(v.focus - delta(v.previous, v.next) * 2, 0, 1440), v.expected);
});
for (const v of vectors.landing) test(`G04 absolute landing ${v.minute}`, () => {
  const snapped=clamp(Math.round(v.minute / 5) * 5,0,1440);
  const date=snapped === 1440 ? nextDate(v.date) : v.date;
  const minute=snapped === 1440 ? 0 : snapped;
  assert.equal(date,v.expectedDate); assert.equal(minute,v.expectedMinute);
  assert.equal(minute < 720 ? 0 : 1,v.half);
});
for (const v of vectors.surface) test(`G05 inverse scale ${v.width}x${v.height}`, () => {
  const scale=Math.min(v.width,v.height)/400;
  const x=(v.point[0]-(v.width-400*scale)/2)/scale;
  const y=(v.point[1]-(v.height-400*scale)/2)/scale;
  close(x,v.expected[0]); close(y,v.expected[1]);
});
for (const v of vectors.pull) test(`G06 pull ${v.start}->${v.current}`, () => {
  assert.equal(v.current >= 190 && v.current-v.start >=45,v.expected);
});
for (const v of vectors.hit) test(`G07 ring hit ${v.focus}/${v.point[1]}/${v.anchor?.half ?? 'initial'}`, () => {
  const [x,y]=v.point; const r=Math.hypot(x-200,y-200);
  if(r < 70 || r > 185) { assert.equal(v.half,null); return; }
  const half = v.anchor?.half === 0 ? r>119 ? 1:0 : v.anchor?.half === 1 ? r<107 ? 0:1 : r<113 ? 0:1;
  assert.equal(half,v.half);
  const angle=Math.atan2(x-200,200-y)*180/Math.PI;
  const phase=(((angle-rotation(v.focus))%360)+360)%360*2;
  const anchor=v.anchor?.half === half ? v.anchor.minuteOfHalf : v.focus === 1440 && half === 1 ? 720 : v.focus%720;
  const minute=clamp(phase+Math.round((anchor-phase)/720)*720,0,720);
  close(minute,v.minute);
});
for (const v of vectors.projection) test(`P01 ${v.id}`, () => {
  const source={startAt:v.start,endAt:v.end,zone:v.zone};
  const before=structuredClone(source);
  const pieces=segmentsFor(source,v.date,v.zone,'same-source','plan','合成来源',false);
  assert.equal(elapsedMinutes(source),v.elapsed);
  assert.deepEqual(pieces.map(s=>[s.half,s.startMinuteOfHalf,s.endMinuteOfHalf,s.offsetLabel,s.continuesBefore,s.continuesAfter]),v.expected);
  assert.ok(pieces.every(s=>s.sourceId==='same-source'));
  assert.equal(new Set(pieces.map(s=>s.id)).size,pieces.length);
  assert.deepEqual(source,before);
});
for (const v of vectors.axis) test(`P02 day axis ${v.date}`, () => {
  const r=dayRange(v.date,v.zone); const pieces=segmentsFor(r,v.date,v.zone,'axis','fixed','axis',true);
  assert.equal(elapsedMinutes(r),v.elapsed);
  assert.deepEqual(pieces.map(s=>[s.half,s.startMinuteOfHalf,s.endMinuteOfHalf,s.offsetLabel]),v.expected);
  assert.equal(pieces.reduce((n,s)=>n+elapsedMinutes(s.clippedRange),0),v.elapsed);
});
test('P03 DST choices and missing day are explicit', () => {
  assert.throws(()=>resolveLocal({date:'2026-03-08',time:'02:30',zone:'America/New_York'}),(e: unknown)=>e instanceof ActionTimeError && e.code==='NONEXISTENT_LOCAL_TIME');
  try { resolveLocal({date:'2026-11-01',time:'01:30',zone:'America/New_York'}); assert.fail('expected offset choices'); }
  catch(e) { assert.ok(e instanceof ActionTimeError); assert.equal(e.code,'AMBIGUOUS_LOCAL_TIME'); assert.deepEqual(e.choices.map(c=>c.input.offset),['-04:00','-05:00']); }
  assert.throws(()=>dayRange('2011-12-30','Pacific/Apia'),(e:unknown)=>e instanceof ActionTimeError && e.code==='NONEXISTENT_LOCAL_TIME');
});
test('P04 formal plan and fixed versions remain authoritative', async () => {
  for(const data of [planned(),fixed()]) {
    const original=structuredClone(data); const view=projectDay(await inspectSnapshot(envelope(data)),{date:'2026-09-28',zone:'Asia/Shanghai'},AT);
    for(const p of view.plans) {
      assert.equal(p.version,data.planner.plans.find(s=>s.id===p.planId)?.version);
      assert.equal(p.instanceVersion,data.planner.instances.find(s=>s.id===p.instanceId)?.version);
    }
    for(const f of view.fixed) assert.equal(f.version,data.planner.fixed.find(s=>s.id===f.commitmentId)?.version);
    assert.deepEqual(data,original);
  }
});
test('P05 fact reference source is factId and free uses actual only', async () => {
  const data=confirmed(); const view=projectDay(await inspectSnapshot(envelope(data)),{date:'2026-09-28',zone:'Asia/Shanghai'},AT);
  assert.equal(view.plans.length,0);
  assert.ok(view.segments.some(s=>s.kind==='fact'));
  assert.ok(view.segments.some(s=>s.kind==='plan-reference'));
  assert.ok(view.segments.filter(s=>s.kind==='fact'||s.kind==='plan-reference').every(s=>s.sourceId===data.planner.facts[0].id));
  const occupied=1440-view.freeRanges.reduce((n,r)=>n+elapsedMinutes(r),0);
  assert.equal(occupied,elapsedMinutes(data.planner.facts[0].actualRange));
});
test('P06 unprepared template is fixed display but has no FixedView or writes', async () => {
  const data=emptyActionData();
  const template={id:'template',version:1,name:'合成日',weekdays:[4],entries:[{id:'entry',title:'未保存模板',start:'09:00',elapsedMinutes:15,definitionId:null}],source:{kind:'manual' as const}};
  const next={...data,settings:{...data.settings,zone:'Asia/Shanghai'},planner:{...data.planner,templates:[template]}};
  const original=structuredClone(next);
  const view=projectDay(await inspectSnapshot(envelope(next)),{date:'2026-10-01',zone:'Asia/Shanghai'},'2026-10-01T01:00:00Z');
  assert.equal(view.fixed.length,0); assert.equal(view.segments.filter(s=>s.kind==='fixed').length,1);
  assert.equal(view.freeRanges.reduce((n,r)=>n+elapsedMinutes(r),0),1425);
  assert.deepEqual(next,original);
});
test('P07 unknown template occupancy does not become empty/red', async () => {
  const data=emptyActionData();
  const next={...data,planner:{...data.planner,templates:[{id:'template',version:1,name:'合成',weekdays:[4],entries:[{id:'e',title:'合成',start:'09:00',elapsedMinutes:15,definitionId:null}],source:{kind:'manual' as const}}]}};
  const view=projectDay(await inspectSnapshot(envelope(next)),{date:'2026-10-01',zone:'UTC'},'2026-10-02T01:00:00Z');
  assert.equal(view.occupancyKnown,false); assert.equal(view.freeRanges.length,0);
  assert.ok(!view.segments.some(s=>s.kind==='empty'));
});
test('P08 blank day becomes two full red arcs only at authoritative day end', async () => {
  const data=emptyActionData(); const snapshot=await inspectSnapshot(envelope(data)); const input={date:'2026-10-01',zone:'Asia/Shanghai'};
  const before=projectDay(snapshot,input,'2026-10-01T15:59:00Z');
  const atEnd=projectDay(snapshot,input,'2026-10-01T16:00:00Z');
  assert.equal(before.segments.length,0);
  assert.deepEqual(atEnd.segments.map(s=>[s.kind,s.half,s.startMinuteOfHalf,s.endMinuteOfHalf]),[['empty',0,0,720],['empty',1,0,720]]);
  assert.equal(atEnd.freeRanges.length,1); assert.equal(data.planner.facts.length,0); assert.equal(data.planner.days.length,0);
});
test('P09 initial current reading retains minute precision', () => {
  assert.equal(displayInstant('2026-10-01T01:02:47Z','Asia/Shanghai').minute,542);
});

test('P10 crowded G3 oracle keeps 12 sources, all overlaps and 5/15/30 minute gaps', async () => {
  const c=vectors.crowded; const base=emptyActionData(); const records=c.blocks.map((b: {id:string;kind:string;start:string;minutes:number})=>({
    ...b,range:plannedRange({date:c.date,time:b.start,zone:c.zone},b.minutes),
    content:{...content(b.minutes),title:b.id},instanceId:'instance:'+b.id
  }));
  const instanceBase=hand().planner.instances[0];
  const data:DataV2={...base,settings:{...base.settings,zone:c.zone},planner:{...base.planner,
    instances:records.filter((b:any)=>b.kind!=='fixed').map((b:any)=>({...instanceBase,id:b.instanceId,creationSnapshot:b.content,currentContent:b.content})),
    plans:records.filter((b:any)=>b.kind==='plan').map((b:any)=>({id:b.id,version:4,instanceId:b.instanceId,range:b.range,contentSnapshot:b.content,status:'active',createdAt:AT,changedAt:AT})),
    facts:records.filter((b:any)=>b.kind==='fact').map((b:any)=>({id:b.id,instanceId:b.instanceId,actualRange:b.range,contentSnapshot:b.content,plannedSnapshot:null,confirmedAt:AT,source:{kind:'manual'}})),
    fixed:records.filter((b:any)=>b.kind==='fixed').map((b:any)=>({id:b.id,version:3,title:b.id,range:b.range,cancelled:false,ownerDate:c.date,template:null,templateEntryId:null,manuallyOverridden:false,source:{kind:'manual'}}))
  }};
  const view=projectDay(await inspectSnapshot(envelope(data)),{date:c.date,zone:c.zone},'2026-10-01T02:00:00Z');
  assert.equal(view.plans.length,4); assert.equal(view.fixed.length,4); assert.equal(view.facts.length,4);
  assert.equal(new Set(view.segments.map(s=>s.sourceId)).size,12);
  for(const [start,end,minutes] of c.requiredGaps) {
    assert.ok(view.freeRanges.some(r=>displayInstant(r.startAt,c.zone).time===start && displayInstant(r.endAt,c.zone).time===end && elapsedMinutes(r)===minutes));
  }
  const focus=c.overlapFocus.minute;
  assert.deepEqual(view.segments.filter(s=>focus>=s.half*720+s.startMinuteOfHalf && focus<s.half*720+s.endMinuteOfHalf).map(s=>s.sourceId).sort(),[...c.overlapFocus.expectedSourceIds].sort());
  const attempted=plannedRange({date:c.date,time:c.attemptedPlacement.start,zone:c.zone},c.attemptedPlacement.minutes);
  assert.equal(displayInstant(attempted.endAt,c.zone).time,c.attemptedPlacement.expectedEnd);
  assert.equal(elapsedMinutes(attempted),45);
  assert.deepEqual(view.segments.filter(s=>intersectRanges(attempted,s.clippedRange)).map(s=>s.sourceId),c.attemptedPlacement.expectedBlockerIds);
});
