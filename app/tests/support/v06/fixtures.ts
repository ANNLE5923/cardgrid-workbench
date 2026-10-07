/** Literal shared P0 fixtures. No domain functions generate the expected result. */
import type {ArchiveIndexEntry, ArchiveView, AnswerSnapshot, CapacityPolicy, CatalogV06, HandCard, JournalTimeline, MaintenanceEvent, MonthlyArchiveManifest, RecoveryCoverage, ReferenceDraft, TextOutputState, TextWriteIntent, V06Command} from '../../../src/workspace/v06.ts';
import type {Content, Token} from '../../../src/workspace/contracts.ts';
export const AT = '2026-10-06T00:12:00Z';
export const TOKEN: Token = {epoch: 'p0-synthetic', revision: 7};
export const baseContent: Content = {title: '合成行动', criteria: '完成一个可核对结果', presetMinutes: 30, color: '#336699', categoryId: null, categoryLabel: null, minimum: false, projectIds: [], goalIds: [], projectLabels: [], goalLabels: []};
export const catalog: CatalogV06 = {
  actionCards: [
    {id: 'read', version: 1, kind: 'action', content: {...baseContent,title: '阅读《{对象}》'}, fields: [{id:'subject',label:'对象',valueType:'text',required:true}], status:'active',parentId:null,source:{kind:'manual'}},
    {id: 'meal', version: 1, kind: 'action', content: {...baseContent,title: '吃饭：{对象}'}, fields: [{id:'subject',label:'对象',valueType:'text',required:true}], status:'active',parentId:null,source:{kind:'manual'}},
    {id: 'train', version: 1, kind: 'action', content: {...baseContent,title: '锻炼：{对象}'}, fields: [{id:'subject',label:'对象',valueType:'text',required:true}], status:'active',parentId:null,source:{kind:'manual'}},
  ],
  catalogEntries: [
    {id:'book-a',version:1,title:'合成书目甲',attributes:{author:'合成作者'},url:null,status:'active',source:{kind:'manual'}},
    {id:'food-a',version:1,title:'合成餐食甲',attributes:{},url:null,status:'active',source:{kind:'manual'}},
    {id:'exercise-a',version:1,title:'合成锻炼甲',attributes:{minutes:20},url:null,status:'active',source:{kind:'manual'}},
    {id:'link-a',version:1,title:'合成网址',attributes:{},url:'https://example.com/',status:'active',source:{kind:'manual'}},
  ],
  decks: [
    {id:'books',version:1,name:'书目',deckKind:'entry',parentDeckId:null,memberIds:['book-a'],source:{kind:'manual'}},
    {id:'foods',version:1,name:'餐食',deckKind:'entry',parentDeckId:null,memberIds:['food-a'],source:{kind:'manual'}},
    {id:'exercises',version:1,name:'锻炼',deckKind:'entry',parentDeckId:null,memberIds:['exercise-a'],source:{kind:'manual'}},
    {id:'loose-list',version:1,name:'独立清单',deckKind:'entry',parentDeckId:null,memberIds:['link-a'],source:{kind:'manual'}},
    {id:'empty-list',version:1,name:'空清单',deckKind:'entry',parentDeckId:null,memberIds:[],source:{kind:'manual'}},
  ],
  decisionCards: [
    {id:'which-book',version:1,question:'读哪本？',ownerActionId:'read',deckIds:['books'],mappings:[{fieldId:'subject',entryPath:'title'}],status:'active',source:{kind:'manual'}},
    {id:'which-food',version:1,question:'吃什么？',ownerActionId:'meal',deckIds:['foods'],mappings:[{fieldId:'subject',entryPath:'title'}],status:'active',source:{kind:'manual'}},
    {id:'which-exercise',version:1,question:'练什么？',ownerActionId:'train',deckIds:['exercises'],mappings:[{fieldId:'subject',entryPath:'title'}],status:'active',source:{kind:'manual'}},
    {id:'which-book-again',version:1,question:'再读哪本？',ownerActionId:'read',deckIds:['books'],mappings:[{fieldId:'subject',entryPath:'title'}],status:'active',source:{kind:'manual'}},
  ],
};
export const answer: AnswerSnapshot = {decision:{id:'which-book',version:1},question:'读哪本？',ownerAction:{id:'read',version:1},entry:catalog.catalogEntries[0],sourceDecks:[{id:'books',version:1}],mappings:[{fieldId:'subject',entryPath:'title'}],fieldValues:[{fieldId:'subject',value:'合成书目甲'}],selectedAt:AT};
export const materials: readonly HandCard[] = [
  {id:'read-take-1',version:1,kind:'action',state:'available',createdAt:AT,provenance:[{kind:'manual',source:{id:'read',version:1}}],inputIds:[],expiresAt:null,consumedBy:null,actionInstanceId:null,ownerAction:{id:'read',version:1},contentSnapshot:catalog.actionCards[0].content,fieldSpecs:catalog.actionCards[0].fields,fieldValues:[]},
  {id:'which-book-answer-1',version:1,kind:'answer',state:'available',createdAt:AT,provenance:[{kind:'answer',snapshot:answer}],inputIds:[],expiresAt:null,consumedBy:null,answer},
];
export const journal: JournalTimeline = {date:'2026-10-06',zone:'Asia/Shanghai',automatic:[],notes:[{id:'note-1',version:1,kind:'reflection',date:'2026-10-06',zone:'Asia/Shanghai',recordedAt:AT,createdAt:AT,updatedAt:AT,text:'今天早餐很好吃。'}],legacyBlocks:[]};
export const manifest: MonthlyArchiveManifest = {format:'cardgrid-monthly-archive',version:1,archiveId:'archive-202609',workspaceId:'synthetic-workspace',month:'2026-09',zone:'Asia/Shanghai',createdAt:AT,sourceToken:TOKEN,sourceDataFormat:'action-v5',closure:'self-contained',coveredDates:['2026-09-30','2026-10-01'],recordCounts:{facts:1,journalNotes:1},files:[{path:'records.json',sha256:'a'.repeat(64),bytes:1024}]};
export const archiveIndex: ArchiveIndexEntry = {archiveId:'archive-202609',workspaceId:'synthetic-workspace',month:'2026-09',zone:'Asia/Shanghai',manifestSha256:'b'.repeat(64),recordsSha256:'a'.repeat(64),coveredDates:['2026-09-30','2026-10-01'],recordCounts:{facts:1,journalNotes:1}};
// Read-only view fixture has its own accurate counts; manifest models a different export.
export const archiveView: ArchiveView = {access:'archive',editable:false,index:{...archiveIndex,archiveId:'archive-empty-view',recordCounts:{}},catalog,instances:[],plans:[],facts:[],annotations:[],journal:[{...journal,date:'2026-09-30',notes:[]}]};
// Tiny budgets are for boundary tests, not a suggested production capacity.
export const testCapacity: CapacityPolicy = {status:'provisional',maxActiveBackupBytes:4096,maxInputBytes:8192,maxArchiveCompressedBytes:2048,maxArchiveExpandedBytes:8192,maxArchiveEntries:2,maxLoadedArchiveMonths:1};
export const synthesisRequest: V06Command = {contractVersion:'v06-p0-1',commandId:'synthesize-1',expected:TOKEN,type:'ConfirmSynthesis',payload:{previewId:'preview-synthesis-1'}};
export const clearRequest: V06Command = {contractVersion:'v06-p0-1',commandId:'archive-clear-1',expected:TOKEN,type:'CommitMonthlyArchive',payload:{previewId:'preview-month-1',verificationId:'verified-external-1',clearPreviewId:'clear-preview-1',removalConfirmed:true}};
export const referenceDraft: ReferenceDraft = {answer:{id:'which-book-answer-1',version:1},mode:'point',local:{date:'2026-10-06',time:'08:00',zone:'Asia/Shanghai'}};
export const maintenanceEvent: MaintenanceEvent = {eventId:'url-open-1',epoch:TOKEN.epoch,at:AT,date:'2026-10-06',zone:'Asia/Shanghai',category:'url',operation:'OpenListUrl',stage:'requested',commandId:null,sourceHistoryIds:[],entityRefs:[{kind:'catalog-entry',id:'link-a'}],errorCode:null,details:{url:'https://example.com/'}};
export const filePermissionFailure: TextOutputState = {key:{bindingId:'directory-1',connectionVersion:1,epoch:TOKEN.epoch,kind:'journal',date:'2026-10-06',zone:'Asia/Shanghai'},status:'permission-required',lastSuccess:{text:'旧输出',sha256:'c'.repeat(64),source:{kind:'journal',token:{...TOKEN,revision:6},inputFingerprint:'source-6'},succeededAt:AT},pendingSource:{kind:'journal',token:TOKEN,inputFingerprint:'source-7'},error:'需要重新授权目录',externalCopyPath:null};
export const closedIntent: TextWriteIntent = {intentId:'write-1',text:'新输出',sha256:'d'.repeat(64),source:{kind:'journal',token:TOKEN,inputFingerprint:'source-7'},stage:'closed'};
export const missingArchiveCoverage: RecoveryCoverage = {kind:'active-plus-archives',required:[{archiveId:archiveIndex.archiveId,workspaceId:archiveIndex.workspaceId,manifestSha256:archiveIndex.manifestSha256,recordsSha256:archiveIndex.recordsSha256}],availableArchiveIds:[],missing:[{archiveId:archiveIndex.archiveId,workspaceId:archiveIndex.workspaceId,manifestSha256:archiveIndex.manifestSha256,recordsSha256:archiveIndex.recordsSha256}],complete:false};
export const monthCases = [
  {id:'M01',case:'unexported-month',expected:{automaticRemoval:false}},
  {id:'M02',case:'download-without-external-reread',expected:{error:'ARCHIVE_NOT_VERIFIED',writes:0}},
  {id:'M03',case:'open-cross-month-action',expected:{retained:true}},
  {id:'M04',case:'same-archive-id-same-hash',expected:{disposition:'duplicate'}},
  {id:'M05',case:'same-archive-id-different-hash',expected:{error:'ARCHIVE_CONFLICT'}},
  {id:'M06',case:'corrupt-or-missing-dependency',expected:{error:'ARCHIVE_INCOMPLETE',writes:0}},
  {id:'M07',case:'old-token-after-preview',expected:{error:'PREVIEW_STALE',writes:0}},
  {id:'M08',case:'archive-journal-edit',expected:{error:'ARCHIVE_READ_ONLY',writes:0}},
  {id:'M09',case:'missing-required-zip',expected:{complete:false,activeDataStillReadable:true}},
  {id:'M10',case:'expanded-byte-budget-exceeded',expected:{error:'ARCHIVE_BUDGET_EXCEEDED',writes:0}},
  {id:'M11',case:'switch-month',expected:{oldDecodedMonthReleased:true,compressedBlobRetained:true}},
  {id:'M12',case:'workspace-replaced-before-clear',expected:{error:'WORKSPACE_REPLACED',writes:0}},
] as const;
