import {createWorkspaceStore} from '../../src/workspace/store.ts';
import {createWorkspaceClient} from '../../src/workspace/client.ts';
import {createV06Host} from '../../src/workspace/v06-host.ts';
import {catalog,AT} from '../support/v06/fixtures.ts';
import {actionCard,bookEntry,pool,rule} from '../modules/workshop/a1-fixtures.ts';
import {validateDataV5,backupV5,activeBytes,MAX_BACKUP_BYTES,MAX_INPUT_BYTES} from '../../src/workspace/v5-format.ts';
import {validateActionData} from '../../src/workspace/format.ts';
const ok=(r:any)=>{if(!r.ok)throw new Error(JSON.stringify(r));return r.value;};
const ref=(i:any)=>({id:i.id,version:i.version});
export function installB4(name:string,textRuntime?:import('../../src/text-output/index.ts').TextRuntime,archiveRuntime?:import('../../src/workspace/v06-archives.ts').ArchiveRuntime){
  const base=createWorkspaceStore({name});let lose=false,at=AT;
  const store={...base,async atomicMonthlyArchive<T>(keys:readonly string[],reduce:Parameters<NonNullable<typeof base.atomicMonthlyArchive<T>>>[1]){const result=await base.atomicMonthlyArchive!(keys,reduce);if(lose){lose=false;throw Error('lost reply after real archive transaction');}return result;},async atomic<T>(reduce:Parameters<typeof base.atomic<T>>[0]){const result=await base.atomic(reduce);if(lose){lose=false;throw new Error('lost reply after real IDB commit');}return result;}};
  const legacy=createWorkspaceClient({store,now:()=>at,random:()=>0}),host=createV06Host({store,now:()=>at,random:()=>0,textRuntime,archiveRuntime,...(textRuntime?{textDebounceMs:100000}:{})});
  const snapshot=async()=>ok(await host.load()),token=async()=>(await snapshot()).token;
  const command=async(type:any,payload:any,commandId=crypto.randomUUID())=>({contractVersion:'v06-p0-1' as const,type,payload,commandId,expected:await token()});
  const submit=async(type:any,payload:any)=>ok(await host.submit(await command(type,payload)));
  const data=async()=>(await snapshot()).data;
  async function backup(){const b=ok(await host.prepareBackup());return {token:b.token,dataFingerprint:b.dataFingerprint,fileSavedConfirmed:true};}
  async function migrate(){const p=ok(await host.previewMigrationV5({token:await token()}));return ok(await host.submit({commandId:crypto.randomUUID(),expected:await token(),type:'CommitMigration',payload:{previewId:p.previewId,backup:await backup(),discardDraftsConfirmed:true}}));}
  async function setup(){
    const oldSubmit=async(type:any,payload:any)=>ok(await legacy.submit({type,payload,expected:ok(await legacy.load()).token,commandId:crypto.randomUUID()}));
    await oldSubmit('SaveBookEntry',{bookEntry:bookEntry(),expectedVersion:null});await oldSubmit('SavePool',{pool:pool({id:'old-books'}),expectedVersion:null});
    await oldSubmit('SaveActionCard',{actionCard:actionCard({slots:[{id:'book',label:'书名',poolId:'old-books',required:true,valueKind:'entry'}]}),expectedVersion:null});await oldSubmit('SaveGenerationRule',{generationRule:rule(),expectedVersion:null});
    await oldSubmit('SaveJournalEntry',{date:'2026-10-05',zone:'Asia/Shanghai',text:'旧全文\r\n  留白\n'});
    const old=structuredClone((await snapshot()).data);await migrate();
    for(const [type,key,payloadKey] of [['SaveActionCardV5','actionCards','actionCard'],['SaveCatalogEntry','catalogEntries','entry'],['SaveDeck','decks','deck'],['SaveDecisionCard','decisionCards','decision']] as const)for(const item of catalog[key])await submit(type,{[payloadKey]:item,expectedVersion:null});
    return old;
  }
  async function answer(alsoTakeAction=false){const p=ok(await host.previewDecision({token:await token(),decision:ref(catalog.decisionCards[0]),deckIds:['books']}));const a=ok(await host.selectDecisionEntry({token:await token(),previewId:p.previewId,choice:{mode:'random'}}));await submit('AcceptDecisionAnswer',{selectionId:a.selectionId,alsoTakeAction});return (await data()).handCards.filter((c:any)=>c.kind==='answer').at(-1);}
  async function synthesis(){const a=await answer();await submit('TakeActionMaterial',{action:ref(catalog.actionCards[0])});const action=(await data()).handCards.filter((c:any)=>c.kind==='action').at(-1),p=ok(await host.previewSynthesis({token:await token(),inputs:[ref(action),ref(a)],resolutions:[]}));return {preview:p,command:await command('ConfirmSynthesis',{previewId:p.previewId})};}
  async function evidence(){return {raw:(await store.read())??null,recovery:await store.readRecovery()};}
  async function abort(cmd:any,afterStore:string='workspace'){
    const before=await evidence(),put=IDBObjectStore.prototype.put;let aborted=false;
    IDBObjectStore.prototype.put=function(...args:any[]){const r=put.apply(this,args as any);if(!aborted&&this.name===afterStore){aborted=true;this.transaction.abort();}return r;};
    let result;try{result=await host.submit(cmd);}finally{IDBObjectStore.prototype.put=put;}
    return {before,result,after:await evidence()};
  }
  const value={store,host,legacy,ok,ref,catalog,token,command,submit,data,backup,migrate,setup,answer,synthesis,evidence,abort,validateDataV5,validateActionData,backupV5,activeBytes,MAX_BACKUP_BYTES,MAX_INPUT_BYTES,
    loseNext(){lose=true;},setNow(value:string){at=value;},external:0};base.subscribe(external=>{if(external)value.external++;});return value;
}
