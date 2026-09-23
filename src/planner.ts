// Current snapshots and append-only meaningful history; deliberately not event sourcing.
export type Status='inbox'|'planned'|'doing'|'done'|'skipped'|'cancelled';
export type Task={id:string;title:string;date:string;status:Status;criteria:string;minimum:boolean;goals:string[];projects:string[];source:string;occurrence:string;makeupOf:string};
export type Rule={id:string;name:string;title:string;weekdays:number[];status:'active'|'paused'|'archived';start:string;criteria:string;minimum:boolean;goals:string[];projects:string[]};
export type Occurrence={id:string;rule:string;date:string;task:string;status:'generated'|'completed'|'skipped'|'missed'|'cancelled'};
export type Block={id:string;title:string;start:number;end:number;kind:'fixed'|'flexible';task:string;cancelled:boolean};
export type Template={id:string;name:string;weekdays:number[];blocks:Block[]};
export type Day={date:string;template:string;name:string;blocks:Block[];top3:string[];minimum:boolean;overrides:{type:string;at:string;block:string}[]};
export type Capture={id:string;text:string;at:string;source:string;status:'unprocessed'|'resolved'|'archived'|'discarded';target:string};
export type History={id:string;at:string;date:string;type:string;entity:string;before:unknown;after:unknown};
export type Ref={id:string;name:string;status:'active'|'paused'|'archived'|'completed'};
export type Planner={version:1;tasks:Task[];rules:Rule[];occurrences:Occurrence[];templates:Template[];days:Day[];captures:Capture[];history:History[];refs:Ref[];goals:{id:string;name:string}[];legacyImported:boolean};
export const emptyPlanner=():Planner=>({version:1,tasks:[],rules:[],occurrences:[],templates:[],days:[],captures:[],history:[],refs:[],goals:[],legacyImported:false});
export const uid=()=>crypto.randomUUID();
export function localDate(d=new Date()){return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`}
export function validDate(s:string){return /^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s+'T12:00:00Z'))&&new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s}
export function minutes(s:string){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)&&s!=='24:00')throw Error('请输入有效时间');return Number(s.slice(0,2))*60+Number(s.slice(3))}
export function clock(n:number){return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`}
function assert(v:unknown,m:string):asserts v {if(!v)throw Error(m)}
function text(v:unknown,max=5000):asserts v is string{assert(typeof v==='string'&&v.length<=max,'文本格式不正确')}
function ident(v:unknown):asserts v is string{text(v,250);assert(/^[\w-]+$/.test(v),'标识格式不正确')}
function date(v:unknown,optional=false):asserts v is string{text(v,10);assert((optional&&v==='')||validDate(v),'日期无效')}
function bool(v:unknown){assert(typeof v==='boolean','布尔值无效')}
function enumValue(v:unknown,a:string[]){assert(a.includes(v as string),'状态无效')}
function named(x:{id:string;name:string}){ident(x.id);text(x.name,120);assert(x.name.trim(),'名称不能为空')}
function weekdays(v:unknown):asserts v is number[]{assert(Array.isArray(v)&&v.length<=7&&new Set(v).size===v.length&&v.every(n=>Number.isInteger(n)&&n>=0&&n<=6),'星期规则无效')}
function array<T extends {id:string}>(a:T[]){assert(Array.isArray(a)&&a.length<=100000,'数据集合无效或过大');a.forEach(x=>{assert(x&&typeof x==='object','对象无效');ident(x.id)});assert(new Set(a.map(x=>x.id)).size===a.length,'重复标识')}
function block(b:Block){ident(b.id);text(b.title,120);assert(b.title.trim(),'安排名称不能为空');assert(Number.isInteger(b.start)&&Number.isInteger(b.end)&&b.start>=0&&b.end<=1440&&b.start<b.end,'结束时间必须晚于开始，且在当天内');enumValue(b.kind,['fixed','flexible']);text(b.task);bool(b.cancelled)}
export function conflict(blocks:Block[],b:Block){return blocks.find(x=>x.id!==b.id&&!x.cancelled&&!b.cancelled&&x.start<b.end&&b.start<x.end)}
export function validatePlanner(value:unknown):Planner{
 const p=value as Planner;assert(p&&p.version===1,'不支持的执行数据版本');
 for(const a of [p.tasks,p.rules,p.occurrences,p.templates,p.captures,p.history,p.refs,p.goals])array(a as {id:string}[]);
 assert(Array.isArray(p.days)&&p.days.length<=100000,'日期集合无效');assert(new Set(p.days.map(d=>d.date)).size===p.days.length,'日期重复');bool(p.legacyImported);
 p.refs.forEach(r=>{named(r);enumValue(r.status,['active','paused','archived','completed'])});p.goals.forEach(named);
 assert(p.refs.filter(r=>r.status==='active').length<=3,'进行中的项目最多 3 个，请先暂停一个');
 const relations=(x:{goals:string[];projects:string[]})=>{assert(Array.isArray(x.goals)&&Array.isArray(x.projects),'关联格式无效');assert(new Set(x.goals).size===x.goals.length&&new Set(x.projects).size===x.projects.length,'关联重复');assert(x.goals.every(id=>p.goals.some(g=>g.id===id))&&x.projects.every(id=>p.refs.some(r=>r.id===id)),'关联的目标/项目不存在')};
 p.tasks.forEach(t=>{text(t.title,120);assert(t.title.trim(),'任务标题不能为空');date(t.date,true);enumValue(t.status,['inbox','planned','doing','done','skipped','cancelled']);text(t.criteria);bool(t.minimum);relations(t);text(t.source);text(t.occurrence);text(t.makeupOf);if(t.occurrence)assert(p.occurrences.some(o=>o.id===t.occurrence&&o.task===t.id),'任务例行关联无效');if(t.makeupOf)assert(p.occurrences.some(o=>o.id===t.makeupOf),'补做来源不存在')});
 p.rules.forEach(r=>{named(r);text(r.title,120);assert(r.title.trim(),'生成标题不能为空');weekdays(r.weekdays);assert(r.weekdays.length,'至少选择一天');enumValue(r.status,['active','paused','archived']);date(r.start);text(r.criteria);bool(r.minimum);relations(r)});
 p.occurrences.forEach(o=>{date(o.date);assert(p.rules.some(r=>r.id===o.rule),'例行规则不存在');assert(p.tasks.some(t=>t.id===o.task&&t.occurrence===o.id),'例行任务不存在');enumValue(o.status,['generated','completed','skipped','missed','cancelled'])});
 assert(new Set(p.occurrences.map(o=>o.rule+'|'+o.date)).size===p.occurrences.length,'同日例行实例重复');
 assert(new Set(p.tasks.filter(t=>t.makeupOf).map(t=>t.makeupOf)).size===p.tasks.filter(t=>t.makeupOf).length,'补做任务重复');
 p.templates.forEach(t=>{named(t);weekdays(t.weekdays);array(t.blocks);t.blocks.forEach(block);assert(t.blocks.every(b=>!conflict(t.blocks,b)),'模板时间存在冲突')});
 for(const d of p.days){date(d.date);text(d.template);text(d.name);bool(d.minimum);array(d.blocks);d.blocks.forEach(b=>{block(b);if(b.task)assert(p.tasks.some(t=>t.id===b.task),'日程任务不存在')});assert(Array.isArray(d.top3)&&d.top3.length<=3&&new Set(d.top3).size===d.top3.length,'重点任务最多三项且不能重复');assert(d.top3.every(id=>p.tasks.some(t=>t.id===id)),'重点任务不存在');assert(Array.isArray(d.overrides),'日期例外无效');d.overrides.forEach(o=>{text(o.type);text(o.at);text(o.block)})}
 p.captures.forEach(c=>{text(c.text);assert(c.text.trim(),'记录不能为空');assert(Number.isFinite(Date.parse(c.at)),'捕获时间无效');text(c.source);text(c.target);enumValue(c.status,['unprocessed','resolved','archived','discarded']);if(c.status==='resolved')assert(p.tasks.some(t=>t.id===c.target),'捕获转换目标不存在')});
 p.history.forEach(h=>{assert(Number.isFinite(Date.parse(h.at)),'历史时间无效');date(h.date);text(h.type);text(h.entity)});
 return structuredClone(p);
}
export function record(p:Planner,type:string,entity:string,day:string,before:unknown=null,after:unknown=null){p.history.push({id:uid(),at:new Date().toISOString(),date:day,type,entity,before:structuredClone(before),after:structuredClone(after)})}
export function newTask(title:string,day='',source='manual'):Task{return {id:uid(),title:title.trim(),date:day,status:day?'planned':'inbox',criteria:'',minimum:false,goals:[],projects:[],source,occurrence:'',makeupOf:''}}
/** Create an Inbox capture without creating a task or changing Today. */
export function createCapture(p:Planner,textValue:string,source='quick_capture',at=new Date().toISOString()):Capture{
 assert(typeof textValue==='string'&&textValue.trim().length>0&&textValue.length<=5000,'记录不能为空');
 assert(Number.isFinite(Date.parse(at)),'捕获时间无效');
 const capture:Capture={id:uid(),text:textValue.trim(),at,source,status:'unprocessed',target:''};
 p.captures.push(capture);record(p,'InboxItemCaptured',capture.id,localDate(new Date(at)),null,capture);return capture;
}
export function archiveCapture(p:Planner,id:string,today=localDate()){
 const c=p.captures.find(x=>x.id===id);assert(c,'原始捕获不存在');if(c.status==='archived')return c;assert(c.status==='unprocessed'||c.status==='discarded','已转为 Card 的记录不能归档');const before=structuredClone(c);c.status='archived';record(p,'InboxItemArchived',id,today,before,c);return c;
}
export function discardCapture(p:Planner,id:string,today=localDate()){
 const c=p.captures.find(x=>x.id===id);assert(c,'原始捕获不存在');if(c.status==='discarded')return c;assert(c.status==='unprocessed','已转为 Card 的记录不能丢弃');const before=structuredClone(c);c.status='discarded';record(p,'InboxItemDiscarded',id,today,before,c);return c;
}
export function ensureDay(p:Planner,day:string):Day{
 assert(validDate(day),'日期无效');let d=p.days.find(d=>d.date===day);if(d)return d;
 const matches=p.templates.filter(t=>t.weekdays.includes(new Date(day+'T12:00:00').getDay()));assert(matches.length<=1,'当天匹配多个日型，请调整适用星期或明确选择日型');
 const t=matches[0];d={date:day,template:t?.id||'',name:t?.name||'未选择日型',blocks:t?structuredClone(t.blocks):[],top3:[],minimum:false,overrides:[]};p.days.push(d);record(p,'DayPrepared',day,day,null,d);return d;
}
export function bootstrap(input:Planner,today=localDate()):Planner{
 const p=structuredClone(input);const before=p.history.length;ensureDay(p,today);
 for(const o of p.occurrences)if(o.date<today&&o.status==='generated'){o.status='missed';record(p,'RoutineOccurrenceMissed',o.id,today,{date:o.date},null)}
 for(const r of p.rules){if(r.status!=='active'||r.start>today||!r.weekdays.includes(new Date(today+'T12:00:00').getDay())||p.occurrences.some(o=>o.rule===r.id&&o.date===today))continue;
 const occurrence=uid(),task=newTask(r.title,today,'routine');Object.assign(task,{criteria:r.criteria,minimum:r.minimum,goals:[...r.goals],projects:[...r.projects],occurrence});p.tasks.push(task);p.occurrences.push({id:occurrence,rule:r.id,date:today,task:task.id,status:'generated'});record(p,'RoutineOccurrenceGenerated',occurrence,today,null,task);
 }if(p.history.length!==before)record(p,'BootstrapCompleted',today,today);return validatePlanner(p);
}
export function changeStatus(p:Planner,id:string,status:Status,today=localDate()){
 const t=p.tasks.find(t=>t.id===id);assert(t,'任务不存在');if(t.status===status)return;
 const o=p.occurrences.find(o=>o.id===t.occurrence);if(o&&o.date<today)throw Error('过去的例行请使用补做，不能改写原日期状态');
 const before=structuredClone(t);t.status=status;
 if(o)o.status=status==='done'?'completed':status==='skipped'?'skipped':status==='cancelled'?'cancelled':'generated';
 const type=status==='done'?'CardCompleted':before.status==='done'?'CardReopened':status==='skipped'?'CardSkipped':status==='cancelled'?'CardCancelled':status==='doing'?'CardStarted':'CardUpdated';record(p,type,id,today,before,t);
}
export function reschedule(p:Planner,id:string,to:string,today=localDate()){
 const t=p.tasks.find(t=>t.id===id);assert(t,'任务不存在');assert(!t.occurrence,'例行日期不能改写，请跳过或补做');date(to,true);const before=structuredClone(t);t.date=to;if(t.status==='inbox'&&to)t.status='planned';record(p,'CardRescheduled',id,today,before,t);
}
export function makeup(p:Planner,id:string,today=localDate()){
 const o=p.occurrences.find(o=>o.id===id);assert(o&&o.date<today&&['missed','skipped'].includes(o.status),'仅过去错过或跳过的事项可补做');const existing=p.tasks.find(t=>t.makeupOf===id);if(existing)return existing;
 const original=p.tasks.find(t=>t.id===o.task)!;const t={...structuredClone(original),id:uid(),date:today,title:`补做 · ${o.date} ${original.title}`.slice(0,120),status:'planned' as const,source:'makeup',occurrence:'',makeupOf:id};p.tasks.push(t);record(p,'RoutineOccurrenceMakeupCreated',id,today,null,t);return t;
}
export function resolveCapture(p:Planner,id:string,title:string,day:string,today=localDate()){
 const c=p.captures.find(c=>c.id===id);assert(c,'原始捕获不存在');if(c.status==='resolved')return p.tasks.find(t=>t.id===c.target)!;assert(c.status==='unprocessed','请先恢复未处理状态');const t=newTask(title,day,c.id);p.tasks.push(t);c.status='resolved';c.target=t.id;record(p,'InboxItemResolved',id,today,null,t);return t;
}
export function putBlock(p:Planner,day:string,b:Block,today=localDate()){
 block(b);assert(day>=today,'过去日期的安排不可修改');const d=ensureDay(p,day),hit=conflict(d.blocks,b);if(hit)throw Error(`与${hit.kind==='fixed'?'固定':'弹性'}安排「${hit.title}」${clock(hit.start)}–${clock(hit.end)}冲突。可改到 ${clock(hit.end)} 后。`);
 const old=d.blocks.find(x=>x.id===b.id),before=old?structuredClone(old):null;if(old)Object.assign(old,b);else d.blocks.push(structuredClone(b));d.overrides.push({type:old?'modify_block':'add_block',at:new Date().toISOString(),block:b.id});record(p,old?'TimeBlockMoved':'TimeBlockCreated',b.id,today,before,{day,block:b});
}
export function cancelBlock(p:Planner,day:string,id:string,today=localDate()){
 assert(day>=today,'过去日期的安排不可修改');const d=ensureDay(p,day),b=d.blocks.find(b=>b.id===id);assert(b,'时间块不存在');const before=structuredClone(b);b.cancelled=true;d.overrides.push({type:'cancel_block',at:new Date().toISOString(),block:id});record(p,'TimeBlockCancelled',id,today,before,b);
}
export function replaceTemplate(p:Planner,day:string,id:string,today=localDate()){
 assert(day>=today,'过去日期的安排不可修改');const t=p.templates.find(t=>t.id===id);assert(t,'日型不存在');let d=p.days.find(d=>d.date===day);if(!d){d={date:day,name:'未选择日型',template:'',blocks:[],top3:[],minimum:false,overrides:[]};p.days.push(d)}const before=structuredClone(d);d.template=id;d.name=t.name;d.blocks=structuredClone(t.blocks);d.overrides.push({type:'replace_template',at:new Date().toISOString(),block:''});record(p,'ScheduleOverrideCreated',day,today,before,d);
}
export function setTodayMode(p:Planner,day:string,minimum:boolean,today=localDate()){
 assert(day>=today,'过去日期不可修改');const d=ensureDay(p,day);const before=d.minimum;if(before===minimum)return d;d.minimum=minimum;record(p,'TodayModeChanged',day,today,before,minimum);return d;
}
export function updateTemplate(p:Planner,id:string,name:string,blocks:Block[],today=localDate()){
 const t=p.templates.find(t=>t.id===id);assert(t,'日型不存在');text(name,120);assert(name.trim(),'日型名称不能为空');array(blocks);blocks.forEach(block);assert(!blocks.some(b=>conflict(blocks,b)),'模板时间存在冲突');const before=structuredClone(t);t.name=name.trim();t.blocks=structuredClone(blocks);record(p,'ScheduleTemplateUpdated',id,today,before,t);return t;
}
export function top3(p:Planner,day:string,ids:string[],today=localDate()){
 assert(ids.length<=3&&new Set(ids).size===ids.length,'最多选择 3 个不同的重点任务');assert(ids.every(id=>p.tasks.some(t=>t.id===id)),'任务不存在');const d=ensureDay(p,day),before=[...d.top3];d.top3=[...ids];record(p,'Top3Changed',day,today,before,ids);
}

/** Save a whole template atomically; existing day snapshots stay unchanged. */
export function saveTemplate(p:Planner,value:Template,today=localDate()){
 named(value);weekdays(value.weekdays);array(value.blocks);value.blocks.forEach(block);
 assert(!value.blocks.some(b=>conflict(value.blocks,b)),'模板时间存在冲突');
 assert(!p.templates.some(t=>t.id!==value.id&&t.weekdays.some(d=>value.weekdays.includes(d))),'适用星期与其他日型重复，请先调整原日型');
 const old=p.templates.find(t=>t.id===value.id),before=old?structuredClone(old):null;
 const next=structuredClone(value);next.name=next.name.trim();
 if(old)Object.assign(old,next);else p.templates.push(next);
 record(p,old?'ScheduleTemplateUpdated':'ScheduleTemplateCreated',value.id,today,before,next);return next;
}
export function moveBlock(p:Planner,day:string,id:string,start:number,today=localDate()){
 const b=p.days.find(d=>d.date===day)?.blocks.find(b=>b.id===id&&!b.cancelled);
 assert(b&&b.kind==='flexible','只能拖动弹性安排');
 putBlock(p,day,{...b,start,end:start+b.end-b.start},today);
}
