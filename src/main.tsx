import React,{useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Config,Data,Card,Schedule} from './domain';
import {createWorkspaceClient,type WorkspaceClient,type BackupPreparation} from './workspace-client';
import type {WorkspaceSnapshot} from './action-commands';
import type {Command,ConfigV2,MigrationPreview,ProductionDayView,Settings} from './action-contract';
import {validateDefinitionConfig} from './workspace-format';
import {nextDate} from './action-time';
import {Today} from './today';
import {ScheduleView} from './schedule';
import {ActionLibrary} from './action-library';
import {ActionHand} from './action-hand';
import {archiveCapture,discardCapture,resolveCapture,type Planner} from './planner';
import {sameValue} from './action-domain';
import './style.css';
function dateKey(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
function download(name:string,value:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000)}
const clone=<T,>(v:T):T=>structuredClone(v);
const MISSING=Symbol('missing');
function isPlainObject(v:unknown):v is Record<string,unknown>{return v!==null&&typeof v==='object'&&!Array.isArray(v);}
// Three-way merge: base = editing baseline, local = this draft, remote = authoritative latest.
// Unchanged-on-this-side takes remote; only-local keeps local; both-changed-different becomes a conflict.
function merge3(base:unknown,local:unknown,remote:unknown,path:string[]=[]):{value:unknown}|{conflicts:{path:string;base:unknown;local:unknown;remote:unknown}[]}{
 if(sameValue(local,base))return{value:remote};
 if(sameValue(remote,base))return{value:local};
 if(sameValue(local,remote))return{value:local};
 if(isPlainObject(base)||isPlainObject(local)||isPlainObject(remote)){
  const keys=[...new Set([...Object.keys(base??{}),...Object.keys(local??{}),...Object.keys(remote??{})])];
  const out:Record<string,unknown>={};const conflicts:any[]=[];
  for(const k of keys){
   const r=merge3(isPlainObject(base)?base[k]:MISSING,isPlainObject(local)?local[k]:MISSING,isPlainObject(remote)?remote[k]:MISSING,[...path,k]);
   if('conflicts'in r)conflicts.push(...r.conflicts);else out[k]=r.value;
  }
  return conflicts.length?{conflicts}:{value:out};
 }
 return{conflicts:[{path:path.join('.')||'(value)',base,local,remote}]};
}
type TabId='agenda'|'inbox'|'schedule'|'definitions'|'hand'|'config'|'data';
// Single source of truth for page labels/hierarchy (DESIGN.md §分区标签规范): EN caption + ZH title.
const TAB_META:Record<TabId,{en:string;zh:string;desc:string}>={
 agenda:{en:'TODAY',zh:'Today · 今日',desc:'看今天的时间盘与手牌；打开和切换日期不会生成安排。'},
 inbox:{en:'INBOX',zh:'Inbox · 收件箱',desc:'先记下来，稍后再整理；捕获不占时间、不生成事实。'},
 schedule:{en:'SCHEDULE',zh:'Schedule · 日程',desc:'按日期查看完整时间记录；排期请到抽卡手牌。'},
 definitions:{en:'DEFINITIONS',zh:'行动定义',desc:'维护可抽取的行动定义与完成标准。'},
 hand:{en:'HAND',zh:'抽卡手牌',desc:'抽取建议、管理手牌，并在“当日”安排时间。'},
 config:{en:'CONFIG',zh:'配置工坊',desc:'偏好直接保存；定义、模板与例行通过配置包预览后导入。'},
 data:{en:'DATA',zh:'数据与备份',desc:'备份、恢复与迁移；所有文件都留在本机。'},
};
function App(){
 const host=useRef<WorkspaceClient|null>(null);if(!host.current)host.current=createWorkspaceClient();const client=host.current;
 const [snapshot,setSnapshot]=useState<WorkspaceSnapshot|null>(null),current=useRef<WorkspaceSnapshot|null>(null);
 const [fatal,setFatal]=useState(''),[message,setMessage]=useState(''),[tab,setTab]=useState<TabId>('agenda');
 const [templateId,setTemplateId]=useState('');
 const [date,setDate]=useState(dateKey()),[zone,setZone]=useState(Intl.DateTimeFormat().resolvedOptions().timeZone),[day,setDay]=useState<ProductionDayView|null>(null);
 const [draft,setDraft]=useState<ConfigV2|null>(null),[json,setJson]=useState(''),[baseline,setBaseline]=useState(''),[editor,setEditor]=useState<'form'|'json'>('form');
 const [busy,setBusy]=useState(false),[backup,setBackup]=useState<BackupPreparation|null>(null),[saved,setSaved]=useState(false),[discard,setDiscard]=useState(false),[resetText,setResetText]=useState('');
 const [pending,setPending]=useState<{type:'RestoreWorkspace'|'CommitMigration'|'ImportDefinitions';previewId:string;details:unknown;blocked:boolean;mode?:'merge'|'replace'}|null>(null);
 const [fileText,setFileText]=useState(''),[merge,setMerge]=useState<'merge'|'replace'>('merge'),[recovery,setRecovery]=useState<readonly {key:IDBValidKey;value:unknown}[]>([]);
 const [readonlyPaths,setReadonlyPaths]=useState<string[]>([]),[offsets,setOffsets]=useState('{}'),[capture,setCapture]=useState('');
 const file=useRef<HTMLInputElement>(null),lock=useRef(false),retry=useRef<Command|null>(null);
 const dirty=json!==baseline;
 function resetSession(){client.invalidateCapabilities();setPending(null);setBackup(null);setSaved(false);setDiscard(false);retry.current=null;}
 async function install(next:WorkspaceSnapshot){current.current=next;setSnapshot(next);setFatal('');resetSession();setResetText('');setFileText('');setReadonlyPaths([]);setOffsets('{}');setCapture('');
  const config=next.data?{format:'cardgrid' as const,version:2 as const,kind:'config' as const,config:{settings:next.data.settings,definitions:next.data.planner.definitions,templates:next.data.planner.templates,rules:next.data.planner.rules}}:null;
  const text=config?JSON.stringify(config,null,2):'';setDraft(config);setJson(text);setBaseline(text);if(next.data?.settings.zone)setZone(next.data.settings.zone);
  const points=await client.readRecovery();if(points.ok)setRecovery(points.value);
 }
 async function reload(){const result=await client.load();if(result.ok)await install(result.value);else setFatal(result.message);}
 // Adopt a newer same-epoch snapshot/token without resetting config drafts or other inputs.
 function adopt(next:WorkspaceSnapshot){current.current=next;setSnapshot(next);}
 useEffect(()=>{void reload();const unsubscribe=client.subscribe((external:boolean)=>{void client.load().then(async result=>{
  if(!result.ok){setFatal(result.message);return;}const previous=current.current;if(!previous)return;
  if(result.value.token.epoch!==previous.token.epoch){await install(result.value);setMessage('工作区已被替换，旧草稿和预览已清除。');}
  else if(result.value.token.revision!==previous.token.revision){adopt(result.value);
   if(external){client.invalidateCapabilities();setPending(null);setMessage('另一窗口已保存，已为你重新读取；当前输入仍保留。');}}
 });});return()=>{unsubscribe();client.close();};},[]);
 useEffect(()=>{let active=true;setDay(null);if(snapshot)void client.readDay({date,zone}).then(result=>{if(!active)return;if(result.ok)setDay(result.value);else setMessage(result.message);});return()=>{active=false;};},[snapshot,date,zone]);
 useEffect(()=>{const unload=(event:BeforeUnloadEvent)=>{if(dirty){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[dirty]);
 async function submit(command:Command){if(lock.current)return false;lock.current=true;setBusy(true);retry.current=command;
  try{const response=await client.submit(command);if(!response.ok){setMessage(response.message);if(response.retry!=='same-command')retry.current=null;if(response.code==='WORKSPACE_REPLACED')await reload();return false;}
   await reload();setMessage('已保存到本机');return true;
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
 function navigation(next:typeof tab){client.invalidateCapabilities();setPending(null);retry.current=null;setTab(next);}
 function stepDate(delta:number){client.invalidateCapabilities();setPending(null);setDate(nextDate(date,delta));}
 function changeSettings(settings:ConfigV2['config']['settings']){if(!draft)return;const next={...draft,config:{...draft.config,settings}};setDraft(next);setJson(JSON.stringify(next,null,2));}
 async function saveSettings(){if(!draft||!snapshot?.data)return;try{validateDefinitionConfig(draft);
  const changedDirectory=JSON.stringify([draft.config.definitions,draft.config.templates,draft.config.rules])!==JSON.stringify([snapshot.data.planner.definitions,snapshot.data.planner.templates,snapshot.data.planner.rules]);
  if(changedDirectory){await previewFile(JSON.stringify(draft));setTab('data');}else{
   if(!baseline){setMessage('缺少编辑基线，请重新载入后再保存。');return;}
   const baseSettings=JSON.parse(baseline).config.settings as Settings;
   const merged=merge3(baseSettings,draft.config.settings,snapshot.data.settings);
   if('conflicts'in merged){setMessage('这些设置与另一窗口同时修改，请先决定：'+merged.conflicts.map(c=>c.path).join('、'));return;}
   if(sameValue(merged.value,snapshot.data.settings)){setMessage('没有需要保存的偏好改动。');return;}
   await command('SaveSettings',{settings:merged.value});
  }
 }catch(error){setMessage((error as Error).message);}}
 if(fatal)return <div className="failure"><h1>本地数据暂时无法打开</h1><p>{fatal}</p><p>原记录没有被空白数据覆盖。</p><button onClick={()=>void reload()}>重试</button><button onClick={()=>void client.exportRaw().then(r=>{if(r.ok)download('CardGrid-诊断原文.json',r.value);})}>导出原始数据</button></div>;
 if(!snapshot)return <div className="failure">正在打开本地工作台…</div>;
 const data=client.readCompatibilityView(snapshot),p=data.config.preferences,readOnly=snapshot.mode==='legacy-readonly';
 const oldSave=async()=>{setMessage('此旧版编辑入口只读，请使用新版命令入口。');return false;};
 return <div className={`app ${p.theme} ${p.density}`}><aside className="sidebar"><div className="brand"><span className="brandmark">▦</span><div>CardGrid<small>卡格工作台</small></div></div><div className="navcaption">我的空间</div><nav>{([['agenda','Today','▦'],['inbox','Inbox','＋'],['schedule','Schedule','◫'],['definitions','行动定义','❖'],['hand','抽卡手牌','✦'],['config','配置工坊','◇'],['data','数据与备份','↗']] as const).map(([id,label,icon])=><button key={id} aria-current={tab===id?'page':undefined} className={tab===id?'active':''} onClick={()=>navigation(id)}><span>{icon}</span>{label}</button>)}</nav><div className="sidebar-bottom"><span className="dot"/>数据保存在本机<div className="version">行动底座 · 2A</div></div></aside><main>
 <header><div className="breadcrumbs">工作台 / <strong>{TAB_META[tab].en}</strong> {TAB_META[tab].zh}</div><button onClick={()=>{if(dirty&&!confirm('重新载入将放弃配置草稿，继续？'))return;void reload();}}>重新载入</button></header>
 {message&&<div className="message" role="status"><span>{message}</span><button aria-label="关闭提示" onClick={()=>setMessage('')}>×</button>{retry.current&&<button disabled={busy} onClick={()=>void submit(retry.current!)}>重试本次保存</button>}</div>}
 {readOnly&&<section className="message"><strong>旧工作区只读</strong><span>原文已保留。查看、备份、恢复与清空可用；请在“数据与备份”审阅后显式升级。</span></section>}
 <section className="heading page-heading" aria-label="当前页面">
  <div className="eyebrow">{TAB_META[tab].en}</div>
  <h1>{TAB_META[tab].zh}</h1>
  <p>{TAB_META[tab].desc}</p>
 </section>
 {(tab==='definitions'||tab==='hand')&&(tab==='definitions'?<ActionLibrary key={snapshot.token.epoch} client={client}/>:<ActionHand key={snapshot.token.epoch} client={client}/>)}
 {(tab==='agenda'||tab==='schedule')&&<><section className="panel"><div className="toolbar"><button aria-label="查看前一天" onClick={()=>stepDate(-1)}>前一天</button><strong>{date}</strong><button aria-label="查看后一天" onClick={()=>stepDate(1)}>后一天</button><label>显示时区<input aria-label="显示时区" value={zone} onChange={e=>{client.invalidateCapabilities();setZone(e.target.value);}}/></label><label>准备日型<select value={templateId} onChange={e=>setTemplateId(e.target.value)}><option value="">按适用星期选择</option>{snapshot.data?.planner.templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label><button disabled={busy||readOnly} onClick={()=>void command('PrepareDay',{date,zone,templateId:templateId||null})}>准备这一天</button></div><p className="muted">打开和切换日期不会生成安排。此处展示完整时间记录；排期、改期和实际确认请到“抽卡手牌 → 当日”。</p></section>
 {day&&<section className="panel"><h2>完整时间记录</h2>{!day.occupancyKnown&&<p role="alert">有尚未解释的占用时间，当前不提供空闲时段。</p>}{day.segments.length?day.segments.map(segment=><p key={segment.id}><strong>{segment.title}</strong> · {segment.label} {segment.offsetLabel} {segment.continuesBefore?'开始于 '+segment.startDate:''} {segment.continuesAfter?'续次日 →':''}</p>):<p>没有已保存的时间记录。</p>}{day.legacyItems.map((item,i)=><p key={item.source.path+i}>旧版只读 · {item.title} · {item.range?item.range.startAt+' — '+item.range.endAt:item.occupancy==='unknown'?'占用时间尚未解释，不作为空闲':'原文保留'}</p>)}</section>}
 <fieldset disabled style={{border:0,padding:0,minWidth:0}} aria-label="旧版页面只读" key={snapshot.token.epoch+tab}>{tab==='agenda'?<Today data={data} date={date} onSave={oldSave} onDateChange={stepDate}/>:<ScheduleView data={data} date={date} onSave={oldSave} onDateChange={stepDate}/>}</fieldset></>}
 {(tab==='agenda'||tab==='inbox')&&!readOnly&&<section className="panel"><h2>记录到收件箱</h2><div className="captureline"><input aria-label="记录到收件箱" disabled={busy} value={capture} onChange={e=>setCapture(e.target.value)} placeholder="先记下来，稍后整理"/><button disabled={busy||!capture.trim()} onClick={()=>void command('CreateCapture',{text:capture,source:'quick_capture'})}>保存记录</button></div></section>}
 {tab==='inbox'&&<><p className="message">旧版整理操作只读；新版行动转换将在后续阶段接入。</p><fieldset disabled style={{border:0,padding:0,minWidth:0}} aria-label="旧版收件箱只读" key={snapshot.token.epoch}><InboxView data={data} onSave={oldSave}/></fieldset></>}
 {tab==='config'&&<>{readOnly?<p>旧配置只读，请先导出并升级。</p>:draft&&<>
 <div className="segmented"><button aria-pressed={editor==='form'} onClick={()=>{try{const parsed=JSON.parse(json);validateDefinitionConfig(parsed);setDraft(parsed);setEditor('form');}catch(error){setMessage((error as Error).message);}}}>界面配置</button><button aria-pressed={editor==='json'} onClick={()=>setEditor('json')}>文字配置 JSON</button></div>
 {editor==='form'?<section className="panel"><h2>工作台偏好</h2><div className="formgrid"><label>主题<select value={draft.config.settings.preferences.theme} onChange={e=>changeSettings({...draft.config.settings,preferences:{...draft.config.settings.preferences,theme:e.target.value as 'paper'|'night'}})}><option value="paper">纸白与松绿</option><option value="night">夜间</option></select></label><label>显示密度<select value={draft.config.settings.preferences.density} onChange={e=>changeSettings({...draft.config.settings,preferences:{...draft.config.settings.preferences,density:e.target.value as 'comfortable'|'compact'}})}><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label><label>记录时区<input aria-label="记录时区" value={draft.config.settings.zone??''} placeholder="例如 Asia/Shanghai" onChange={e=>changeSettings({...draft.config.settings,zone:e.target.value||null})}/></label>{(['startHour','endHour','defaultMinutes'] as const).map((key,i)=><label key={key}>{['开始小时','结束小时','短任务指导分钟'][i]}<input type="number" value={draft.config.settings.preferences[key]} onChange={e=>changeSettings({...draft.config.settings,preferences:{...draft.config.settings.preferences,[key]:Number(e.target.value)}})}/></label>)}</div><button className="primary" disabled={busy} onClick={()=>void saveSettings()}>保存偏好</button><p>定义 {draft.config.definitions.length} · 模板 {draft.config.templates.length} · 例行 {draft.config.rules.length}</p><p className="muted">行动定义可在“行动定义”页面编辑；此处高级 JSON 使用同一套校验规则。</p></section>:<section className="panel"><h2>完整定义配置</h2><textarea className="json" aria-label="JSON配置" value={json} onChange={e=>setJson(e.target.value)}/><button className="primary" disabled={busy} onClick={()=>{void previewFile(json);setTab('data');}}>预览配置导入</button></section>}</>}
 </>}
 {tab==='data'&&<>
 <div className="datagrid"><section className="panel"><h2>完整备份</h2><button onClick={()=>void prepareBackup()}>下载完整备份</button><p>应用生成文件后，需要你确认已保存。</p>{backup&&<label className="checkbox"><input type="checkbox" checked={saved} onChange={e=>setSaved(e.target.checked)}/>我已保存这份完整备份</label>}</section>
 <section className="panel"><h2>配置与恢复</h2><button onClick={()=>file.current?.click()}>导入文件</button><button disabled={readOnly} onClick={()=>void client.exportDefinitions().then(r=>{if(r.ok)download('CardGrid-配置.json',r.value);else setMessage(r.message);})}>导出配置</button><label>配置导入方式<select value={merge} onChange={e=>{setMerge(e.target.value as 'merge'|'replace');setPending(null);}}><option value="merge">合并</option><option value="replace">替换目录（保留历史身份）</option></select></label>{fileText&&<button onClick={()=>void previewFile(fileText)}>重新预览文件</button>}</section>
 <section className="panel"><h2>本机恢复点</h2>{recovery.length?recovery.map((point,i)=><button key={i} onClick={()=>void client.exportRecovery(point.key).then(r=>{if(r.ok)download('CardGrid-恢复点-'+String(point.key)+'.json',r.value);else setMessage(r.message);})}>导出 {String(point.key)} 原文</button>):<p>尚无恢复点。</p>}<p>清空或恢复会移除全部本机恢复点。</p></section></div>
 {readOnly&&<section className="panel"><h2>显式升级旧工作区</h2><label>旧记录原时区<input aria-label="旧记录原时区" value={zone} onChange={e=>{setZone(e.target.value);setPending(null);}}/></label><p>请确认原时区。迁移报告会列出保持只读和必须处理的来源。</p><label>起止偏移选择（来源路径对应 start/end，例如 -04:00）<textarea aria-label="迁移偏移选择" value={offsets} onChange={e=>{setOffsets(e.target.value);setPending(null);}}/></label><button onClick={()=>void migration()}>预览升级</button></section>}
 {pending&&<section className="panel"><h2>{pending.type==='CommitMigration'?'迁移预览':pending.type==='RestoreWorkspace'?'恢复预览':'配置导入预览'}</h2>{pending.type==='CommitMigration'?<><p>新增定义 {(pending.details as MigrationPreview).targetSummary.definitions} · 行动 {(pending.details as MigrationPreview).targetSummary.instances} · 计划 {(pending.details as MigrationPreview).targetSummary.plans}。旧完成记录不会生成新事实。</p>{(pending.details as MigrationPreview).issues.map((issue,i)=><p key={i} role={issue.blocking?'alert':undefined}>{issue.blocking?'需处理：':'保留说明：'}{issue.message}</p>)}</>:<p>{pending.type==='RestoreWorkspace'?'恢复会用备份完整替换当前工作区；保留文件中的记录顺序与字段。':'仅更新定义目录与偏好；既有行动、事实和批注保持。请展开详情检查前后差异。'}</p>}<details><summary>查看来源与前后差异</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:420,overflow:'auto'}}>{JSON.stringify(pending.details,null,2)}</pre></details>{pending.type==='CommitMigration'&&(pending.details as MigrationPreview).issues.filter(i=>i.code==='MULTIPLE_BLOCKS').map(issue=><label className="checkbox" key={issue.source.path}><input type="checkbox" checked={readonlyPaths.includes(issue.source.path)} onChange={e=>{setReadonlyPaths(e.target.checked?[...readonlyPaths,issue.source.path]:readonlyPaths.filter(p=>p!==issue.source.path));setPending(null);}}/>保留只读：{issue.source.path}</label>)}{pending.blocked&&<p role="alert">请解决报告中的阻断项后重新预览。</p>}<button onClick={()=>{client.invalidateCapabilities();setPending(null);}}>取消预览</button></section>}
 <section className="panel dangerpanel"><h2>清空或执行预览</h2>{!pending&&<label>清空当前工作区请输入“清空”<input aria-label="清空确认文字" value={resetText} onChange={e=>setResetText(e.target.value)}/></label>}<label className="checkbox"><input type="checkbox" checked={discard} onChange={e=>setDiscard(e.target.checked)}/>确认放弃未提交草稿并执行以上操作</label><button className="danger" disabled={busy||!backup||!saved||!discard||pending?.blocked||(!pending&&resetText!=='清空')} onClick={()=>void execute()}>{pending?'执行已预览操作':'清空工作台'}</button></section></>}
 <input ref={file} aria-label="导入文件选择" type="file" accept=".json,application/json" hidden onChange={e=>{const selected=e.target.files?.[0];if(selected){if(selected.size>5*1024*1024)setMessage('文件超过 5 MiB');else void selected.text().then(previewFile);}e.target.value='';}}/>
 <footer><span>CardGrid · 卡格工作台</span><span>所有改动保存在此浏览器 · 建议定期导出备份</span></footer></main></div>;
}
function InboxView({data,onSave}:{data:Data;onSave:(data:Data,message:string)=>Promise<boolean>}){const [selected,setSelected]=useState<string|null>(null);const [title,setTitle]=useState('');const [busy,setBusy]=useState(false);const lock=useRef(false);const [error,setError]=useState('');const items=data.planner.captures.filter(x=>x.status==='unprocessed');const active=items.find(x=>x.id===selected);async function run(mut:(p:Planner)=>void,msg:string){if(lock.current)return;lock.current=true;setBusy(true);setError('');try{const next=structuredClone(data);mut(next.planner);const ok=await onSave(next,msg);if(ok)setSelected(null)}catch(e){setError((e as Error).message)}finally{lock.current=false;setBusy(false)}}return <>{error&&<p role="alert">{error}</p>}<section className="inbox-layout"><section className="panel"><h2>未处理记录</h2>{items.length?items.map(x=><button className="inbox-row" disabled={busy} key={x.id} onClick={()=>{setSelected(x.id);setTitle(x.text)}}><span>{x.text}</span><small>{new Date(x.at).toLocaleString('zh-CN')}</small></button>):<p className="emptyline">Inbox 已清空。想到事情时，可以随时快速记录。</p>}</section>{active&&<section className="panel"><h2>整理这条记录</h2><p className="muted">原文：{active.text}</p><label>Card 标题<input value={title} disabled={busy} onChange={e=>setTitle(e.target.value)}/></label><div className="toolbar inbox-actions"><button disabled={busy} onClick={()=>run(p=>discardCapture(p,active.id),'已丢弃 Inbox 记录')}>丢弃</button><button className="quiet" disabled={busy} onClick={()=>run(p=>archiveCapture(p,active.id),'已归档 Inbox 记录')}>归档</button><button className="primary" disabled={busy||!title.trim()} onClick={()=>run(p=>resolveCapture(p,active.id,title.trim(),''),'已转为 Card')}>转为 Card</button></div></section>}</section></>}
function CardEditor({card:c,index,config,change,remove}:{card:Card;index:number;config:Config;change:(c:Card)=>void;remove:()=>void}){return <details className="definition" open><summary><span>{String(index+1).padStart(2,'0')}</span> {c.title} <small>{c.minutes}m</small></summary><div className="formgrid"><label>卡片名称<input value={c.title} onChange={e=>change({...c,title:e.target.value})}/></label><label>类型<select value={c.kind} onChange={e=>change({...c,kind:e.target.value as Card['kind'],parentId:null})}><option value="habit">每日习惯</option><option value="temporary">临时事项</option><option value="increment">关联增量卡</option></select></label><label>卡面分钟<input type="number" min={1} max={1440} value={c.minutes} onChange={e=>change({...c,minutes:Number(e.target.value)})}/></label><label>分类<select value={c.categoryId||''} onChange={e=>change({...c,categoryId:e.target.value||null})}><option value="">不分类</option>{config.categories.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>{c.kind==='increment'&&<label>关联原卡<select value={c.parentId||''} onChange={e=>change({...c,parentId:e.target.value||null})}><option value="">请选择</option>{config.cards.filter(x=>x.id!==c.id).map(x=><option key={x.id} value={x.id}>{x.title}</option>)}</select></label>}</div><label>完成标准<textarea value={c.steps} rows={2} onChange={e=>change({...c,steps:e.target.value})}/></label><div className="sectiontitle"><label className="checkbox"><input type="checkbox" checked={c.enabled} onChange={e=>change({...c,enabled:e.target.checked})}/>启用定义</label><button className="quiet" onClick={remove}>移除此定义</button></div></details>}
function ScheduleEditor({schedule:s,cards,change,remove}:{schedule:Schedule;cards:Card[];change:(s:Schedule)=>void;remove:()=>void}){return <div className="definition"><label>模板名称<input value={s.name} onChange={e=>change({...s,name:e.target.value})}/></label>{s.entries.map((e,i)=><div className="entry" key={i}><label>卡片<select value={e.cardId} onChange={v=>change({...s,entries:s.entries.map((x,j)=>j===i?{...x,cardId:v.target.value}:x)})}>{cards.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select></label><label>开始时间<input type="time" value={e.start} onChange={v=>change({...s,entries:s.entries.map((x,j)=>j===i?{...x,start:v.target.value}:x)})}/></label><label>计划分钟<input type="number" value={e.minutes} onChange={v=>change({...s,entries:s.entries.map((x,j)=>j===i?{...x,minutes:Number(v.target.value)}:x)})}/></label><button onClick={()=>change({...s,entries:s.entries.filter((_,j)=>i!==j)})}>移除</button></div>)}<div className="toolbar"><button disabled={!cards.length} onClick={()=>change({...s,entries:[...s.entries,{cardId:cards[0].id,start:'09:00',minutes:cards[0].minutes}]})}>＋ 添加时段</button><button className="quiet" onClick={remove}>移除模板</button></div>{s.source&&<small>来源：{s.source.workbook} / {s.source.sheet} / {s.source.range}（可在JSON中编辑）</small>}</div>}
createRoot(document.getElementById('root')!).render(<App/>);
if('serviceWorker' in navigator&&!import.meta.url.includes('/src/')){window.addEventListener('load',()=>{navigator.serviceWorker.register(import.meta.env.BASE_URL+'sw.js').catch(()=>{})})}
