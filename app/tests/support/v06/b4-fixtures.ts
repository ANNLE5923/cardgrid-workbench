import assert from 'node:assert/strict';
import {harness,ok,actionCard,bookEntry,pool,rule} from '../../modules/workspace/v3-fixtures.ts';
import {createV06Host} from '../../../src/workspace/v06-host.ts';
import {upgradeV3ToV4,validateActionData} from '../../../src/workspace/format.ts';
import {AT,catalog} from './fixtures.ts';
import type {V06Command} from '../../../src/workspace/ports-v06.ts';
export {ok};
export const ref=(item:{id:string;version:number})=>({id:item.id,version:item.version});
export async function b4Harness(options:{catalog?:boolean;acceptOld?:boolean;journalDate?:string}={}){
  const legacy=harness();
  ok(await legacy.submit('SaveBookEntry',{bookEntry:bookEntry(),expectedVersion:null}));
  ok(await legacy.submit('SavePool',{pool:pool({id:'old-books'}),expectedVersion:null}));
  ok(await legacy.submit('SaveActionCard',{actionCard:actionCard({slots:[{id:'book',label:'书名',poolId:'old-books',required:true,valueKind:'entry'}]}),expectedVersion:null}));
  ok(await legacy.submit('SaveGenerationRule',{generationRule:rule(),expectedVersion:null}));
  if(options.acceptOld){await legacy.generate();await legacy.accept();}
  const beforeRaw=legacy.evidence().raw as any;const data=upgradeV3ToV4(beforeRaw.data);
  (data as any).journalEntries=[{id:'old-journal',version:2,date:options.journalDate??'2026-10-04',zone:'Asia/Shanghai',text:'旧全文\r\n  空格\n\n保留 ',createdAt:'2026-10-04T01:00:00Z',updatedAt:'2026-10-04T02:00:00Z'}];validateActionData(data);
  legacy.store.__setRaw({...beforeRaw,dataFormat:'action-v4',data});
  let sequence=0,at=AT,randomCalls=0;const host=createV06Host({store:legacy.store,now:()=>at,id:()=>`b4-${++sequence}`,random:()=>{randomCalls++;return 0;}});
  const snapshot=async()=>ok(await host.load()),token=async()=>(await snapshot()).token;
  const command=async(type:V06Command['type'],payload:any,commandId=`b4-command-${++sequence}`)=>({contractVersion:'v06-p0-1' as const,type,payload,commandId,expected:await token()} as V06Command);
  const submit=async(type:V06Command['type'],payload:any)=>ok(await host.submit(await command(type,payload)));
  async function backup(){const prepared=ok(await host.prepareBackup());return {token:prepared.token,dataFingerprint:prepared.dataFingerprint,fileSavedConfirmed:true as const};}
  async function migrate(){const preview=ok(await host.previewMigrationV5({token:await token()})),backupEvidence=await backup();return ok(await host.submit({commandId:`migrate-${++sequence}`,type:'CommitMigration',expected:await token(),payload:{previewId:preview.previewId,backup:backupEvidence,discardDraftsConfirmed:true}}));}
  await migrate();
  if(options.catalog!==false){for(const [type,key,payloadKey] of [['SaveActionCardV5','actionCards','actionCard'],['SaveCatalogEntry','catalogEntries','entry'],['SaveDeck','decks','deck'],['SaveDecisionCard','decisionCards','decision']] as const)
    for(const item of catalog[key])await submit(type,{[payloadKey]:item,expectedVersion:null});}
  const liveData=async()=>{const s=await snapshot();assert.equal((s.data as any).version,5);return s.data as any;};
  async function answer(alsoTakeAction=false){const preview=ok(await host.previewDecision({token:await token(),decision:ref(catalog.decisionCards[0]),deckIds:['books']}));const selected=ok(await host.selectDecisionEntry({token:await token(),previewId:preview.previewId,choice:{mode:'random'}}));await submit('AcceptDecisionAnswer',{selectionId:selected.selectionId,alsoTakeAction});return (await liveData()).handCards.find((c:any)=>c.kind==='answer'&&c.answer.decision.id==='which-book');}
  return {host,legacy,token,snapshot,command,submit,backup,migrate,liveData,answer,randomCalls:()=>randomCalls,setNow(value:string){at=value;},old:data};
}
