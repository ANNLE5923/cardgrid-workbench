import React,{useRef,useState} from 'react';
import type {Data} from './domain';
import {cancelBlock,putBlock,replaceTemplate,saveTemplate,moveBlock,localDate,clock,minutes,type Block,type Planner,type Template} from './planner';

type Props={data:Data;date:string;onSave:(data:Data,message:string)=>Promise<boolean>;onDateChange:(delta:number)=>void};
const clone=<T,>(v:T):T=>structuredClone(v);
const names=['周日','周一','周二','周三','周四','周五','周六'];
const newBlock=():Block=>({id:crypto.randomUUID(),title:'新安排',start:540,end:570,kind:'flexible',task:'',cancelled:false});
type DraftBlock=Omit<Block,'start'|'end'>&{start:string;end:string};
const draftBlock=(b:Block):DraftBlock=>({...b,start:clock(b.start),end:clock(b.end)});
const savedBlock=(b:DraftBlock):Block=>({...b,start:minutes(b.start),end:minutes(b.end)});
function BlockFields({value:b,change,disabled}:{value:DraftBlock;change:(b:DraftBlock)=>void;disabled:boolean}){
 return <div className="formgrid"><label>安排名称<input value={b.title} disabled={disabled} onChange={e=>change({...b,title:e.target.value})}/></label><label>开始时间<input placeholder="09:00" value={b.start} disabled={disabled} onChange={e=>change({...b,start:e.target.value})}/></label><label>结束时间（可填 24:00）<input placeholder="09:30" value={b.end} disabled={disabled} onChange={e=>change({...b,end:e.target.value})}/></label><label>安排类型<select value={b.kind} disabled={disabled} onChange={e=>change({...b,kind:e.target.value as Block['kind']})}><option value="fixed">Fixed 固定</option><option value="flexible">Flexible 弹性</option></select></label></div>;
}
export function ScheduleView({data,date,onSave,onDateChange}:Props){
 const planner=data.planner;const day=planner.days.find(d=>d.date===date);const past=date<localDate();
 const [selected,setSelected]=useState(planner.templates[0]?.id||'');
 const [draft,setDraft]=useState<{date:string;block:DraftBlock}|null>(null);
 const [template,setTemplate]=useState<(Omit<Template,'blocks'>&{blocks:DraftBlock[]})|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');const lock=useRef(false);
 const blocks=(day?.blocks||[]).filter(b=>!b.cancelled).sort((a,b)=>a.start-b.start);
 async function save(mut:(p:Planner)=>void,msg:string):Promise<boolean>{
  if(lock.current)return false;lock.current=true;setBusy(true);setError('');
  try{const next=clone(data);mut(next.planner);const ok=await onSave(next,msg);if(!ok)setError('保存失败，草稿已保留。重新载入最新数据后可重试。');return ok}
  catch(e){setError((e as Error).message);return false}finally{lock.current=false;setBusy(false)}
 }
 function editTemplate(t:Template){setTemplate({...clone(t),blocks:t.blocks.map(draftBlock)})}
 async function saveDay(){if(draft&&await save(p=>putBlock(p,draft.date,savedBlock(draft.block)),'已保存当天安排'))setDraft(null)}
 async function saveDayType(){if(template&&await save(p=>saveTemplate(p,{...template,blocks:template.blocks.map(savedBlock)}),'已保存日型模板')){setSelected(template.id);setTemplate(null)}}
 const hasDraft=!!draft||!!template;
 return <><section className="heading"><div className="eyebrow">SCHEDULE · P1A</div><h1>安排今天，也保护模板。</h1><p>当天例外独立保存；过去日期只读。</p><div className="datecontrols"><button disabled={busy||hasDraft} aria-label="前一天" onClick={()=>onDateChange(-1)}>‹</button><span>{date} · {names[new Date(date+'T12:00:00').getDay()]}</span><button disabled={busy||hasDraft} aria-label="后一天" onClick={()=>onDateChange(1)}>›</button></div></section>{error&&<p className="message" role="alert">{error}</p>}
 <div className="schedule-grid"><section className="panel"><h2>当天安排</h2>{past&&<p>历史安排不可修改。</p>}<button disabled={busy||past||hasDraft} onClick={()=>setDraft({date,block:draftBlock(newBlock())})}>＋ 添加当天安排</button>
 {blocks.map(b=><div className={`planner-block ${b.kind}`} key={b.id} draggable={!past&&!busy&&!hasDraft&&b.kind==='flexible'} onDragStart={e=>e.dataTransfer.setData('text/plain',b.id)}><strong>{b.kind==='fixed'?'固定':'弹性 · 可拖动'}</strong><span>{b.title} · {clock(b.start)}–{clock(b.end)}</span><button disabled={busy||past||hasDraft} onClick={()=>setDraft({date,block:draftBlock(b)})}>编辑</button><button disabled={busy||past||hasDraft} onClick={()=>void save(p=>cancelBlock(p,date,b.id),'已取消当天安排')}>取消当天</button></div>)}
 {!blocks.length&&<p className="emptyline">还没有当天安排，可以添加或应用日型。</p>}
 {!past&&<details><summary>拖动弹性安排到新时间（保留时长）</summary><div className="drop-times">{Array.from({length:48},(_,i)=>i*30).map(start=><div key={start} className="drop-time" onDragOver={e=>{if(!busy&&!hasDraft)e.preventDefault()}} onDrop={e=>{e.preventDefault();if(busy||hasDraft)return;const id=e.dataTransfer.getData('text/plain');void save(p=>moveBlock(p,date,id,start),'已移动弹性安排')}}>{clock(start)}</div>)}</div></details>}
 <div className="toolbar"><select aria-label="选择日型" value={selected} disabled={busy||hasDraft} onChange={e=>setSelected(e.target.value)}><option value="">选择日型</option>{planner.templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select><button disabled={busy||past||!selected||hasDraft} onClick={()=>{if(blocks.length&&!confirm('应用日型将替换当天安排，是否继续？'))return;void save(p=>replaceTemplate(p,date,selected),'已应用日型')}}>应用日型到当天</button></div>
 {draft&&<section className="definition"><h3>编辑 {draft.date} 的安排</h3><BlockFields value={draft.block} disabled={busy} change={block=>setDraft({...draft,block})}/><div className="toolbar"><button className="primary" disabled={busy} onClick={()=>void saveDay()}>保存当天安排</button><button disabled={busy} onClick={()=>setDraft(null)}>放弃草稿</button></div></section>}
 </section><section className="panel"><h2>日型模板</h2><p className="muted">适用星期不能重叠。修改只影响之后新生成或主动应用的日期；已有日期快照保持原样。</p><button disabled={busy||hasDraft} onClick={()=>editTemplate({id:crypto.randomUUID(),name:'新日型',weekdays:[],blocks:[]})}>＋ 创建日型</button>
 {planner.templates.map(t=><div className="planner-block" key={t.id}><span>{t.name} · {t.weekdays.map(d=>names[d]).join('、')||'仅手动应用'}</span><button disabled={busy||hasDraft} onClick={()=>editTemplate(t)}>编辑模板</button></div>)}
 {template&&<section className="definition"><label>日型名称<input disabled={busy} value={template.name} onChange={e=>setTemplate({...template,name:e.target.value})}/></label><fieldset disabled={busy}><legend>适用星期</legend>{names.map((name,d)=><label className="checkbox" key={d}><input type="checkbox" checked={template.weekdays.includes(d)} onChange={e=>setTemplate({...template,weekdays:e.target.checked?[...template.weekdays,d]:template.weekdays.filter(x=>x!==d)})}/>{name}</label>)}</fieldset>{template.blocks.map((b,i)=><div className="definition" key={b.id}><BlockFields value={b} disabled={busy} change={value=>setTemplate({...template,blocks:template.blocks.map((x,j)=>i===j?value:x)})}/><button disabled={busy} onClick={()=>setTemplate({...template,blocks:template.blocks.filter(x=>x.id!==b.id)})}>移除模板安排</button></div>)}<button disabled={busy} onClick={()=>setTemplate({...template,blocks:[...template.blocks,draftBlock(newBlock())]})}>＋ 添加模板安排</button><div className="toolbar"><button className="primary" disabled={busy} onClick={()=>void saveDayType()}>保存日型模板</button><button disabled={busy} onClick={()=>setTemplate(null)}>放弃模板草稿</button></div></section>}
 </section></div></>;
}
