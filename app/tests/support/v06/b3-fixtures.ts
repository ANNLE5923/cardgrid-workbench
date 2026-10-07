import type {DataV4,Instance,Plan} from '../../../src/workspace/index.ts';
import type {JournalProjectionInput} from '../../../src/journal/model.ts';
import {emptyWorkspaceData} from '../../../src/workspace/codec.ts';
import {projectDay} from '../../../src/daily/projection.ts';
import {recordRange} from '../../../src/daily/time.ts';
import {AT,TOKEN,baseContent,journal} from './fixtures.ts';
export const ZONE='Asia/Shanghai',DATE='2026-10-06';
export const instance:Instance={id:'breakfast',version:1,definition:null,creationSnapshot:{...baseContent,title:'早餐'},currentContent:{...baseContent,title:'早餐'},source:{kind:'manual'},createdAt:AT,targetDate:null,state:'open',occurrenceId:null,makeupOf:null};
export const plan:Plan={id:'plan-breakfast',version:1,instanceId:instance.id,range:recordRange({startAt:'2026-10-06T00:00:00Z',endAt:'2026-10-06T00:30:00Z',zone:ZONE}),contentSnapshot:instance.currentContent,status:'active',createdAt:AT,changedAt:AT};
export function data():DataV4 {
  const blank=emptyWorkspaceData();return {...blank,settings:{...blank.settings,zone:ZONE},planner:{...blank.planner,instances:[structuredClone(instance)],plans:[structuredClone(plan)],fixed:[{id:'sleep',version:1,title:'已有夜间安排',range:recordRange({startAt:'2026-10-05T15:00:00Z',endAt:'2026-10-05T22:00:00Z',zone:ZONE}),cancelled:false,ownerDate:'2026-10-05',template:null,templateEntryId:null,manuallyOverridden:false,source:{kind:'manual'}}]}};
}
export function projectionInput(value=data(),date=DATE,zone=ZONE):JournalProjectionInput {
  const snapshot={token:TOKEN,mode:'current' as const,data:value,raw:{schemaVersion:4,epoch:TOKEN.epoch,revision:TOKEN.revision,lifecycleReceipt:null,mode:'current',dataFormat:'action-v4',data:value},rawKey:'b3-synthetic-only'};
  return {day:projectDay(snapshot,{date,zone},AT),templates:value.planner.templates,notes:structuredClone(journal.notes),legacyEntries:value.journalEntries,materials:[],references:[],factReferences:[]};
}
export const frozen=(value:any):any=>{if(value&&typeof value==='object'){Object.values(value).forEach(frozen);Object.freeze(value);}return value;};
