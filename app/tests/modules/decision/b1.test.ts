import test from 'node:test';
import assert from 'node:assert/strict';
import {collectDecisionCandidates,selectDecisionAnswer,createActionMaterial,createEntryMaterial,createAnswerMaterial,createDecisionMaterials,assertSameActionOwner,renderActionContent,inheritMaterialSources} from '../../../src/decision/model.ts';
import type {ActionCardV5,HandCard} from '../../../src/workspace/v06.ts';
import {AT,answer,baseContent,catalog} from '../../support/v06/fixtures.ts';
import {cases as c0Cases} from '../../../../docs/开发/v0.6-c0/fixtures.mjs';

const fresh=()=>structuredClone(catalog);
const decision={id:'which-book',version:1};
const select=(data=catalog)=>selectDecisionAnswer({catalog:data,decision,choice:{mode:'manual',entry:{id:'book-a',version:1}},at:AT});
const rejected=(fn:()=>unknown,code:string)=>assert.throws(fn,(e:any)=>e.code===code);
const frozen=(value:any):any=>{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};

test('B1 shared candidates deduplicate by ID, retain all source decks and preserve selected order',()=>{
  const data=fresh();data.decks.push({...data.decks[0],id:'other-books',version:3,memberIds:['link-a','book-a']});
  data.decisionCards[0].deckIds.push('other-books');
  const pool=collectDecisionCandidates({catalog:data,decision,deckIds:['other-books','books']});
  assert.deepEqual(pool.candidates.map(c=>c.entry.id),['link-a','book-a']);
  assert.deepEqual(pool.candidates[1].sourceDecks,[{id:'other-books',version:3},{id:'books',version:1}]);
});
test('B1 same title with different IDs remains two candidates',()=>{
  const data=fresh();data.catalogEntries.push({...data.catalogEntries[0],id:'book-b'});data.decks[0].memberIds.push('book-b');
  assert.deepEqual(collectDecisionCandidates({catalog:data,decision}).candidates.map(c=>c.entry.id),['book-a','book-b']);
});
test('B1 selected decks stay scoped to the decision and do not traverse child decks',()=>{
  const data=fresh();data.decks.push({...data.decks[0],id:'child',parentDeckId:'books',memberIds:['link-a']});
  assert.deepEqual(collectDecisionCandidates({catalog:data,decision}).candidates.map(c=>c.entry.id),['book-a']);
  rejected(()=>collectDecisionCandidates({catalog:data,decision,deckIds:['loose-list']}),'INVALID_INPUT');
  rejected(()=>collectDecisionCandidates({catalog:data,decision,deckIds:['books','books']}),'INVALID_INPUT');
});
test('B1 independent unbound lists remain usable as entry material without creating an action',()=>{
  const data=frozen(fresh()),before=structuredClone(data);
  const entry=createEntryMaterial({id:'loose-take-1',at:AT,entry:data.catalogEntries[3]});
  assert.equal(entry.kind,'entry');assert.equal('actionInstanceId' in entry,false);assert.equal('contentSnapshot' in entry,false);
  assert.equal(entry.entrySnapshot.url,'https://example.com/');assert.deepEqual(data,before);
});
test('B1 explicit empty selection and empty deck consume no randomness',()=>{
  const data=fresh();data.decisionCards[0].deckIds.push('empty-list');
  const random=()=>{assert.fail('random must not run');};
  for(const deckIds of [[],['empty-list']]){
    assert.deepEqual(collectDecisionCandidates({catalog:data,decision,deckIds}).candidates,[]);
    rejected(()=>selectDecisionAnswer({catalog:data,decision,deckIds,choice:{mode:'random',nextUint32:random},at:AT}),'ENTRY_UNAVAILABLE');
  }
});
test('B1 archived entries leave the candidate view but remain in the source library',()=>{
  const data=fresh();data.catalogEntries[0].status='archived';const before=structuredClone(data);
  assert.deepEqual(collectDecisionCandidates({catalog:data,decision}).candidates,[]);
  rejected(()=>select(data),'ENTRY_UNAVAILABLE');assert.deepEqual(data,before);
});
test('B1 stale decision/entry, inactive owner and broken members are explicit errors',()=>{
  rejected(()=>collectDecisionCandidates({catalog,decision:{...decision,version:2}}),'ENTRY_STALE');
  rejected(()=>selectDecisionAnswer({catalog,decision,choice:{mode:'manual',entry:{id:'book-a',version:2}},at:AT}),'ENTRY_STALE');
  const inactive=fresh();inactive.actionCards[0].status='paused';rejected(()=>select(inactive),'ENTRY_UNAVAILABLE');
  const broken=fresh();broken.decks[0].memberIds.push('missing');rejected(()=>select(broken),'INVALID_INPUT');
});
test('B1 ambiguous IDs, wrong deck kind and broken mapping cannot yield an answer',()=>{
  const duplicate=fresh();duplicate.catalogEntries.push({...duplicate.catalogEntries[0]});rejected(()=>select(duplicate),'INVALID_INPUT');
  const wrong=fresh();wrong.decks[0].deckKind='action';rejected(()=>select(wrong),'INVALID_INPUT');
  const mapping=fresh();mapping.decisionCards[0].mappings[0].fieldId='unknown';rejected(()=>select(mapping),'INVALID_INPUT');
});
test('B1 manual selection matches the literal P0 answer and does not use a random source',()=>{
  assert.deepEqual(select(),answer);
  rejected(()=>selectDecisionAnswer({catalog,decision,choice:{mode:'manual',entry:{id:'link-a',version:1}},at:AT}),'ENTRY_UNAVAILABLE');
});
test('B1 injected random source reuses uint32 rejection sampling without modulo bias',()=>{
  const data=fresh();data.decks[0].memberIds=['book-a','food-a','exercise-a'];
  const values=[0xffffffff,4];let calls=0;
  const result=selectDecisionAnswer({catalog:data,decision,choice:{mode:'random',nextUint32:()=>values[calls++]},at:AT});
  assert.equal(result.entry.id,'food-a');assert.equal(calls,2);
  for(const value of [-1,0.5,0x100000000,NaN])rejected(()=>selectDecisionAnswer({catalog:data,decision,choice:{mode:'random',nextUint32:()=>value},at:AT}),'INVALID_INPUT');
});
test('B1 reading and taking an answer never reselect or consult mutated catalog objects',()=>{
  const data=fresh(),result=select(data);data.catalogEntries[0].title='new';data.decisionCards[0].question='new question';data.decks[0].memberIds=[];
  const taken=createAnswerMaterial({id:'answer-1',at:AT,answer:result});
  assert.equal(taken.answer.entry.title,'合成书目甲');assert.equal(taken.answer.question,'读哪本？');
  assert.deepEqual(taken.answer.sourceDecks,[{id:'books',version:1}]);
  (result.entry as {title:string}).title='later mutation';assert.equal(taken.answer.entry.title,'合成书目甲');
});
test('B1 candidate views and all returned snapshots detach from frozen input',()=>{
  const data=frozen(fresh()),before=structuredClone(data),pool=collectDecisionCandidates({catalog:data,decision});
  (pool.candidates[0].entry as {title:string}).title='view mutation';
  const result=select(data);createAnswerMaterial({id:'answer-1',at:AT,answer:result});createActionMaterial({id:'action-1',at:AT,action:data.actionCards[0]});
  assert.deepEqual(data,before);
});
test('B1 numeric and boolean mappings preserve 0/false; missing attributes differ from explicit null',()=>{
  const data=fresh();data.actionCards[0].fields=[{id:'value',label:'值',valueType:'number',required:false}];data.decisionCards[0].mappings=[{fieldId:'value',entryPath:'attributes.score'}];
  data.catalogEntries[0].attributes={score:0};assert.deepEqual(select(data).fieldValues,[{fieldId:'value',value:0}]);
  data.actionCards[0].fields[0].valueType='boolean';data.catalogEntries[0].attributes={score:false};assert.deepEqual(select(data).fieldValues,[{fieldId:'value',value:false}]);
  data.catalogEntries[0].attributes={score:null};assert.deepEqual(select(data).fieldValues,[{fieldId:'value',value:null}]);
  data.catalogEntries[0].attributes={};const absent=select(data);assert.deepEqual(absent.fieldValues,[]);assert.equal(Object.hasOwn(absent.entry.attributes,'score'),false);
});
test('B1 wrong mapping types and forged saved answer values are rejected',()=>{
  const data=fresh();data.decisionCards[0].mappings=[{fieldId:'subject',entryPath:'attributes.minutes'}];data.decks[0].memberIds=['exercise-a'];
  rejected(()=>selectDecisionAnswer({catalog:data,decision,choice:{mode:'manual',entry:{id:'exercise-a',version:1}},at:AT}),'INVALID_INPUT');
  rejected(()=>createAnswerMaterial({id:'a',at:AT,answer:{...answer,fieldValues:[{fieldId:'subject',value:'forged'}]}}),'INVALID_INPUT');
  rejected(()=>createAnswerMaterial({id:'a',at:AT,answer:{...answer,sourceDecks:[]}}),'INVALID_INPUT');
});
test('B1 literal C05 answer-only and C06 explicit companion action return different drafts',()=>{
  const before=structuredClone(catalog),only=createDecisionMaterials({answerId:'answer-1',at:AT,answer});
  assert.equal(only.action,null);assert.equal(only.answer.kind,'answer');assert.equal('contentSnapshot' in only.answer,false);
  const both=createDecisionMaterials({answerId:'answer-2',at:AT,answer,action:{id:'action-2',card:catalog.actionCards[0]}});
  assert.equal(both.action?.kind,'action');assert.deepEqual(both.action?.ownerAction,both.answer.answer.ownerAction);
  assert.deepEqual(catalog,before);assert.equal(c0Cases.find(c=>c.id==='C05').expected.actionMaterialsAdded,0);assert.equal(c0Cases.find(c=>c.id==='C06').expected.actionMaterialsAdded,1);
});
test('B1 repeated explicit takes have separate material identities and independent snapshots',()=>{
  const first=createActionMaterial({id:'take-1',at:AT,action:catalog.actionCards[0]}),second=createActionMaterial({id:'take-2',at:AT,action:catalog.actionCards[0]});
  assert.notEqual(first.id,second.id);assert.deepEqual(first.ownerAction,second.ownerAction);
  (first.contentSnapshot as {title:string}).title='modified draft';assert.equal(second.contentSnapshot.title,'阅读《{对象}》');
  assert.equal(first.actionInstanceId,null);assert.equal(first.consumedBy,null);
});
test('B1 companion-action identity, owner, version and active status are guarded',()=>{
  rejected(()=>createDecisionMaterials({answerId:'same',at:AT,answer,action:{id:'same',card:catalog.actionCards[0]}}),'INVALID_INPUT');
  rejected(()=>createDecisionMaterials({answerId:'a',at:AT,answer,action:{id:'b',card:catalog.actionCards[1]}}),'ACTION_OWNER_MISMATCH');
  rejected(()=>assertSameActionOwner(answer.ownerAction,{id:'read',version:2}),'ENTRY_STALE');
  rejected(()=>createActionMaterial({id:'x',at:AT,action:{...catalog.actionCards[0],status:'paused'}}),'ENTRY_UNAVAILABLE');
  rejected(()=>createAnswerMaterial({id:'x',at:'2026-10-05T00:00:00Z',answer}),'INVALID_INPUT');
});
test('B1 daily take preserves original source day and frozen expiry instead of granting a fresh week',()=>{
  const origin={kind:'daily-copy' as const,copy:{id:'copy-1',version:1},sourceDate:'2026-10-01',zone:'Asia/Shanghai',expiresAt:'2026-10-07T16:00:00Z'};
  const result=createActionMaterial({id:'take-daily',at:AT,action:catalog.actionCards[0],origin});
  assert.equal(result.expiresAt,origin.expiresAt);assert.deepEqual(result.provenance,[origin]);
  rejected(()=>createActionMaterial({id:'expired',at:origin.expiresAt,action:catalog.actionCards[0],origin}),'MATERIAL_EXPIRED');
  rejected(()=>createActionMaterial({id:'future',at:AT,action:catalog.actionCards[0],origin:{...origin,sourceDate:'2026-10-07'}}),'INVALID_INPUT');
  rejected(()=>createActionMaterial({id:'reset',at:AT,action:catalog.actionCards[0],origin:{...origin,expiresAt:'2026-10-12T16:00:00Z'}}),'INVALID_INPUT');
});
test('B1 daily expiry follows the frozen zone day boundary across DST, not 168 fixed hours',()=>{
  const origin={kind:'daily-copy' as const,copy:{id:'dst-copy',version:1},sourceDate:'2026-10-26',zone:'America/New_York',expiresAt:'2026-11-02T05:00:00Z'};
  assert.equal(createActionMaterial({id:'dst-take',at:'2026-11-01T06:00:00Z',action:catalog.actionCards[0],origin}).expiresAt,origin.expiresAt);
  rejected(()=>createActionMaterial({id:'wrong-dst',at:'2026-11-01T06:00:00Z',action:catalog.actionCards[0],origin:{...origin,expiresAt:'2026-11-02T04:00:00Z'}}),'INVALID_INPUT');
});
test('B1 C01-C03 three equal domains render literal answers using the same rule',()=>{
  for(const [actionIndex,decisionId,entryId,caseId] of [[0,'which-book','book-a','C01'],[1,'which-food','food-a','C02'],[2,'which-exercise','exercise-a','C03']] as const){
    const result=selectDecisionAnswer({catalog,decision:{id:decisionId,version:1},choice:{mode:'manual',entry:{id:entryId,version:1}},at:AT});
    const action=catalog.actionCards[actionIndex],rendered=renderActionContent(action.content,action.fields,result.fieldValues);
    assert.equal(rendered.content.title,c0Cases.find(c=>c.id===caseId).expected.title);assert.equal(rendered.ready,true);
  }
});
test('B1 rendering is single-pass for title and criteria and leaves other content untouched',()=>{
  const content={...baseContent,title:'做{对象}',criteria:'核对{对象}',presetMinutes:20};
  const result=renderActionContent(content,catalog.actionCards[0].fields,[{fieldId:'subject',value:'甲{对象}'}]);
  assert.equal(result.content.title,'做甲{对象}');assert.equal(result.content.criteria,'核对甲{对象}');assert.equal(result.content.presetMinutes,20);assert.equal(content.title,'做{对象}');
});
test('B1 missing required values remain incomplete, optional blanks disappear, 0/false are populated',()=>{
  const fields=[{id:'n',label:'数量',valueType:'number' as const,required:true},{id:'b',label:'选项',valueType:'boolean' as const,required:true},{id:'s',label:'备注',valueType:'text' as const,required:false}];
  const content={...baseContent,title:'{数量}-{选项}-{备注}'};
  assert.equal(renderActionContent(content,fields,[{fieldId:'n',value:0},{fieldId:'b',value:false}]).content.title,'0-false-');
  const missing=renderActionContent(content,fields,[]);assert.equal(missing.ready,false);assert.deepEqual(missing.missingFieldIds,['n','b']);assert.equal(missing.content.title,'{数量}-{选项}-');
});
test('B1 duplicate field IDs/labels and unknown value fields cannot be rendered ambiguously',()=>{
  const field=catalog.actionCards[0].fields[0];
  rejected(()=>renderActionContent(baseContent,[field,{...field,id:'other'}],[]),'INVALID_INPUT');
  rejected(()=>renderActionContent(baseContent,[field],[{fieldId:'unknown',value:'x'}]),'INVALID_INPUT');
  rejected(()=>renderActionContent(baseContent,[field],[{fieldId:'subject',value:'x'},{fieldId:'subject',value:'y'}]),'INVALID_INPUT');
});
test('B1 source inheritance preserves both materials, recursive answer sources and direct input IDs',()=>{
  const action=createActionMaterial({id:'left',at:AT,action:catalog.actionCards[0]}),right=createAnswerMaterial({id:'right',at:AT,answer});
  const inherited=inheritMaterialSources([action,right]);assert.deepEqual(inherited.inputIds,['left','right']);assert.equal(inherited.provenance.length,2);assert.equal(inherited.expiresAt,null);
  const composite={...action,kind:'composite' as const,id:'composite',...inherited};
  const second=inheritMaterialSources([composite,{...right,id:'next-answer'}]);assert.deepEqual(second.inputIds,['composite','next-answer']);assert.equal(second.provenance.length,3);
  assert.equal(action.state,'available');assert.equal(right.state,'available');rejected(()=>inheritMaterialSources([action,action]),'INVALID_INPUT');
});
test('B1 expiry inheritance compares UTC instants with nanosecond precision and preserves input records',()=>{
  const action=createActionMaterial({id:'left',at:AT,action:catalog.actionCards[0]}),right=createAnswerMaterial({id:'right',at:AT,answer});
  const left={...action,expiresAt:'2026-10-08T00:00:00.000000002Z'},early={...right,expiresAt:'2026-10-08T00:00:00.000000001Z'};
  const before=structuredClone([left,early]);assert.equal(inheritMaterialSources([left,early]).expiresAt,early.expiresAt);assert.deepEqual([left,early],before);
});
