import {useEffect,useRef,useState} from 'react';
import {createWorkspaceClient,createWorkshopHost,type WorkspaceClient,type BackupPreparation,type WorkspaceSnapshot,type Command,type ConfigV2,type ConfigV3,type ProductionDayView,type Settings,type WorkspacePreview} from '../workspace/index.ts';
import {validateDefinitionConfig} from '../workspace/codec.ts';
import {nextDate} from '../daily/time.ts';
import {sameValue} from '../daily/model.ts';
import {merge3} from './config-merge.ts';
import {dateKey,download} from './files.ts';
import type {TabId} from './navigation.ts';
import {createWorkspaceDrawSession, type WorkspaceDrawSession} from '../drawing/model.ts';
import {inventoryBoundary} from './inventory-boundary.ts';
/** App-owned lifecycle. Same-epoch token adoption preserves configuration drafts. */
export function useWorkspaceApp(){
 const host=useRef<WorkspaceClient|null>(null);if(!host.current)host.current=createWorkspaceClient();const client=host.current;
 const drawHost=useRef<WorkspaceDrawSession|null>(null);if(!drawHost.current)drawHost.current=createWorkspaceDrawSession(client);const drawing=drawHost.current;
 const workshopHostRef=useRef<ReturnType<typeof createWorkshopHost>|null>(null);if(!workshopHostRef.current)workshopHostRef.current=createWorkshopHost(client);const workshopHost=workshopHostRef.current;
 const [snapshot,setSnapshot]=useState<WorkspaceSnapshot|null>(null),current=useRef<WorkspaceSnapshot|null>(null);
 const [fatal,setFatal]=useState(''),[message,setMessage]=useState(''),[tab,setTab]=useState<TabId>('agenda');
 const [templateId,setTemplateId]=useState('');
 const [preparationRevision,setPreparationRevision]=useState(0);
 const [date,setDate]=useState(dateKey()),[zone,setZone]=useState(Intl.DateTimeFormat().resolvedOptions().timeZone),[day,setDay]=useState<ProductionDayView|null>(null);
 const [draft,setDraft]=useState<ConfigV2|ConfigV3|null>(null),[json,setJson]=useState(''),[baseline,setBaseline]=useState(''),[editor,setEditor]=useState<'form'|'json'>('form');
 const [busy,setBusy]=useState(false),[backup,setBackup]=useState<BackupPreparation|null>(null),[saved,setSaved]=useState(false),[discard,setDiscard]=useState(false),[resetText,setResetText]=useState('');
 const [pending,setPending]=useState<WorkspacePreview|null>(null);
 const [fileText,setFileText]=useState(''),[merge,setMerge]=useState<'merge'|'replace'>('merge'),[recovery,setRecovery]=useState<readonly {key:IDBValidKey;value:unknown}[]>([]);
 const [readonlyPaths,setReadonlyPaths]=useState<string[]>([]),[offsets,setOffsets]=useState('{}'),[capture,setCapture]=useState('');
 const file=useRef<HTMLInputElement>(null),lock=useRef(false),retry=useRef<Command|null>(null);
 const dirty=json!==baseline;
 function resetSession(){client.invalidateCapabilities();setPending(null);setBackup(null);setSaved(false);setDiscard(false);retry.current=null;}
 async function install(next:WorkspaceSnapshot){current.current=next;setSnapshot(next);setFatal('');resetSession();setResetText('');setFileText('');setReadonlyPaths([]);setOffsets('{}');setCapture('');
  const common=next.data?{settings:next.data.settings,definitions:next.data.planner.definitions,templates:next.data.planner.templates,rules:next.data.planner.rules}:null;
  const config:ConfigV2|ConfigV3|null=next.data&&common?(next.data.version===3
    ?{format:'cardgrid',version:3,kind:'config',config:{...common,actionCards:next.data.actionCards,bookEntries:next.data.bookEntries,pools:next.data.pools,generationRules:next.data.generationRules}}
    :{format:'cardgrid',version:2,kind:'config',config:common}):null;
  const text=config?JSON.stringify(config,null,2):'';setDraft(config);setJson(text);setBaseline(text);if(next.data?.settings.zone)setZone(next.data.settings.zone);
  const points=await client.readRecovery();if(points.ok)setRecovery(points.value);
 }
 async function reload(){const result=await client.load();if(result.ok)await install(result.value);else setFatal(result.message);}
 // Adopt a newer same-epoch snapshot/token without resetting config drafts or other inputs.
 function adopt(next:WorkspaceSnapshot){current.current=next;setSnapshot(next);}
 useEffect(()=>{void reload().then(()=>drawing.start());const activate=()=>{if(document.visibilityState==='visible')void drawing.coordinate();};window.addEventListener('focus',activate);document.addEventListener('visibilitychange',activate);const unsubscribe=client.subscribe((external:boolean)=>{void client.load().then(async result=>{
  if(!result.ok){setFatal(result.message);return;}const previous=current.current;if(!previous)return;
  if(result.value.token.epoch!==previous.token.epoch){await install(result.value);setMessage('工作区已被替换，旧草稿和预览已清除。');}
  else if(result.value.token.revision!==previous.token.revision){adopt(result.value);
   if(external){client.invalidateCapabilities();setPending(null);setMessage('另一窗口已保存，已为你重新读取；当前输入仍保留。');}}
 });});return()=>{window.removeEventListener('focus',activate);document.removeEventListener('visibilitychange',activate);drawing.close();unsubscribe();client.close();};},[]);
 useEffect(()=>{let active=true;setDay(null);if(snapshot)void client.readDay({date,zone}).then(result=>{if(!active)return;if(result.ok)setDay(result.value);else setMessage(result.message);});return()=>{active=false;};},[snapshot,date,zone]);
 // Hidden pages do not poll. A visible app wakes once at the earliest rule-zone midnight.
 useEffect(()=>{let timer:ReturnType<typeof setTimeout>|undefined,alive=true;
  const arm=()=>{if(timer)clearTimeout(timer);if(!alive||document.visibilityState!=='visible')return;
   const at=new Date().toISOString(),end=inventoryBoundary(snapshot?.data??null,at);if(!end)return;
   timer=setTimeout(()=>{void drawing.coordinate().finally(()=>{if(alive)arm();});},Math.max(100,Date.parse(end)-Date.parse(at)+25));};
  arm();document.addEventListener('visibilitychange',arm);return()=>{alive=false;if(timer)clearTimeout(timer);document.removeEventListener('visibilitychange',arm);};
 },[snapshot,drawing]);
 useEffect(()=>{const unload=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[dirty]);
 async function submit(command:Command){if(lock.current)return false;lock.current=true;setBusy(true);retry.current=command;
  try{const response=await client.submit(command);if(!response.ok){setMessage(response.message);if(response.retry!=='same-command')retry.current=null;if(response.code==='WORKSPACE_REPLACED')await reload();return false;}
   await reload();if(command.type==='PrepareDay')setPreparationRevision(value=>value+1);setMessage('已保存到本机');return true;
  }finally{lock.current=false;setBusy(false);}
 }
 function command(type:Command['type'],payload:unknown){if(!snapshot)return Promise.resolve(false);return submit({commandId:crypto.randomUUID(),expected:snapshot.token,type,payload} as Command);}
 async function prepareBackup(){const result=await client.prepareBackup();if(!result.ok){setMessage(result.message);return;}setBackup(result.value);setSaved(false);download('CardGrid-完整备份-'+dateKey()+'.json',JSON.parse(result.value.text));setMessage(result.value.diagnosticOnly?'已生成诊断原文；该文件超过可恢复导入上限。':'完整备份已生成，请确认文件已保存。');}
 async function previewFile(text:string){if(!snapshot)return;setFileText(text);setPending(null);setDiscard(false);try{
  const pack=JSON.parse(text);if(pack.kind==='config'){
   const result=await client.previewDefinitions({token:snapshot.token,text,mode:merge});if(!result.ok){setMessage(result.message);return;}setPending({type:'ImportDefinitions',previewId:result.value.previewId,details:result.value,blocked:false,mode:merge});
  }else if(pack.format!=='cardgrid'){const result=await client.previewMigration({token:snapshot.token,choices:{zone:null},source:{format:'legacy-archive',raw:pack}});if(!result.ok){setMessage(result.message);return;}setPending({type:'CommitMigration',previewId:result.value.previewId,details:result.value,blocked:result.value.issues.some(i=>i.blocking)});
  }else{const result=await client.previewRestore({token:snapshot.token,text});if(!result.ok){setMessage(result.message);return;}setPending({type:'RestoreWorkspace',previewId:result.value.previewId,details:{模式:result.value.mode,格式:result.value.dataFormat,说明:'执行后与文件数据完全一致'},blocked:false});}
 }catch(error){setMessage((error as Error).message);}}
 async function migration(){if(!snapshot)return;setPending(null);setDiscard(false);try{
  const result=await client.previewMigration({token:snapshot.token,choices:{zone,readonlyPaths,offsets:JSON.parse(offsets)}});if(!result.ok){setMessage(result.message);return;}
  setPending({type:'CommitMigration',previewId:result.value.previewId,details:result.value,blocked:result.value.issues.some(i=>i.blocking)});
 }catch(error){setMessage((error as Error).message);}}
 async function execute(){if(!snapshot||!backup||!saved||!discard)return;const evidence={token:backup.token,dataFingerprint:backup.dataFingerprint,fileSavedConfirmed:true as const};
  if(pending)await command(pending.type,pending.type==='ImportDefinitions'?{previewId:pending.previewId,mode:pending.mode!,backup:evidence}:{previewId:pending.previewId,backup:evidence,discardDraftsConfirmed:true});
  else if(resetText==='清空')await command('ClearWorkspace',{backup:evidence,discardDraftsConfirmed:true});
 }
 function navigation(next:typeof tab){drawing.cancel();client.invalidateCapabilities();setPending(null);retry.current=null;setTab(next);if(next==='hand')void drawing.coordinate();}
 function stepDate(delta:number){client.invalidateCapabilities();setPending(null);setDate(nextDate(date,delta));}
 function changeSettings(settings:ConfigV2['config']['settings']){if(!draft)return;const update=<T extends ConfigV2|ConfigV3>(pack:T):T=>({...pack,config:{...pack.config,settings}});const next=update(draft);setDraft(next);setJson(JSON.stringify(next,null,2));}
 async function saveSettings(){if(!draft||!snapshot?.data)return;try{validateDefinitionConfig(draft);
  const changedDirectory=JSON.stringify([draft.config.definitions,draft.config.templates,draft.config.rules])!==JSON.stringify([snapshot.data.planner.definitions,snapshot.data.planner.templates,snapshot.data.planner.rules])
    || draft.version===3&&(snapshot.data.version!==3||!sameValue({actionCards:draft.config.actionCards,bookEntries:draft.config.bookEntries,pools:draft.config.pools,generationRules:draft.config.generationRules},
      {actionCards:snapshot.data.actionCards,bookEntries:snapshot.data.bookEntries,pools:snapshot.data.pools,generationRules:snapshot.data.generationRules}));
  if(changedDirectory){await previewFile(JSON.stringify(draft));setTab('data');}else{
   if(!baseline){setMessage('缺少编辑基线，请重新载入后再保存。');return;}
   const baseSettings=JSON.parse(baseline).config.settings as Settings;
   const merged=merge3(baseSettings,draft.config.settings,snapshot.data.settings);
   if('conflicts'in merged){setMessage('这些设置与另一窗口同时修改，请先决定：'+merged.conflicts.map(c=>c.path).join('、'));return;}
   if(sameValue(merged.value,snapshot.data.settings)){setMessage('没有需要保存的偏好改动。');return;}
   await command('SaveSettings',{settings:merged.value});
  }
 }catch(error){setMessage((error as Error).message);}}

 return {client,drawing,workshopHost,snapshot,fatal,message,setMessage,tab,setTab,templateId,setTemplateId,preparationRevision,date,setDate,zone,setZone,day,draft,setDraft,json,setJson,baseline,editor,setEditor,busy,backup,saved,setSaved,discard,setDiscard,resetText,setResetText,pending,setPending,fileText,merge,setMerge,recovery,readonlyPaths,setReadonlyPaths,offsets,setOffsets,capture,setCapture,file,retry,dirty,reload,submit,command,prepareBackup,previewFile,migration,execute,navigation,stepDate,changeSettings,saveSettings};
}
