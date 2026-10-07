import test from 'node:test';
import assert from 'node:assert/strict';
import {createActionMaterial,createAnswerMaterial,selectDecisionAnswer,previewSynthesis,prepareSynthesisConsumption,
  previewReferencePlacement,projectReferences,prepareReferenceReturn,prepareAttachedReferenceReturn,snapshotAttachedAnswers} from '../../../src/decision/model.ts';
import type {MaterialContext,SynthesisInput} from '../../../src/decision/model.ts';
import type {ActionCardV5,AnswerSnapshot,HandCard,ReferencePlacement} from '../../../src/workspace/v06.ts';
import type {Fact,Instance,Plan} from '../../../src/workspace/index.ts';
import {recordRange} from '../../../src/daily/time.ts';
import {AT,answer,baseContent,catalog,materials,journal,referenceDraft} from '../../support/v06/fixtures.ts';
import {cases as c0Cases} from '../../../../docs/开发/v0.6-c0/fixtures.mjs';

const rejected=(fn:()=>unknown,code:string)=>assert.throws(fn,(e:any)=>e.code===code);
const frozen=(value:any):any=>{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};
const fresh=():MaterialContext=>structuredClone({materials,instances:[],plans:[],facts:[],references:[]});
const ref=(item:{id:string;version:number})=>({id:item.id,version:item.version});
const request=(context=fresh(),extra:Partial<SynthesisInput>={}):SynthesisInput=>({context,inputs:[ref(context.materials[0]),ref(context.materials[1])],outputId:'read-result-1',at:AT,actionSource:catalog.actionCards[0],...extra});
const instance:Instance={id:'instance-read',version:1,definition:null,creationSnapshot:catalog.actionCards[0].content,currentContent:catalog.actionCards[0].content,source:{kind:'manual'},createdAt:AT,targetDate:null,state:'open',occurrenceId:null,makeupOf:null};
const range=recordRange({startAt:'2026-10-06T00:00:00Z',endAt:'2026-10-06T00:30:00Z',zone:'Asia/Shanghai'});
const plan:Plan={id:'plan-read',version:1,instanceId:instance.id,range,contentSnapshot:instance.currentContent,status:'active',createdAt:AT,changedAt:AT};
const fact:Fact={id:'fact-read',instanceId:instance.id,contentSnapshot:instance.currentContent,actualRange:range,plannedSnapshot:null,confirmedAt:AT,source:{kind:'manual'}};
const linked=(planned=true):MaterialContext=>{
  const context=fresh(),action=context.materials[0];assert.ok(action.kind==='action');
  return {...context,materials:[{...action,actionInstanceId:instance.id},context.materials[1]],instances:[instance],plans:planned?[plan]:[]};
};
const attachedDraft={answer:ref(materials[1]),mode:'attached' as const,instance:ref(instance)};
const attached=(context=linked())=>previewReferencePlacement({context,draft:attachedDraft,referenceId:'reference-1',at:AT}).placement;
const secondAnswer=(entryTitle='乙',values:AnswerSnapshot['fieldValues']=[{fieldId:'subject',value:entryTitle}],mappings:AnswerSnapshot['mappings']=[{fieldId:'subject',entryPath:'title'}])=>createAnswerMaterial({id:'answer-2',at:AT,answer:{...answer,entry:{...answer.entry,id:'book-b',title:entryTitle},fieldValues:values,mappings}});
const conflict=():SynthesisInput=>{
  const first=previewSynthesis(request()).output,other=secondAnswer();
  return request({...fresh(),materials:[first,other]},{outputId:'read-result-2'});
};
const expire=(card:HandCard,at:string):HandCard=>({...card,expiresAt:at});

for(const vector of c0Cases.filter((c:any)=>['C01','C02','C03'].includes(c.id))){
  test(`B2 ${vector.id} two inputs produce the literal ${vector.expected.title} without touching the library`,()=>{
    const actionSource=catalog.actionCards.find(a=>a.id===vector.input.actionId)!;
    const selected=selectDecisionAnswer({catalog,decision:{id:vector.input.decisionId,version:1},choice:{mode:'manual',entry:{id:vector.input.entryId,version:1}},at:AT});
    const context:MaterialContext={...fresh(),materials:[createActionMaterial({id:vector.input.leftId,at:AT,action:actionSource}),createAnswerMaterial({id:vector.input.rightId,at:AT,answer:selected})]};
    const before=structuredClone(context),libraryBefore=structuredClone(catalog);
    const result=prepareSynthesisConsumption(request(frozen(context),{outputId:vector.expected.outputIds[0],actionSource}));
    assert.equal(result.output.contentSnapshot.title,vector.expected.title);assert.equal(result.output.kind,'composite');
    assert.deepEqual(result.consumed.map(c=>c.id),vector.expected.consumedIds);assert.deepEqual(result.output.inputIds,vector.expected.consumedIds);
    assert.deepEqual(result.consumed.map(c=>[c.version,c.state,c.consumedBy]),[[2,'consumed',result.output.id],[2,'consumed',result.output.id]]);
    assert.equal(result.draft.canConfirm,true);assert.equal(result.draft.readyForToday,true);
    assert.deepEqual(context,before);assert.deepEqual(catalog,libraryBefore);
  });
}
test('B2 C07 consumes selected IDs while a same-name take and its instance are preserved',()=>{
  const context=linked(false),other={...context.materials[0],id:'read-take-2'};
  const withSibling={...context,materials:[...context.materials,other]},before=structuredClone(withSibling);
  const result=prepareSynthesisConsumption(request(withSibling));
  assert.deepEqual(result.consumed.map(c=>c.id),['read-take-1','which-book-answer-1']);
  assert.equal(result.output.actionInstanceId,null);assert.equal(result.consumed[0].kind==='action'&&result.consumed[0].actionInstanceId,instance.id);
  assert.deepEqual(withSibling,before);assert.equal(other.state,'available');
});
test('B2 cancel and repeated pure previews neither consume nor generate a receipt',()=>{
  const context=frozen(fresh()),before=structuredClone(context);
  assert.deepEqual(previewSynthesis(request(context)),previewSynthesis(request(context)));
  assert.deepEqual(context,before);assert.equal('commandReceipts' in context,false);
});
test('B2 same ID twice, wrong kinds and an existing output ID are rejected',()=>{
  rejected(()=>previewSynthesis(request(fresh(),{inputs:[ref(materials[0]),ref(materials[0])]})),'INVALID_INPUT');
  const second={...materials[1],id:'second-answer'};
  rejected(()=>previewSynthesis(request({...fresh(),materials:[materials[1],second]})),'INVALID_INPUT');
  rejected(()=>previewSynthesis(request(fresh(),{outputId:materials[0].id})),'INVALID_INPUT');
});
test('B2 stale or ambiguous material versions fail before consuming',()=>{
  rejected(()=>previewSynthesis(request(fresh(),{inputs:[{id:materials[0].id,version:2},ref(materials[1])]})),'ENTRY_STALE');
  rejected(()=>previewSynthesis(request({...fresh(),materials:[...materials,materials[0]]})),'INVALID_INPUT');
});
test('B2 C09 consumed/withdrawn/expired states and creation-time reversal are unavailable',()=>{
  for(const [state,code] of [['consumed','MATERIAL_CONSUMED'],['withdrawn','ENTRY_UNAVAILABLE'],['expired','MATERIAL_EXPIRED']] as const)
    rejected(()=>prepareSynthesisConsumption(request({...fresh(),materials:[{...materials[0],state},materials[1]]})),code);
  rejected(()=>previewSynthesis(request(fresh(),{at:'2026-10-06T00:11:59Z'})),'INVALID_INPUT');
  rejected(()=>previewSynthesis(request({...fresh(),materials:[{...materials[0],consumedBy:'old-result'},materials[1]]})),'MATERIAL_CONSUMED');
});
test('B2 C10 active plan refuses synthesis, while a retracted plan permits it',()=>{
  rejected(()=>previewSynthesis(request(linked())),'MATERIAL_PLACED');
  assert.equal(previewSynthesis(request({...linked(),plans:[{...plan,status:'retracted'}]})).canConfirm,true);
});
test('B2 C11 a fact stays locked even when its plan has been retracted',()=>{
  rejected(()=>previewSynthesis(request({...linked(false),facts:[fact]})),'FACT_LOCKED');
});
test('B2 both attached and standalone answers must be returned before synthesis',()=>{
  const point=previewReferencePlacement({context:fresh(),draft:referenceDraft,referenceId:'point-1',at:AT}).placement;
  rejected(()=>previewSynthesis(request({...fresh(),references:[point]})),'MATERIAL_PLACED');
  const context=linked(false),reference=attached();
  rejected(()=>previewSynthesis(request({...context,references:[reference]})),'MATERIAL_PLACED');
  rejected(()=>previewSynthesis(request({...context,references:[reference],facts:[fact]})),'FACT_LOCKED');
});
test('B2 C31 incompatible owners and changed source versions cannot be guessed',()=>{
  const context={...fresh(),materials:[createActionMaterial({id:materials[0].id,at:AT,action:catalog.actionCards[1]}),materials[1]]};
  rejected(()=>previewSynthesis(request(context,{actionSource:catalog.actionCards[1]})),'ACTION_OWNER_MISMATCH');
  rejected(()=>previewSynthesis(request(fresh(),{actionSource:{...catalog.actionCards[0],version:2}})),'ENTRY_STALE');
  rejected(()=>previewSynthesis(request(fresh(),{actionSource:{...catalog.actionCards[0],content:{...baseContent,title:'different'}}})),'ENTRY_STALE');
});
test('B2 C12 unresolved conflicts are displayed and block the consumption draft',()=>{
  const input=conflict(),draft=previewSynthesis(input);
  assert.deepEqual(draft.conflicts,[{fieldId:'subject',previous:'合成书目甲',incoming:'乙'}]);
  assert.deepEqual(draft.unresolvedFieldIds,['subject']);assert.equal(draft.canConfirm,false);assert.equal(draft.readyForToday,false);
  rejected(()=>prepareSynthesisConsumption(input),'FIELD_CONFLICT');
});
for(const choice of ['keep','replace'] as const)test(`B2 C13/C14 ${choice} consumes both sources and re-renders from the original template`,()=>{
  const input=conflict(),result=prepareSynthesisConsumption({...input,resolutions:[{fieldId:'subject',choice}]});
  assert.equal(result.output.contentSnapshot.title,choice==='keep'?'阅读《合成书目甲》':'阅读《乙》');
  assert.deepEqual(result.output.provenance,input.context.materials.flatMap(c=>c.provenance));
  assert.deepEqual(result.output.inputIds,input.inputs.map(c=>c.id));assert.equal(result.consumed.length,2);
  assert.deepEqual(result.draft.unresolvedFieldIds,[]);
});
test('B2 only real conflict fields accept one keep/replace resolution',()=>{
  for(const resolutions of [[{fieldId:'unknown',choice:'keep'}],[{fieldId:'subject',choice:'keep'},{fieldId:'subject',choice:'replace'}],[{fieldId:'subject',choice:'guess'}]])
    rejected(()=>previewSynthesis({...conflict(),resolutions:resolutions as any}),'INVALID_INPUT');
  rejected(()=>previewSynthesis({...request(),resolutions:[{fieldId:'subject',choice:'keep'}]}),'INVALID_INPUT');
});
test('B2 equal values merge lineage without asking a field-resolution question',()=>{
  const input=conflict(),same=createAnswerMaterial({id:'same-answer',at:AT,answer});
  const result=prepareSynthesisConsumption({...input,context:{...input.context,materials:[input.context.materials[0],same]},inputs:[ref(input.context.materials[0]),ref(same)]});
  assert.deepEqual(result.draft.conflicts,[]);assert.equal(result.output.provenance.length,3);
});
test('B2 a missing required field allows an intermediate result, then later completes title and criteria',()=>{
  const actionSource:ActionCardV5={...catalog.actionCards[0],content:{...baseContent,title:'阅读《{对象}》/{次数}',criteria:'读 {对象} 共 {次数} 次'},fields:[...catalog.actionCards[0].fields,{id:'count',label:'次数',valueType:'number',required:true}]};
  const action=createActionMaterial({id:'multi-action',at:AT,action:actionSource});
  const context={...fresh(),materials:[action,materials[1]]};
  const first=prepareSynthesisConsumption(request(context,{actionSource}));
  assert.equal(first.draft.canConfirm,true);assert.equal(first.draft.readyForToday,false);assert.deepEqual(first.draft.missingFieldIds,['count']);
  assert.equal(first.output.contentSnapshot.title,'阅读《合成书目甲》/{次数}');
  const amended=createAnswerMaterial({id:'answer-count',at:AT,answer:{...answer,entry:{...answer.entry,attributes:{count:2}},fieldValues:[{fieldId:'count',value:2}],mappings:[{fieldId:'count',entryPath:'attributes.count'}]}});
  const final=prepareSynthesisConsumption(request({...fresh(),materials:[first.output,amended]},{actionSource,outputId:'final-result'}));
  assert.equal(final.output.contentSnapshot.title,'阅读《合成书目甲》/2');assert.equal(final.output.contentSnapshot.criteria,'读 合成书目甲 共 2 次');
  assert.equal(final.draft.readyForToday,true);assert.deepEqual(final.output.fieldValues,[{fieldId:'subject',value:'合成书目甲'},{fieldId:'count',value:2}]);
});
test('B2 text/number types remain strict and absent or unknown fields cannot be forged',()=>{
  const numeric={...answer,entry:{...answer.entry,attributes:{n:3}},mappings:[{fieldId:'subject',entryPath:'attributes.n' as const}],fieldValues:[{fieldId:'subject',value:3}]};
  const numberMaterial=createAnswerMaterial({id:'number-answer',at:AT,answer:numeric});
  rejected(()=>previewSynthesis(request({...fresh(),materials:[materials[0],numberMaterial]})),'INVALID_INPUT');
  const wrong=secondAnswer('乙',[{fieldId:'unknown',value:'乙'}],[{fieldId:'unknown',entryPath:'title'}]);
  rejected(()=>previewSynthesis(request({...fresh(),materials:[materials[0],wrong]})),'INVALID_INPUT');
});
test('B2 empty original fields fill, 0 and false stay populated, and inserted braces stay literal',()=>{
  const actionSource:ActionCardV5={...catalog.actionCards[0],content:{...baseContent,title:'{对象} {次数} {允许}'},fields:[...catalog.actionCards[0].fields,{id:'count',label:'次数',valueType:'number',required:true},{id:'flag',label:'允许',valueType:'boolean',required:true}]};
  const action={...createActionMaterial({id:'scalar-action',at:AT,action:actionSource}),fieldValues:[{fieldId:'subject',value:'   '}]};
  const selected:AnswerSnapshot={...answer,entry:{...answer.entry,title:'字面{次数}',attributes:{count:0,flag:false}},mappings:[{fieldId:'subject',entryPath:'title'},{fieldId:'count',entryPath:'attributes.count'},{fieldId:'flag',entryPath:'attributes.flag'}],fieldValues:[{fieldId:'subject',value:'字面{次数}'},{fieldId:'count',value:0},{fieldId:'flag',value:false}]};
  const context={...fresh(),materials:[action,createAnswerMaterial({id:'scalar-answer',at:AT,answer:selected})]};
  const result=prepareSynthesisConsumption(request(context,{actionSource}));
  assert.equal(result.output.contentSnapshot.title,'字面{次数} 0 false');assert.equal(result.draft.readyForToday,true);
});
test('B2 C15 expiry is earliest UTC, remains unchanged on preview, and is exclusive at its boundary',()=>{
  const context={...fresh(),materials:[expire(materials[0],'2026-10-08T16:00:00Z'),materials[1]]};
  assert.equal(previewSynthesis(request(context)).output.expiresAt,'2026-10-08T16:00:00Z');
  rejected(()=>prepareSynthesisConsumption(request(context,{at:'2026-10-08T16:00:00Z'})),'MATERIAL_EXPIRED');
  const nano={...context,materials:[expire(materials[0],'2026-10-08T16:00:00.000000002Z'),expire(materials[1],'2026-10-08T16:00:00.000000001Z')]};
  assert.equal(previewSynthesis(request(nano)).output.expiresAt,'2026-10-08T16:00:00.000000001Z');
  assert.equal(previewSynthesis(request()).output.expiresAt,null);
});
test('B2 fresh consumption recomputes eligibility after a preview and never resurrects a consumed input',()=>{
  const input=request(),draft=previewSynthesis(input);
  const changed={...input.context,materials:[{...input.context.materials[0],version:2,state:'consumed' as const,consumedBy:draft.output.id},input.context.materials[1]]};
  rejected(()=>prepareSynthesisConsumption({...input,context:changed}),'ENTRY_STALE');
  rejected(()=>prepareSynthesisConsumption({...input,context:changed,inputs:[ref(changed.materials[0]),ref(changed.materials[1])]}),'MATERIAL_CONSUMED');
});
test('B2 reference point uses a five-minute instant and creates neither Plan nor Fact',()=>{
  const context=frozen(fresh()),before=structuredClone(context),result=previewReferencePlacement({context,draft:referenceDraft,referenceId:'point-1',at:AT});
  assert.deepEqual(result.point,{at:'2026-10-06T00:00:00Z',zone:'Asia/Shanghai',localTime:'2026-10-06T08:00',offset:'+08:00'});
  assert.equal(result.occupiedMinutes,0);assert.equal('range' in result.placement,false);assert.deepEqual(context,before);
  assert.equal(context.plans.length,0);assert.equal(context.facts.length,0);
  rejected(()=>previewReferencePlacement({context,draft:{...referenceDraft,local:{...referenceDraft.local,time:'08:01'}},referenceId:'invalid',at:AT}),'INVALID_GRID');
});
test('B2 reference points require explicit DST offset and reject nonexistent local minutes',()=>{
  const build=(date:string,time:string,offset?:string)=>previewReferencePlacement({context:fresh(),draft:{answer:ref(materials[1]),mode:'point',local:{date,time,zone:'America/New_York',...(offset?{offset}:{})}},referenceId:'dst',at:AT});
  rejected(()=>build('2026-11-01','01:30'),'AMBIGUOUS_LOCAL_TIME');
  assert.equal(build('2026-11-01','01:30','-04:00').point?.at,'2026-11-01T05:30:00Z');
  assert.equal(build('2026-11-01','01:30','-05:00').point?.at,'2026-11-01T06:30:00Z');
  rejected(()=>build('2026-03-08','02:30'),'NONEXISTENT_LOCAL_TIME');
});
test('B2 point/attached placements validate answer state, version, expiry and uniqueness',()=>{
  const place=(context:MaterialContext,draft:any=referenceDraft)=>previewReferencePlacement({context,draft,referenceId:'new-ref',at:AT});
  rejected(()=>place(fresh(),{...referenceDraft,answer:{id:materials[1].id,version:2}}),'ENTRY_STALE');
  rejected(()=>place(fresh(),{...referenceDraft,answer:ref(materials[0])}),'INVALID_INPUT');
  rejected(()=>place({...fresh(),materials:[materials[0],{...materials[1],state:'consumed'}]}),'MATERIAL_CONSUMED');
  const context={...fresh(),materials:[materials[0],expire(materials[1],'2026-10-07T00:00:00Z')]};
  rejected(()=>place(context,{...referenceDraft,local:{...referenceDraft.local,date:'2026-10-07',time:'08:00'}}),'MATERIAL_EXPIRED');
  const point=place(fresh()).placement;
  rejected(()=>place({...fresh(),references:[point]}),'MATERIAL_PLACED');
});
test('B2 attached references require a planned action with an explicit compatible source',()=>{
  const context=linked(),result=attached(context);assert.equal(result.mode,'attached');assert.equal('point' in result,false);
  rejected(()=>attached(linked(false)),'ENTRY_UNAVAILABLE');
  rejected(()=>attached({...context,materials:[materials[1]]}),'ACTION_OWNER_MISMATCH');
  const different=createActionMaterial({id:'meal-take',at:AT,action:catalog.actionCards[1]});
  rejected(()=>attached({...context,materials:[{...different,actionInstanceId:instance.id},materials[1]]}),'ACTION_OWNER_MISMATCH');
  rejected(()=>attached({...context,facts:[fact]}),'FACT_LOCKED');
  rejected(()=>previewReferencePlacement({context,draft:{...attachedDraft,instance:{...ref(instance),version:2}},referenceId:'stale',at:AT}),'ENTRY_STALE');
});
test('B2 moving the action changes reference projection with stable identity and no extra occupancy',()=>{
  const context=linked(),reference=attached(context),before=structuredClone(reference);
  const start=projectReferences({...context,references:[reference]})[0];
  const moved={...plan,version:2,range:recordRange({startAt:'2026-10-06T02:00:00Z',endAt:'2026-10-06T02:30:00Z',zone:'Asia/Shanghai'})};
  const next=projectReferences({...context,plans:[moved],references:[reference]})[0];
  assert.equal(start.range?.localStart,'2026-10-06T08:00');assert.equal(next.range?.localStart,'2026-10-06T10:00');
  assert.equal(next.reference.id,reference.id);assert.equal(next.occupiedMinutes,0);assert.deepEqual(reference,before);
});
test('B2 reference return returns the answer, preserves reflection, and permits later synthesis',()=>{
  const context=linked(),reference=attached(context),data=frozen({...context,references:[reference],journal}),before=structuredClone(data);
  const result=prepareAttachedReferenceReturn({context:data,instance:ref(instance),at:'2026-10-06T01:00:00Z'});
  assert.deepEqual(result.returnedAnswerIds,[materials[1].id]);assert.deepEqual(result.expiredAnswerIds,[]);
  assert.equal(result.references[0].state,'returned');assert.equal(result.references[0].version,2);
  assert.deepEqual(data,before);assert.deepEqual(data.journal.notes.map(n=>n.id),['note-1']);
  const updated={...data,plans:[{...plan,status:'retracted' as const}],references:result.references};
  assert.deepEqual(projectReferences(updated),[]);assert.equal(previewSynthesis(request(updated)).canConfirm,true);
});
test('B2 standalone return checks version and never resurrects expired or consumed answers',()=>{
  const placement=previewReferencePlacement({context:fresh(),draft:referenceDraft,referenceId:'point-1',at:AT}).placement;
  const context={...fresh(),references:[placement]};
  rejected(()=>prepareReferenceReturn({context,reference:{id:placement.id,version:2},at:AT}),'ENTRY_STALE');
  const result=prepareReferenceReturn({context,reference:ref(placement),at:AT});assert.deepEqual(result.returnedAnswerIds,[materials[1].id]);
  const expired={...context,materials:[materials[0],expire(materials[1],'2026-10-07T00:00:00Z')]};
  const later=prepareReferenceReturn({context:expired,reference:ref(placement),at:'2026-10-07T00:00:00Z'});
  assert.equal(later.references[0].state,'expired');assert.deepEqual(later.returnedAnswerIds,[]);assert.deepEqual(later.expiredAnswerIds,[materials[1].id]);
  rejected(()=>prepareReferenceReturn({context:{...context,materials:[materials[0],{...materials[1],state:'consumed'}]},reference:ref(placement),at:AT}),'MATERIAL_CONSUMED');
});
test('B2 a newly confirmed fact receives frozen attached answers, excludes points, and blocks later returns',()=>{
  const context=linked(),reference=attached(context),source={...context,references:[reference]};
  const snapshot=snapshotAttachedAnswers({context:source,instance:ref(instance),factId:fact.id,at:AT})!;
  assert.deepEqual(snapshot,{factId:fact.id,answers:[answer]});
  (snapshot.answers[0].entry as {title:string}).title='mutated return value';assert.equal(answer.entry.title,'合成书目甲');
  const confirmed={...source,facts:[fact],plans:[{...plan,status:'confirmed' as const}]};
  rejected(()=>prepareAttachedReferenceReturn({context:confirmed,instance:ref(instance),at:AT}),'FACT_LOCKED');
  rejected(()=>prepareReferenceReturn({context:confirmed,reference:ref(reference),at:AT}),'FACT_LOCKED');
  rejected(()=>snapshotAttachedAnswers({context:confirmed,instance:ref(instance),factId:fact.id,at:AT}),'FACT_LOCKED');
  assert.deepEqual(projectReferences(confirmed),[]);
  const point=previewReferencePlacement({context:fresh(),draft:referenceDraft,referenceId:'point',at:AT}).placement;
  assert.equal(snapshotAttachedAnswers({context:{...linked(),references:[point]},instance:ref(instance),factId:'new-fact',at:AT}),null);
});
test('B2 legacy actions without any reference do not need fabricated ownership or a new fact snapshot',()=>{
  const context={...linked(),materials:[]};
  assert.equal(snapshotAttachedAnswers({context,instance:ref(instance),factId:'new-fact',at:AT}),null);
  assert.deepEqual(prepareAttachedReferenceReturn({context,instance:ref(instance),at:AT}),{references:[],returnedAnswerIds:[],expiredAnswerIds:[]});
});
test('B2 all drafts are detached; edits to output/projection cannot change inputs or library snapshots',()=>{
  const context=linked(),reference=attached(context),before=structuredClone(context);
  const result=projectReferences({...context,references:[reference]});(result[0].range as {localStart:string}).localStart='changed';
  assert.deepEqual(context,before);assert.equal(plan.range.localStart,'2026-10-06T08:00');
  const input=request(),original=structuredClone(input),draft=previewSynthesis(input);
  (draft.output.contentSnapshot as {title:string}).title='changed';(draft.output.provenance[1] as any).snapshot.entry.title='changed';
  assert.deepEqual(input,original);
});
test('B2 input slot order stays in direct lineage and does not change which card is executable',()=>{
  const input=request(),result=prepareSynthesisConsumption({...input,inputs:[input.inputs[1],input.inputs[0]]});
  assert.equal(result.output.contentSnapshot.title,'阅读《合成书目甲》');
  assert.deepEqual(result.output.inputIds,[materials[1].id,materials[0].id]);assert.deepEqual(result.consumed.map(c=>c.id),result.output.inputIds);
});
test('B2 replacing a populated field with null is an explicit conflict and creates an incomplete intermediate',()=>{
  const input=conflict(),nullAnswer=createAnswerMaterial({id:'null-answer',at:AT,answer:{...answer,entry:{...answer.entry,attributes:{subject:null}},mappings:[{fieldId:'subject',entryPath:'attributes.subject'}],fieldValues:[{fieldId:'subject',value:null}]}});
  const changed={...input,context:{...input.context,materials:[input.context.materials[0],nullAnswer]},inputs:[input.inputs[0],ref(nullAnswer)] as const};
  rejected(()=>prepareSynthesisConsumption(changed),'FIELD_CONFLICT');
  const result=prepareSynthesisConsumption({...changed,resolutions:[{fieldId:'subject',choice:'replace'}]});
  assert.equal(result.draft.canConfirm,true);assert.equal(result.draft.readyForToday,false);
  assert.equal(result.output.contentSnapshot.title,'阅读《{对象}》');assert.deepEqual(result.draft.missingFieldIds,['subject']);
});
test('B2 complete fields without a duration can be confirmed as material but still need Today duration input',()=>{
  const actionSource={...catalog.actionCards[0],content:{...catalog.actionCards[0].content,presetMinutes:null}};
  const action=createActionMaterial({id:'durationless',at:AT,action:actionSource});
  const result=prepareSynthesisConsumption(request({...fresh(),materials:[action,materials[1]]},{actionSource}));
  assert.equal(result.draft.canConfirm,true);assert.deepEqual(result.draft.missingFieldIds,[]);assert.equal(result.draft.readyForToday,false);
});
test('B2 a moved future plan cannot receive an answer which expires by its start',()=>{
  const context=linked(),answerWithExpiry=expire(context.materials[1],'2026-10-07T00:00:00Z');
  const future={...plan,range:recordRange({startAt:'2026-10-07T00:00:00Z',endAt:'2026-10-07T00:30:00Z',zone:'Asia/Shanghai'})};
  rejected(()=>attached({...context,materials:[context.materials[0],answerWithExpiry],plans:[future]}),'MATERIAL_EXPIRED');
});
test('B2 ambiguous reference IDs and duplicate answers never produce duplicate rows or fact snapshots',()=>{
  const context=linked(),reference=attached(context),duplicate={...context,references:[reference,reference]};
  rejected(()=>projectReferences(duplicate),'INVALID_INPUT');
  rejected(()=>prepareAttachedReferenceReturn({context:duplicate,instance:ref(instance),at:AT}),'INVALID_INPUT');
  rejected(()=>snapshotAttachedAnswers({context:duplicate,instance:ref(instance),factId:'new-fact',at:AT}),'INVALID_INPUT');
  const twoReferences={...context,references:[reference,{...reference,id:'reference-2'}]};
  rejected(()=>snapshotAttachedAnswers({context:twoReferences,instance:ref(instance),factId:'new-fact',at:AT}),'INVALID_INPUT');
  rejected(()=>prepareReferenceReturn({context:twoReferences,reference:ref(reference),at:AT}),'INVALID_INPUT');
});
test('B2 source field changes cannot silently render an existing composite with a new schema',()=>{
  const input=conflict(),actionSource={...catalog.actionCards[0],fields:[{...catalog.actionCards[0].fields[0],label:'新标签'}]};
  rejected(()=>previewSynthesis({...input,actionSource}),'ENTRY_STALE');
});
