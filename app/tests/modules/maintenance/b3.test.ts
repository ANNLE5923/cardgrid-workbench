import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperationEvent,createListUrlEvent,createCommittedEvent,createLifecycleEvent,appendMaintenanceEvents,renderMaintenanceText,prepareMaintenanceText} from '../../../src/maintenance/model.ts';
import type {MaintenanceHistory} from '../../../src/maintenance/model.ts';
import {AT,TOKEN,catalog} from '../../support/v06/fixtures.ts';
import {frozen} from '../../support/v06/b3-fixtures.ts';
const ZONE='Asia/Shanghai',DATE='2026-10-06';
const rejected=(fn:()=>unknown,code='INVALID_INPUT')=>assert.throws(fn,(e:any)=>e.code===code);
const receipt={commandId:'save-note',type:'SaveJournalNote',payloadFingerprint:'synthetic-only',resultRefs:[]};
const history:MaintenanceHistory={id:'history-1',commandId:receipt.commandId,at:AT,date:DATE,type:receipt.type,entity:{kind:'journal-note',id:'note-1'},before:null,after:{id:'note-1',version:1,text:'私人的感想正文'}};
const committed=()=>createCommittedEvent({epoch:TOKEN.epoch,zone:ZONE,receipt,histories:[history]});
const requested=(extra:Record<string,unknown>={})=>createOperationEvent({eventId:'operation-1',epoch:TOKEN.epoch,at:AT,zone:ZONE,category:'navigation',operation:'NavigatePage',stage:'succeeded',commandId:null,entityRefs:[],errorCode:null,details:{page:'today',previousPage:'workshop'},...extra} as any);
const urlEvent=(outcome:'requested'|'blocked'|'failed'='requested')=>createListUrlEvent({eventId:`url-${outcome}`,epoch:TOKEN.epoch,at:AT,zone:ZONE,entry:catalog.catalogEntries[3],outcome});

test('B3 committed log uses the original history instant, one operation and metadata without diary text',()=>{
  const source=frozen(history),before=structuredClone(source),event=createCommittedEvent({epoch:TOKEN.epoch,zone:ZONE,receipt,histories:[source]});
  assert.equal(event.at,AT);assert.equal(event.date,DATE);assert.equal(event.category,'journal');assert.equal(event.stage,'succeeded');assert.deepEqual(event.sourceHistoryIds,['history-1']);
  assert.deepEqual(event.details,{historyCount:1,textLength:7});assert.equal(JSON.stringify(event).includes('私人的感想正文'),false);assert.deepEqual(source,before);
});
test('B3 same command/history replay deduplicates instead of creating another user operation',()=>{
  const first=committed(),result=appendMaintenanceEvents([first],[committed()]);
  assert.equal(result.events.length,1);assert.deepEqual(result.addedIds,[]);assert.deepEqual(result.replayedIds,[first.eventId]);
});
test('B3 a multi-entity command creates one event with both source histories and supported refs',()=>{
  const result=createCommittedEvent({epoch:TOKEN.epoch,zone:ZONE,receipt:{...receipt,type:'RetractPlan'},histories:[{...history,type:'RetractPlan',entity:{kind:'plan',id:'plan-1'},after:null},{...history,id:'history-2',type:'RetractPlan',entity:{kind:'instance',id:'instance-1'},after:null}]});
  assert.deepEqual(result.sourceHistoryIds,['history-1','history-2']);assert.equal(result.details.historyCount,2);assert.deepEqual(result.entityRefs,[{kind:'instance',id:'instance-1'}]);
});
test('B3 without a receipt-linked changed history there is no synthetic business success',()=>{
  rejected(()=>createCommittedEvent({epoch:TOKEN.epoch,zone:ZONE,receipt,histories:[]}));
  rejected(()=>createCommittedEvent({epoch:TOKEN.epoch,zone:ZONE,receipt,histories:[{...history,commandId:'different'}]}));
  rejected(()=>requested({category:'business',operation:'ConfirmSynthesis'}));
});
test('B3 reused IDs or source history under a different event are clear conflicts',()=>{
  const event=committed();rejected(()=>appendMaintenanceEvents([event],[{...event,operation:'AnotherOperation'}]));
  rejected(()=>appendMaintenanceEvents([event],[{...event,eventId:'other-event'}]));
  rejected(()=>appendMaintenanceEvents([event,event],[]));
});
test('B3 epochs partition logs; restoring does not replace old maintenance records',()=>{
  const old=committed(),newEvent=createCommittedEvent({epoch:'new-epoch',zone:ZONE,receipt,histories:[history]});
  const result=appendMaintenanceEvents([old],[newEvent]);assert.equal(result.events.length,2);
  const text=renderMaintenanceText({epoch:'new-epoch',date:DATE,zone:ZONE,events:result.events,hasGaps:false});
  assert.equal(text.includes(old.eventId),false);assert.equal(text.includes(newEvent.eventId),true);
});
test('B3 lifecycle success uses its replacement receipt and never fabricates planner history',()=>{
  const lifecycle={commandId:'restore',type:'RestoreWorkspace' as const,payloadFingerprint:'synthetic',previousToken:TOKEN,resultToken:{epoch:'new-epoch',revision:0}};
  const event=createLifecycleEvent({receipt:lifecycle,epoch:'new-epoch',at:AT,zone:ZONE});
  assert.equal(event.operation,'RestoreWorkspace');assert.equal(event.category,'lifecycle');assert.deepEqual(event.sourceHistoryIds,[]);assert.equal(event.epoch,'new-epoch');
  rejected(()=>createLifecycleEvent({receipt:lifecycle,epoch:'wrong',at:AT,zone:ZONE}));
});
test('B3 C29 list URL records requested/blocked/failed and never says the external page loaded',()=>{
  const request=urlEvent();assert.equal(request.stage,'requested');assert.equal(request.details.url,'https://example.com/');assert.equal(request.entityRefs[0].id,'link-a');
  assert.equal(urlEvent('blocked').errorCode,'URL_OPEN_BLOCKED');assert.equal(urlEvent('failed').stage,'failed');
  rejected(()=>createListUrlEvent({eventId:'loaded',epoch:TOKEN.epoch,at:AT,zone:ZONE,entry:catalog.catalogEntries[3],outcome:'loaded' as any}));
  rejected(()=>appendMaintenanceEvents([],[{...request,stage:'succeeded'}]));
});
test('B3 missing/unsafe URL and arbitrary external monitoring do not enter the log',()=>{
  for(const url of [null,'javascript:alert(1)'])rejected(()=>createListUrlEvent({eventId:'bad-url',epoch:TOKEN.epoch,at:AT,zone:ZONE,entry:{...catalog.catalogEntries[3],url},outcome:'requested'}));
  rejected(()=>requested({category:'external-browser',operation:'ObserveWebpage'}));
  rejected(()=>requested({details:{url:'https://example.com/'}}));
});
test('B3 diary text and free-form error messages are refused; retry stages retain command identity',()=>{
  rejected(()=>requested({details:{text:'秘密正文'}}));
  rejected(()=>requested({errorCode:'failed with private text'}));
  const failed=requested({category:'journal',operation:'SaveJournalNote',stage:'failed',commandId:receipt.commandId,errorCode:'STORAGE_FAILED',details:{textLength:8,attempt:2}});
  assert.equal(failed.commandId,receipt.commandId);assert.equal(failed.stage,'failed');assert.equal('text' in failed.details,false);
});
test('B3 unknown top-level body, external navigation labels and text masquerading as counters are refused',()=>{
  rejected(()=>requested({text:'未知正文'}));
  rejected(()=>requested({details:{page:'私人的感想正文'}}));
  rejected(()=>requested({details:{textLength:'私人的感想正文'}}));
  rejected(()=>requested({operation:'ObserveExternalWebpage'}));
});
test('B3 maintenance day output is deterministic, separated by original zone, sorted with stable ties',()=>{
  const event=requested(),later={...event,eventId:'z-event'},otherZone={...event,eventId:'utc-event',zone:'UTC',date:DATE};
  const text=renderMaintenanceText({epoch:TOKEN.epoch,date:DATE,zone:ZONE,events:[later,otherZone,event],hasGaps:false});
  assert.ok(text.indexOf('operation-1')<text.indexOf('z-event'));assert.equal(text.includes('utc-event'),false);assert.equal(text.includes('\r'),false);
});
test('B3 missing-event degradation is explicit and does not turn a saved business event into failure',()=>{
  const event=committed(),text=renderMaintenanceText({epoch:TOKEN.epoch,date:DATE,zone:ZONE,events:[event],hasGaps:true});
  assert.match(text,/未落库事件缺口/);assert.match(text,/succeeded/);assert.equal(event.stage,'succeeded');
});
test('B3 maintenance documents use the same writer and bind epoch, revision and render input fingerprint',async()=>{
  const input={epoch:TOKEN.epoch,date:DATE,zone:ZONE,events:[committed()],hasGaps:false,dayRevision:3};
  const first=await prepareMaintenanceText(frozen(input)),again=await prepareMaintenanceText(input);
  assert.deepEqual(first,again);assert.equal(first.source.kind,'maintenance');assert.match(first.source.inputFingerprint,/^[a-f\d]{64}$/);
  assert.equal(first.text.includes('私人的感想正文'),false);
  const changed=await prepareMaintenanceText({...input,hasGaps:true});assert.notEqual(changed.sha256,first.sha256);assert.notEqual(changed.source.inputFingerprint,first.source.inputFingerprint);
});
