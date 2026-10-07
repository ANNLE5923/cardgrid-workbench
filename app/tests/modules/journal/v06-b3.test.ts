import test from 'node:test';
import assert from 'node:assert/strict';
import {projectJournalTimeline,prepareJournalNote,prepareLegacyJournalEdit,toLegacyJournalBlock,renderJournalText,prepareJournalText} from '../../../src/journal/model.ts';
import type {JournalNote,V06Command} from '../../../src/workspace/v06.ts';
import {recordRange,dayRange,elapsedMinutes} from '../../../src/daily/time.ts';
import {AT,TOKEN,answer,journal,materials} from '../../support/v06/fixtures.ts';
import {DATE,ZONE,data,projectionInput,plan,instance,frozen} from '../../support/v06/b3-fixtures.ts';
const rejected=(fn:()=>unknown,code:string)=>assert.throws(fn,(e:any)=>e.code===code);
const context={at:AT,workspaceZone:ZONE,access:'live' as const};
const noteCommand=(text:string,extra:Record<string,unknown>={}):Extract<V06Command,{type:'SaveJournalNote'}>=>({contractVersion:'v06-p0-1',commandId:'note-save',expected:TOKEN,type:'SaveJournalNote',payload:{id:null,expectedVersion:null,date:DATE,zone:ZONE,text,...extra} as any});
const save=(command=noteCommand('新的感想'),notes:readonly JournalNote[]=journal.notes,extra:Record<string,unknown>={})=>prepareJournalNote({command,notes,context,newId:()=> 'new-note',...extra});
const legacy={id:'legacy-1',version:3,date:DATE,zone:ZONE,text:'原文\r\n\n 空格保留 ',createdAt:'2026-10-01T00:00:00Z',updatedAt:AT};

test('B3 automatic rows mirror real projectDay sources and never infer sleep or empty-time behavior',()=>{
  const input=frozen(projectionInput()),before=structuredClone(input),result=projectJournalTimeline(input);
  assert.deepEqual(result.timeline.automatic.map(s=>[s.sourceKey,s.title,s.status]),[['fixed:sleep','已有夜间安排','fixed'],['instance:breakfast','早餐','planned']]);
  assert.deepEqual(input,before);assert.equal(result.timeline.automatic.some(s=>s.title.includes('空时间')),false);
  assert.equal(result.timeline.automatic[0].clippedRange.localStart,'2026-10-06T00:00');
});
test('B3 C17 retract removes only the plan row while the reflection and its original timestamp survive',()=>{
  const value=data(),input=projectionInput(value),before=projectJournalTimeline(input);
  value.planner.plans[0]={...plan,status:'retracted'};
  const after=projectJournalTimeline(projectionInput(value));
  assert.equal(before.timeline.automatic.length,2);assert.equal(after.timeline.automatic.length,1);
  assert.deepEqual(after.timeline.notes,journal.notes);assert.equal(after.timeline.notes[0].recordedAt,AT);
});
test('B3 C18 move updates the range with the same source/day identity',()=>{
  const value=data(),before=projectJournalTimeline(projectionInput(value)).timeline.automatic[1];
  value.planner.plans[0]={...plan,version:2,range:recordRange({startAt:'2026-10-06T02:00:00Z',endAt:'2026-10-06T02:30:00Z',zone:ZONE})};
  const after=projectJournalTimeline(projectionInput(value)).timeline.automatic[1];
  assert.equal(after.sourceKey,'instance:breakfast');assert.equal(after.id,before.id);assert.equal(after.clippedRange.localStart,'2026-10-06T10:00');
});
test('B3 C20 crossing midnight clips each day but retains a single original source',()=>{
  const value=data(),previous=projectJournalTimeline(projectionInput(value,'2026-10-05')).timeline.automatic[0],current=projectJournalTimeline(projectionInput(value)).timeline.automatic[0];
  assert.equal(previous.sourceKey,current.sourceKey);assert.notEqual(previous.id,current.id);assert.deepEqual(previous.range,current.range);
  assert.equal(previous.clippedRange.localEnd,'2026-10-06T00:00');assert.equal(current.clippedRange.localStart,'2026-10-06T00:00');
});
for(const [date,hours] of [['2026-03-08',23],['2026-11-01',25]] as const)test(`B3 DST ${hours}-hour day merges noon and offset pieces without duplicate behavior`,()=>{
  const value=data(),range=recordRange(dayRange(date,'America/New_York'));
  value.planner.plans=[];value.planner.fixed=[{...value.planner.fixed[0],range,ownerDate:date}];
  const input=projectionInput(value,date,'America/New_York');assert.ok(input.day.segments.filter(s=>s.kind==='fixed').length>1);
  const result=projectJournalTimeline(input);assert.equal(result.timeline.automatic.length,1);assert.equal(elapsedMinutes(result.timeline.automatic[0].clippedRange),hours*60);
  assert.notEqual(result.timeline.automatic[0].clippedRange.startOffset,result.timeline.automatic[0].clippedRange.endOffset);
});
test('B3 future arrangements project as plans while future personal text still refuses saving',()=>{
  const value=data();value.planner.plans[0]={...plan,range:recordRange({startAt:'2026-10-07T00:00:00Z',endAt:'2026-10-07T00:30:00Z',zone:ZONE})};
  const result=projectJournalTimeline(projectionInput(value,'2026-10-07'));
  assert.equal(result.timeline.automatic[0].status,'planned');assert.match(renderJournalText(result),/计划/);
  rejected(()=>save(noteCommand('明天',{date:'2026-10-07'})),'FUTURE_DATE');
});
test('B3 unmaterialized templates retain template/version/date/entry source and disappear on cancelled saved day',()=>{
  const value=data();value.planner.plans=[];value.planner.fixed=[];value.planner.templates=[{id:'template:1',version:4,name:'模板',weekdays:[2],entries:[{id:'entry:1',title:'已有模板安排',start:'09:00',elapsedMinutes:30,definitionId:null}],source:{kind:'manual'}}];
  const result=projectJournalTimeline(projectionInput(value));
  assert.equal(result.timeline.automatic[0].sourceKind,'template');assert.equal(result.timeline.automatic[0].sourceKey,'template:template%3A1:4:2026-10-06:entry%3A1');
  value.planner.days=[{date:DATE,zone:ZONE,version:1,name:'已准备',template:{id:'template:1',version:4},minimum:false,top3:[],overrides:[{entryId:'entry:1',fixedId:null,kind:'cancelled',at:AT}]}];
  assert.deepEqual(projectJournalTimeline(projectionInput(value)).timeline.automatic,[]);
});
test('B3 confirmation projects one actual behavior with a separate original-plan comparison and frozen answer',()=>{
  const value=data(),actualRange=recordRange({startAt:'2026-10-06T01:00:00Z',endAt:'2026-10-06T01:30:00Z',zone:ZONE});
  value.planner.plans[0]={...plan,status:'confirmed'};value.planner.facts=[{id:'fact-1',instanceId:instance.id,contentSnapshot:instance.currentContent,actualRange,plannedSnapshot:{planId:plan.id,planVersion:1,range:plan.range,content:plan.contentSnapshot},confirmedAt:AT,source:{kind:'manual'}}];
  const input={...projectionInput(value),factReferences:[{factId:'fact-1',answers:[answer]}]};
  const result=projectJournalTimeline(input),action=result.timeline.automatic.find(s=>s.sourceKey==='instance:breakfast')!;
  assert.equal(action.sourceKind,'fact');assert.deepEqual(action.referenceAnswers,[answer]);assert.equal(action.clippedRange.localStart,'2026-10-06T09:00');
  assert.equal(result.plannedComparisons.length,1);assert.equal(result.plannedComparisons[0].range.localStart,'2026-10-06T08:00');
  assert.equal(result.timeline.automatic.filter(s=>s.sourceKey==='instance:breakfast').length,1);
});
test('B3 attached and independent references show answers without creating another automatic interval',()=>{
  const input={...projectionInput(),materials:[materials[1]],references:[{id:'attached',version:1,answerId:materials[1].id,createdAt:AT,changedAt:AT,state:'active' as const,mode:'attached' as const,targetInstanceId:instance.id}]};
  const attached=projectJournalTimeline(input);assert.deepEqual(attached.timeline.automatic[1].referenceAnswers,[answer]);assert.equal(attached.timeline.automatic.length,2);
  const point={...input.references[0],mode:'point' as const,point:{at:'2026-10-06T02:00:00Z',zone:ZONE,localTime:'2026-10-06T10:00',offset:'+08:00'}};
  const {targetInstanceId:_,...standalone}=point;
  const result=projectJournalTimeline({...input,references:[standalone]});assert.equal(result.timeline.automatic.length,2);assert.equal(result.rows.filter(r=>r.kind==='reference').length,1);
  assert.match(renderJournalText(result),/占用 0 分钟/);
  assert.equal(projectJournalTimeline({...input,references:[{...standalone,point:{...standalone.point,at:'2026-10-07T02:00:00Z',localTime:'2026-10-07T10:00'}}]}).rows.filter(r=>r.kind==='reference').length,0);
});
test('B3 inconsistent reference/local snapshots and duplicate active identities are rejected',()=>{
  const input=projectionInput(),reference={id:'point',version:1,answerId:materials[1].id,createdAt:AT,changedAt:AT,state:'active' as const,mode:'point' as const,point:{at:'2026-10-06T02:00:00Z',zone:ZONE,localTime:'2026-10-06T10:00',offset:'+08:00'}};
  rejected(()=>projectJournalTimeline({...input,materials,references:[reference,reference]}),'INVALID_INPUT');
  rejected(()=>projectJournalTimeline({...input,materials,references:[{...reference,point:{...reference.point,offset:'+09:00'}}]}),'INVALID_INPUT');
});
test('B3 same-date reflections from multiple zones stay visible and sort by original instants with stable ties',()=>{
  const input=projectionInput(),note={...journal.notes[0],id:'a-note',zone:'America/New_York'};
  const result=projectJournalTimeline({...input,notes:[journal.notes[0],note]});
  assert.deepEqual(result.timeline.notes.map(n=>n.id),['a-note','note-1']);assert.equal(result.rows.filter(r=>r.kind==='reflection').length,2);
});
test('B3 C22 legacy block preserves exact CRLF, blanks, identity and timestamps without creating notes',()=>{
  const block=toLegacyJournalBlock(frozen(legacy));assert.equal(block.text,legacy.text);assert.equal(block.createdAt,legacy.createdAt);assert.equal('recordedAt' in block,false);
  const result=projectJournalTimeline({...projectionInput(),notes:[],legacyEntries:[legacy]});assert.equal(result.timeline.notes.length,0);assert.deepEqual(result.timeline.legacyBlocks,[block]);
  assert.equal(result.rows.some(r=>r.id===block.id),false);assert.equal(renderJournalText(result).includes('\r'),false);assert.equal(legacy.text.includes('\r\n'),true);
});
test('B3 new whitespace does not allocate an ID; existing clearing retains the record and original time',()=>{
  const noId=()=>assert.fail('blank must not allocate');
  const empty=save(noteCommand(' \n\t '),[],{newId:noId});assert.deepEqual(empty,{changed:false,before:null,after:null,operation:'unchanged'});
  const cleared=save(noteCommand('',{id:'note-1',expectedVersion:1}));assert.equal(cleared.after?.id,'note-1');assert.equal(cleared.after?.version,2);assert.equal(cleared.after?.recordedAt,AT);assert.equal(cleared.after?.text,'');
});
test('B3 C19 later edits preserve recordedAt, createdAt, date and zone and return only that note',()=>{
  const later='2026-10-06T02:15:00Z',input=frozen(journal.notes),result=save(noteCommand('修改后的文字',{id:'note-1',expectedVersion:1}),input,{context:{...context,at:later}});
  assert.equal(result.after?.recordedAt,AT);assert.equal(result.after?.createdAt,AT);assert.equal(result.after?.updatedAt,later);assert.deepEqual(result.before,input[0]);assert.equal('notes' in result,false);assert.equal(input[0].text,'今天早餐很好吃。');
});
test('B3 a past backfill records now rather than pretending the earlier day was the creation time',()=>{
  const result=save(noteCommand('补过去',{date:'2026-10-05'}));assert.equal(result.after?.recordedAt,AT);assert.equal(result.after?.date,'2026-10-05');
  const input={...projectionInput(data(),'2026-10-05'),notes:[result.after!]};assert.match(renderJournalText(projectJournalTimeline(input)),/补记于：2026-10-06 08:12/);
});
test('B3 future guard uses the workspace zone and cannot be bypassed through a different note zone',()=>{
  rejected(()=>save(noteCommand('未来',{date:'2026-10-07',zone:'Pacific/Kiritimati'})),'FUTURE_DATE');
  rejected(()=>save(noteCommand('移动',{id:'note-1',expectedVersion:1,zone:'UTC'})),'INVALID_INPUT');
});
test('B3 stale/version/collision/clock failures and forged recordedAt produce no draft',()=>{
  rejected(()=>save(noteCommand('修改',{id:'note-1',expectedVersion:2})),'ENTRY_STALE');
  rejected(()=>save(noteCommand('伪造',{recordedAt:'2026-10-01T00:00:00Z'})),'INVALID_INPUT');
  rejected(()=>save(noteCommand('新',{id:null,expectedVersion:null}),journal.notes,{newId:()=> 'note-1'}),'INVALID_INPUT');
  rejected(()=>save(noteCommand('修改',{id:'note-1',expectedVersion:1}),journal.notes,{context:{...context,at:'2026-10-06T00:11:00Z'}}),'INVALID_INPUT');
});
test('B3 unchanged note and legacy edits are no-ops, while clearing legacy preserves the old whole block',()=>{
  assert.equal(save(noteCommand(journal.notes[0].text,{id:'note-1',expectedVersion:1})).changed,false);
  const command:Extract<V06Command,{type:'SaveLegacyJournalBlock'}>={contractVersion:'v06-p0-1',commandId:'legacy-save',expected:TOKEN,type:'SaveLegacyJournalBlock',payload:{entry:{id:legacy.id,version:legacy.version},text:legacy.text}};
  assert.equal(prepareLegacyJournalEdit({command,entries:[legacy],context}).changed,false);
  const result=prepareLegacyJournalEdit({command:{...command,payload:{...command.payload,text:''}},entries:frozen([legacy]),context});
  assert.equal(result.after?.version,4);assert.equal(result.after?.createdAt,legacy.createdAt);assert.equal(result.after?.text,'');assert.equal(result.before?.text,legacy.text);
});
test('B11 archive writes and backfill into archived dates use the read-only policy',()=>{
  rejected(()=>save(noteCommand('编辑'),[],{context:{...context,access:'archive'}}),'ARCHIVE_READ_ONLY');
  rejected(()=>save(noteCommand('补旧档'),[],{context:{...context,archiveDates:[DATE]}}),'ARCHIVE_READ_ONLY');
});
test('B3 journal text is deterministic UTF-8/LF with real source hashes and no wall-clock render input',async()=>{
  const input=frozen(projectionInput()),before=structuredClone(input),projection=projectJournalTimeline(input);
  const first=await prepareJournalText(projection,TOKEN),again=await prepareJournalText(projectJournalTimeline(input),TOKEN);
  assert.deepEqual(first,again);assert.equal(first.text.includes('\r'),false);assert.match(first.sha256,/^[a-f\d]{64}$/);assert.deepEqual(input,before);
  assert.equal(first.source.kind,'journal');
  const changed=await prepareJournalText(projectJournalTimeline({...input,notes:[{...input.notes[0],text:'另一句'}]}),TOKEN);
  assert.notEqual(changed.sha256,first.sha256);assert.notEqual(changed.source.inputFingerprint,first.source.inputFingerprint);
});
test('B3 an old dial projection cannot be relabeled with a newer token or another epoch',async()=>{
  const projection=projectJournalTimeline(projectionInput());
  await assert.rejects(()=>prepareJournalText(projection,{...TOKEN,revision:TOKEN.revision+1}),(e:any)=>e.code==='PREVIEW_STALE');
  await assert.rejects(()=>prepareJournalText(projection,{...TOKEN,epoch:'different'}),(e:any)=>e.code==='PREVIEW_STALE');
});
test('B3 equal rendered input after an unrelated revision keeps the input hash and text hash stable',async()=>{
  const input=projectionInput(),first=await prepareJournalText(projectJournalTimeline(input));
  const next=await prepareJournalText(projectJournalTimeline({...input,day:{...input.day,token:{...TOKEN,revision:TOKEN.revision+1}}}));
  assert.equal(next.sha256,first.sha256);assert.equal(next.source.inputFingerprint,first.source.inputFingerprint);assert.notDeepEqual(next.source,first.source);
});
