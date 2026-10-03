// 2G independent acceptance: production entry, fresh browser contexts, synthetic records only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=process.env.CARDGRID_2G_OUTPUT||path.join(os.tmpdir(),'cardgrid-2g-'+Date.now());
await fs.mkdir(out,{recursive:true});
const {chromium}=await import(process.env.CARDGRID_PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({root,configFile:path.join(root,'vite.config.ts'),logLevel:'error',server:{host:'127.0.0.1',port:0}});
await server.listen();const url='http://127.0.0.1:'+server.httpServer.address().port+'/';
const browser=await chromium.launch({headless:true,...(process.env.CARDGRID_CHROME_PATH?{executablePath:process.env.CARDGRID_CHROME_PATH}:{})});
const results=[];const btn=(p,n)=>p.getByRole('button',{name:n,exact:true});
const row=(p,n)=>p.locator('.dayboard-row').filter({hasText:n});
async function state(p){return p.evaluate(async()=>{const {createWorkspaceStore}=await import('/src/workspace/store.ts');const s=createWorkspaceStore();try{return await s.read();}finally{s.close();}});}
async function check(name,fn){const context=await browser.newContext({timezoneId:'Asia/Shanghai',serviceWorkers:'block',viewport:{width:1280,height:900}});let p;
 try{p=await context.newPage();p.setDefaultTimeout(5000);await p.goto(url);await p.waitForLoadState('networkidle');const detail=await fn(p,context);results.push({name,status:'pass',detail});console.log('PASS',name);}
 catch(e){const entry={name,status:'fail',error:e.stack};if(p){entry.state=await state(p).catch(()=>null);entry.ui=await p.locator('body').innerText().catch(()=>null);await p.screenshot({path:path.join(out,name+'.png'),fullPage:true}).catch(()=>{});}results.push(entry);console.log('FAIL',name,e.message.split('\n')[0]);}
 finally{await context.close();}}
async function seed(p,kind='hand'){
 await p.evaluate(async kind=>{const fx=await import('/tests/fixtures/action/independent.ts');const {createWorkspaceStore}=await import('/src/workspace/store.ts');const {createWorkspaceClient}=await import('/src/workspace/client.ts');const s=createWorkspaceStore();
 let d=kind==='planned'||kind==='planned-fixed'?fx.planned():fx.hand();if(kind==='planned-fixed')d.planner.fixed=fx.fixed().planner.fixed;
 if(kind==='no-duration'){d.planner.instances[0].currentContent=fx.content(null);d.planner.instances[0].creationSnapshot=fx.content(null);}
 await s.atomic(()=>({write:fx.envelope(d),result:null}));
 if(kind==='fixed'){const c=createWorkspaceClient({store:s,now:()=>fx.AT});const submit=async(type,payload,id)=>{const load=await c.load();const r=await c.submit({commandId:id,expected:load.value.token,type,payload});if(!r.ok)throw Error(JSON.stringify(r));};
 const template={id:'monday',version:1,name:'合成固定模板',weekdays:[1],source:{kind:'manual'},entries:[{id:'x',title:'固定甲',start:'09:15',elapsedMinutes:30,definitionId:null},{id:'y',title:'固定乙',start:'10:00',elapsedMinutes:30,definitionId:null}]};
 await submit('SaveTemplate',{template,expectedVersion:null},'seed-template');await submit('PrepareDay',{date:'2026-09-28',zone:'Asia/Shanghai',templateId:'monday'},'seed-day');c.close();}else s.close();
 },kind);
 await p.reload({waitUntil:'networkidle'});await p.locator('nav').getByText('抽卡手牌').click();await p.getByRole('tab',{name:'当日',exact:true}).click();await p.getByLabel('日期',{exact:true}).fill('2026-09-28');
 await p.getByLabel('时区',{exact:true}).fill('Asia/Shanghai');await p.locator('.dayboard-row').first().waitFor();
}
async function actual(p){await row(p,'独立合成行动').getByRole('button',{name:'确认实际',exact:true}).click();const dlg=p.getByRole('dialog',{name:'确认实际发生'});await dlg.waitFor();await dlg.locator('.flow-actualrange').waitFor();return dlg;}
try {
 await check('2H-F07-manual-choice-creates-only-hand',async p=>{
  await p.locator('nav').getByText('行动定义').click();await btn(p,'＋ 新建定义').click();await p.getByLabel('定义名称',{exact:true}).fill('独立手选');await p.getByLabel('完成标准',{exact:true}).fill('可核对');await btn(p,'保存定义').click();await p.getByText('已保存到本机',{exact:true}).waitFor();
  await btn(p,'加入手牌（手选）').click();await p.waitForFunction(async()=>{const {createWorkspaceStore}=await import('/src/workspace/store.ts');const s=createWorkspaceStore();try{return (await s.read()).data.planner.instances.length===1;}finally{s.close();}});
  const d=(await state(p)).data;assert.equal(d.planner.handOrder.length,1);assert.equal(d.planner.plans.length,0);assert.equal(d.planner.facts.length,0);assert.equal(d.planner.instances[0].currentContent.title,'独立手选');return{handOnly:true};
 });
 await check('2H-F03-no-duration-actual-commits',async p=>{await seed(p,'no-duration');await row(p,'独立合成行动').getByRole('button',{name:'记录实际'}).click();const dlg=p.getByRole('dialog');await dlg.locator('.flow-actualrange').waitFor();await dlg.getByLabel('开始时间',{exact:true}).fill('09:02');await dlg.getByLabel('结束时间',{exact:true}).fill('09:19');await btn(dlg,'确认实际').click();await dlg.waitFor({state:'hidden'});const d=(await state(p)).data;assert.equal(d.planner.plans.length,0);assert.equal(d.planner.facts.length,1);assert.equal(d.planner.facts[0].actualRange.localEnd,'2026-09-28T09:19');return{noFakePlan:true};});
 await check('2H-fixed-storage-failure-retry',async p=>{
  await seed(p,'fixed');await p.getByLabel('默认落点').fill('11:00');await row(p,'固定甲').getByRole('button',{name:'解锁并调整'}).click();const dlg=p.getByRole('dialog');await dlg.locator('.flow-candidate.valid').waitFor();const before=await state(p);
  await p.evaluate(()=>{const orig=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(names,mode,...rest){if(mode==='readwrite'){IDBDatabase.prototype.transaction=orig;throw new DOMException('2H synthetic failure','QuotaExceededError');}return orig.call(this,names,mode,...rest);};});
  await btn(dlg,'确认排期').click();await dlg.getByRole('alert').waitFor();assert.deepEqual(await state(p),before);await btn(dlg,'确认排期').click();await dlg.waitFor({state:'hidden'});assert.equal((await state(p)).data.planner.fixed.find(f=>f.title==='固定甲').range.localStart,'2026-09-28T11:00');return{retrySucceeded:true};
 });
 await check('2H-DST-both-endpoints-commit',async p=>{await seed(p,'no-duration');await p.getByLabel('时区',{exact:true}).fill('America/New_York');await row(p,'独立合成行动').getByRole('button',{name:'记录实际'}).click();const dlg=p.getByRole('dialog');await dlg.locator('.flow-actualrange').waitFor();await dlg.getByLabel('开始日期',{exact:true}).fill('2026-11-01');await dlg.getByLabel('结束日期',{exact:true}).fill('2026-11-01');await dlg.getByLabel('开始时间',{exact:true}).fill('01:15');await dlg.getByLabel('结束时间',{exact:true}).fill('01:45');await btn(dlg,'确认实际').click();await dlg.getByLabel('开始时区偏移',{exact:true}).selectOption('-04:00');await dlg.getByLabel('结束时区偏移',{exact:true}).selectOption('-05:00');await btn(dlg,'确认实际').click();await dlg.waitFor({state:'hidden'});const f=(await state(p)).data.planner.facts[0];assert.equal(f.actualRange.startAt,'2026-11-01T05:15:00Z');assert.equal(f.actualRange.endAt,'2026-11-01T06:45:00Z');return{elapsedMinutes:90};});
 await check('2H-DST-future-warning-uses-chosen-offset',async p=>{const detail=await p.evaluate(async()=>{const {localMinuteIsFuture,resolveLocal,compareInstants}=await import('/src/daily/schedule/time.ts');const input={date:'2026-11-01',time:'01:30',zone:'America/New_York',offset:'-05:00'},at='2026-11-01T05:50:00Z';const r=resolveLocal(input);return{input,at,instant:r.instant,actualFuture:compareInstants(r.instant,at)>0,warning:localMinuteIsFuture(input,at)};});assert.equal(detail.actualFuture,true);assert.equal(detail.warning,true,'future-end warning must agree with selected DST offset');return detail;});
} finally {await browser.close();await server.close();await fs.writeFile(path.join(out,'results.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));console.log('Evidence:',out);}
console.log('2H independent supplement:',results.filter(r=>r.status==='pass').length+'/'+results.length);if(results.some(r=>r.status==='fail'))process.exitCode=1;
