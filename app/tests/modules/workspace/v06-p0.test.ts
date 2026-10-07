import assert from 'node:assert/strict';
import test from 'node:test';
import {checkV06ByteBudget, validateMonthlyArchiveManifest, validateV06CommandInput, validateV06Dto, validateV06PortStamp, V06ContractError} from '../../../src/workspace/v06.ts';
import {exportWorkspace, parseRestore} from '../../../src/workspace/format.ts';
import {answer, archiveView, catalog, clearRequest, journal, manifest, materials, monthCases, synthesisRequest, testCapacity, TOKEN} from '../../support/v06/fixtures.ts';
import {createV06TestPort} from '../../support/v06/test-port.ts';
import {catalog as c0Catalog, cases as c0Cases} from '../../../../docs/开发/v0.6-c0/fixtures.mjs';

const rejected=(fn:()=>void,code='INVALID_INPUT')=>assert.throws(fn,(e:unknown)=>e instanceof V06ContractError&&e.code===code);
const command=(type:string,payload:unknown)=>({contractVersion:'v06-p0-1',commandId:`p0-${type}`,expected:TOKEN,type,payload});
const seed=()=>({token:TOKEN,catalog,hand:materials.map(card=>({card,usableInToday:false,unavailableReason:'INCOMPLETE' as const})),journal});

test('P0 three equal domains and independent lists preserve the C0 literal identities',()=>{
  assert.deepEqual(catalog.actionCards.map(a=>({id:a.id,title:a.content.title,fields:a.fields.map(f=>({id:f.id,label:f.label,type:f.valueType,required:f.required}))})),c0Catalog.actions);
  assert.deepEqual(catalog.catalogEntries.map(e=>({id:e.id,title:e.title,attributes:e.attributes,...(e.url===null?{}:{url:e.url})})),c0Catalog.entries);
  assert.deepEqual(catalog.decks.map(d=>({id:d.id,kind:d.deckKind,memberIds:d.memberIds})),c0Catalog.decks);
  assert.deepEqual(catalog.decisionCards.map(d=>({id:d.id,ownerActionId:d.ownerActionId,deckIds:d.deckIds,mappings:d.mappings})),c0Catalog.decisions);
});
test('P0 literal DTOs pass the public boundary without writes',()=>{
  for(const e of catalog.catalogEntries)validateV06Dto('entry',e);
  for(const d of catalog.decks)validateV06Dto('deck',d);
  for(const a of catalog.actionCards)validateV06Dto('action',a);
  for(const d of catalog.decisionCards)validateV06Dto('decision',d);
  validateV06Dto('answer',answer);validateV06Dto('note',journal.notes[0]);
});
test('P0 rejects unknown fields and forged identity metadata',()=>{
  rejected(()=>validateV06Dto('entry',{...catalog.catalogEntries[0],factId:'forged'}));
  rejected(()=>validateV06Dto('note',{...journal.notes[0],planId:'must-not-cascade'}));
  rejected(()=>validateV06Dto('action',{...catalog.actionCards[0],kind:'answer'}));
});
test('P0 entry attributes reject nesting, nonfinite values and prototype keys',()=>{
  for(const attributes of [{x:[]},{x:{}},{x:Infinity},{x:NaN},JSON.parse('{"__proto__":"bad"}'),{constructor:'bad'}])
    rejected(()=>validateV06Dto('entry',{...catalog.catalogEntries[0],attributes}));
  validateV06Dto('entry',{...catalog.catalogEntries[0],attributes:{text:'文字',amount:0,flag:false,missing:null}});
});
test('P0 URLs permit only explicit http or https',()=>{
  for(const url of ['javascript:alert(1)','file:///C:/private.txt','/relative','not a URL'])rejected(()=>validateV06Dto('entry',{...catalog.catalogEntries[0],url}));
  validateV06Dto('entry',{...catalog.catalogEntries[0],url:'http://example.com/path'});
});
test('P0 deck direct-member limit accepts 100 and rejects 101 without trimming',()=>{
  const memberIds=Array.from({length:100},(_,i)=>`entry-${i}`);
  validateV06Dto('deck',{...catalog.decks[0],memberIds});
  rejected(()=>validateV06Dto('deck',{...catalog.decks[0],memberIds:[...memberIds,'entry-100']}),'POOL_CAPACITY_EXCEEDED');
  assert.equal(memberIds.length,100);
});
test('P0 rejects duplicate or sparse member arrays',()=>{
  rejected(()=>validateV06Dto('deck',{...catalog.decks[0],memberIds:['same','same']}));
  rejected(()=>validateV06Dto('deck',{...catalog.decks[0],memberIds:new Array(1)}));
});
test('P0 mapping cannot reach identity, time, facts or nested attributes',()=>{
  for(const entryPath of ['id','createdAt','fact','attributes.x.y','attributes.__proto__'])
    rejected(()=>validateV06Dto('decision',{...catalog.decisionCards[0],mappings:[{fieldId:'subject',entryPath}]}));
  validateV06Dto('decision',{...catalog.decisionCards[0],mappings:[{fieldId:'subject',entryPath:'attributes.author'}]});
});
test('P0 adapter stamp cannot claim formal persistence under a draft contract',()=>{
  validateV06PortStamp({contractVersion:'v06-p0-1',backend:'test-adapter',release:'draft'});
  rejected(()=>validateV06PortStamp({contractVersion:'v06-p0-1',backend:'formal',release:'draft'}));
  rejected(()=>validateV06PortStamp({contractVersion:'v06-p0-2',backend:'test-adapter',release:'draft'}));
});
test('P0 all 16 command payload boundaries are explicit and reject extra fields',()=>{
  const inputs=[
    command('SaveCatalogEntry',{entry:catalog.catalogEntries[0],expectedVersion:1}),
    command('SaveDeck',{deck:catalog.decks[0],expectedVersion:1}),
    command('SaveActionCardV5',{actionCard:catalog.actionCards[0],expectedVersion:1}),
    command('SaveDecisionCard',{decision:catalog.decisionCards[0],expectedVersion:1}),
    command('MoveDeckMember',{entry:{id:'link-a',version:1},from:{id:'loose-list',version:1},to:{id:'empty-list',version:1},targetIndex:0}),
    command('TakeActionMaterial',{action:{id:'read',version:1}}),
    command('TakeEntryMaterial',{entry:{id:'link-a',version:1}}),
    command('AcceptDecisionAnswer',{selectionId:'selection-1',alsoTakeAction:false}),synthesisRequest,
    command('ReorderUnifiedHand',{cardIds:['read-take-1','which-book-answer-1']}),
    command('CommitReferencePlacement',{previewId:'reference-preview-1'}),
    command('RetractReference',{reference:{id:'reference-1',version:1}}),
    command('SaveJournalNote',{id:null,expectedVersion:null,date:'2026-10-06',zone:'Asia/Shanghai',text:'记下此刻'}),
    command('SaveLegacyJournalBlock',{entry:{id:'legacy-journal-1',version:1},text:'原文\r\n 保留'}),
    command('ImportCatalogV4',{previewId:'import-1',mode:'merge',backupEvidenceId:'backup-1'}),clearRequest,
  ];
  assert.equal(inputs.length,16);
  for(const input of inputs){validateV06CommandInput(input);rejected(()=>validateV06CommandInput({...input,payload:{...input.payload,unexpected:true}}));}
});
test('P0 note creation and editing cannot spoof the original timestamp',()=>{
  const payload={id:null,expectedVersion:null,date:'2026-10-06',zone:'Asia/Shanghai',text:'x'};
  rejected(()=>validateV06CommandInput(command('SaveJournalNote',{...payload,recordedAt:'2000-01-01T00:00:00Z'})));
  rejected(()=>validateV06CommandInput(command('SaveJournalNote',{...payload,expectedVersion:1})));
  validateV06CommandInput(command('SaveJournalNote',{...payload,id:'note-1',expectedVersion:1}));
});
test('P0 archive clearing needs capability IDs and explicit confirmation',()=>{
  rejected(()=>validateV06CommandInput({...clearRequest,payload:{...clearRequest.payload,removalConfirmed:false}}));
  rejected(()=>validateV06CommandInput({...clearRequest,payload:{previewId:'p',verified:true,removalConfirmed:true}}));
  rejected(()=>validateV06CommandInput(command('AutoClearMonth',{})));
});
test('P0 invalid tokens, instants, months and zones fail at the boundary',()=>{
  rejected(()=>validateV06CommandInput({...synthesisRequest,expected:{epoch:'p0',revision:-1}}));
  rejected(()=>validateV06Dto('note',{...journal.notes[0],recordedAt:'2026-10-06T08:12:00'}));
  rejected(()=>validateV06Dto('note',{...journal.notes[0],date:'2026-02-30'}));
  rejected(()=>validateV06Dto('note',{...journal.notes[0],zone:'Unknown/Zone'}));
});
test('P0 manifest allows a self-contained cross-month range',()=>{
  validateMonthlyArchiveManifest(manifest);
  assert.deepEqual(manifest.coveredDates,['2026-09-30','2026-10-01']);
});
test('P0 manifest rejects new versions, unknown keys and impossible dates',()=>{
  for(const patch of [{version:2},{untrustedField:true},{month:'2026-13'},{coveredDates:['2026-02-30']},{coveredDates:['2026-09-30','2026-09-30']}])
    rejected(()=>validateMonthlyArchiveManifest({...manifest,...patch}),'ARCHIVE_INVALID');
});
test('P0 manifest rejects path traversal, duplicate records files and invalid SHA-256',()=>{
  for(const files of [[{...manifest.files[0],path:'../records.json'}],[...manifest.files,...manifest.files],[{...manifest.files[0],sha256:'abc'}]])
    rejected(()=>validateMonthlyArchiveManifest({...manifest,files}),'ARCHIVE_INVALID');
  rejected(()=>validateMonthlyArchiveManifest({...manifest,recordCounts:{privateHandles:1}}),'ARCHIVE_INVALID');
});
test('P0 budgets use UTF-8 bytes and accept equality but reject the next byte',()=>{
  for(const [kind,limit] of [['active-backup',4096],['input',8192],['archive-compressed',2048],['archive-expanded',8192]] as const){
    checkV06ByteBudget(kind,limit,testCapacity);
    rejected(()=>checkV06ByteBudget(kind,limit+1,testCapacity),kind.startsWith('archive')?'ARCHIVE_BUDGET_EXCEEDED':'DATA_TOO_LARGE');
  }
  const text='汉'.repeat(4);assert.equal(text.length,4);
  rejected(()=>checkV06ByteBudget('active-backup',new TextEncoder().encode(text).byteLength,{...testCapacity,maxActiveBackupBytes:8}),'DATA_TOO_LARGE');
});
test('P0 accepted backup must fit the recovery input gate; compression does not bypass expansion budget',()=>{
  rejected(()=>checkV06ByteBudget('active-backup',1,{...testCapacity,maxInputBytes:1024}));
  checkV06ByteBudget('archive-compressed',100,testCapacity);
  rejected(()=>checkV06ByteBudget('archive-expanded',9000,testCapacity),'ARCHIVE_BUDGET_EXCEEDED');
});
test('P0 test adapter returns detached read snapshots and preserves deck member order',async()=>{
  const fixture=structuredClone(seed());fixture.catalog.decks[0].memberIds=['link-a','book-a'];
  const port=createV06TestPort(fixture);fixture.catalog.catalogEntries[0].title='external mutation';
  const deck=await port.readDeck({token:TOKEN,deckId:'books'});assert.equal(deck.ok,true);
  if(deck.ok)assert.deepEqual(deck.value.data.members.map(m=>m.id),['link-a','book-a']);
  const first=await port.readCatalog({token:TOKEN});assert.equal(first.ok,true);
  if(first.ok)(first.value.data.catalogEntries[0] as {title:string}).title='result mutation';
  const second=await port.readCatalog({token:TOKEN});if(!second.ok)assert.fail('read failed');
  assert.equal(second.value.data.catalogEntries[0].title,'合成书目甲');
  assert.equal(port.stamp.backend,'test-adapter');
});
test('P0 stale epoch and revision are rejected; submit never reports fixture persistence',async()=>{
  const port=createV06TestPort(seed());
  assert.equal((await port.readCatalog({token:{...TOKEN,epoch:'replaced'}})).code,'WORKSPACE_REPLACED');
  assert.equal((await port.readCatalog({token:{...TOKEN,revision:8}})).code,'REVISION_CONFLICT');
  assert.equal((await port.submit(synthesisRequest)).code,'CONTRACT_NOT_IMPLEMENTED');
  assert.equal((await port.previewSynthesis({token:TOKEN,inputs:[{id:'a',version:1},{id:'b',version:1}],resolutions:[]})).code,'CONTRACT_NOT_IMPLEMENTED');
  assert.equal((await port.submit({...synthesisRequest,type:'AutoClearMonth'} as never)).code,'INVALID_INPUT');
  assert.equal((await port.submit({...clearRequest,expected:{...TOKEN,epoch:'replaced'}})).code,'WORKSPACE_REPLACED');
});
test('P0 archive views have no editable state or business mutation endpoint',async()=>{
  assert.equal(archiveView.access,'archive');assert.equal(archiveView.editable,false);
  assert.equal('token' in archiveView,false);
  const port=createV06TestPort(seed());assert.equal('updateArchive' in port,false);
  const timeline=await port.readJournalTimeline({date:journal.date,zone:journal.zone,source:{kind:'live',token:TOKEN}});
  if(!timeline.ok)assert.fail('read failed');assert.equal(timeline.value.access,'live');assert.equal(timeline.value.editable,true);
});
test('P0 declarations leave the production backup/restore path at v4 with exact old text',()=>{
  const pack=exportWorkspace(undefined);assert.equal(pack.version,4);
  pack.data.journalEntries=[{id:'old',version:2,date:'2026-10-01',zone:'Asia/Shanghai',text:'旧正文\r\n\n 空格 ',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z'}];
  const restored=parseRestore(JSON.stringify(pack));assert.equal(restored.dataFormat,'action-v4');assert.deepEqual(restored.data,pack.data);
  assert.throws(()=>parseRestore(JSON.stringify({...pack,version:5,dataFormat:'action-v5'})));
});
test('C0 and monthly behavioral vectors remain specifications, not passed implementation tests',()=>{
  assert.equal(c0Cases.length,32);assert.equal(monthCases.length,12);
  assert.equal(new Set([...c0Cases,...monthCases].map(c=>c.id)).size,44);
  assert.equal(monthCases.some(c=>c.id==='M02'&&c.expected.error==='ARCHIVE_NOT_VERIFIED'),true);
});
