// 2G independent acceptance: production entry, fresh browser contexts, synthetic records only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=process.env.CARDGRID_2G_OUTPUT||path.join(os.tmpdir(),'cardgrid-2g-annotation-'+Date.now());
await fs.mkdir(out,{recursive:true});
const {chromium}=await import(process.env.CARDGRID_PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({root,configFile:path.join(root,'vite.config.ts'),logLevel:'error',server:{host:'127.0.0.1',port:0}});
await server.listen();const url='http://127.0.0.1:'+server.httpServer.address().port+'/';
const browser=await chromium.launch({headless:true,...(process.env.CARDGRID_CHROME_PATH?{executablePath:process.env.CARDGRID_CHROME_PATH}:{})});
const results=[];const btn=(p,n)=>p.getByRole('button',{name:n,exact:true});
const row=(p,n)=>p.locator('.fan-card, .dayboard-row').filter({hasText:n});
async function state(p){return p.evaluate(async()=>{const {createWorkspaceStore}=await import('/src/store.ts');const s=createWorkspaceStore();try{return await s.read();}finally{s.close();}});}
async function check(name,fn){const context=await browser.newContext({timezoneId:'Asia/Shanghai',serviceWorkers:'block',viewport:{width:1280,height:900}});let p;
 try{p=await context.newPage();p.setDefaultTimeout(5000);await p.goto(url);await p.waitForLoadState('networkidle');const detail=await fn(p,context);results.push({name,status:'pass',detail});console.log('PASS',name);}
 catch(e){const entry={name,status:'fail',error:e.stack};if(p){entry.state=await state(p).catch(()=>null);entry.ui=await p.locator('body').innerText().catch(()=>null);await p.screenshot({path:path.join(out,name+'.png'),fullPage:true}).catch(()=>{});}results.push(entry);console.log('FAIL',name,e.message.split('\n')[0]);}
 finally{await context.close();}}
async function seed(p,kind='hand'){
 await p.evaluate(async kind=>{const fx=await import('/tests/fixtures/action/independent.ts');const {createWorkspaceStore}=await import('/src/store.ts');const {createWorkspaceClient}=await import('/src/workspace-client.ts');const s=createWorkspaceStore();
 let d=kind==='planned'||kind==='planned-fixed'?fx.planned():fx.hand();if(kind==='planned-fixed')d.planner.fixed=fx.fixed().planner.fixed;
 if(kind==='no-duration'){d.planner.instances[0].currentContent=fx.content(null);d.planner.instances[0].creationSnapshot=fx.content(null);}
 await s.atomic(()=>({write:fx.envelope(d),result:null}));
 if(kind==='fixed'){const c=createWorkspaceClient({store:s,now:()=>fx.AT});const submit=async(type,payload,id)=>{const load=await c.load();const r=await c.submit({commandId:id,expected:load.value.token,type,payload});if(!r.ok)throw Error(JSON.stringify(r));};
 const template={id:'monday',version:1,name:'合成固定模板',weekdays:[1],source:{kind:'manual'},entries:[{id:'x',title:'固定甲',start:'09:15',elapsedMinutes:30,definitionId:null},{id:'y',title:'固定乙',start:'10:00',elapsedMinutes:30,definitionId:null}]};
 await submit('SaveTemplate',{template,expectedVersion:null},'seed-template');await submit('PrepareDay',{date:'2026-09-28',zone:'Asia/Shanghai',templateId:'monday'},'seed-day');c.close();}else s.close();
 },kind);
 await p.reload({waitUntil:'networkidle'});await p.locator('nav').getByText('抽卡手牌').click();await p.getByRole('tab',{name:'当日',exact:true}).click();await p.getByLabel('日期',{exact:true}).fill('2026-09-28');
 await p.getByLabel('时区',{exact:true}).fill('Asia/Shanghai');await p.locator('.fan-card, .dayboard-row').first().waitFor();
}
async function actual(p){await row(p,'独立合成行动').getByRole('button',{name:'确认实际',exact:true}).click();const dlg=p.getByRole('dialog',{name:'确认实际发生'});await dlg.waitFor();await dlg.locator('.flow-actualrange').waitFor();return dlg;}
async function twoFacts(p){await p.evaluate(async()=>{const fx=await import('/tests/fixtures/action/independent.ts');const {createWorkspaceStore}=await import('/src/store.ts');const s=createWorkspaceStore();const d=fx.confirmed(),c={...fx.content(),title:'第二事实'};d.planner.instances.push({...structuredClone(d.planner.instances[0]),id:'i2',currentContent:c,creationSnapshot:c});const range=fx.shanghai('10:00',30);d.planner.plans.push({...structuredClone(d.planner.plans[0]),id:'p2',instanceId:'i2',range,contentSnapshot:c});d.planner.facts.push({...structuredClone(d.planner.facts[0]),id:'f2',instanceId:'i2',contentSnapshot:c,actualRange:fx.shanghai('10:10',20),plannedSnapshot:{planId:'p2',planVersion:4,range,content:c}});try{await s.atomic(()=>({write:fx.envelope(d),result:null}));}finally{s.close();}});await p.reload({waitUntil:'networkidle'});await p.locator('nav').getByText('抽卡手牌').click();await p.getByRole('tab',{name:'当日',exact:true}).click();await p.getByLabel('日期',{exact:true}).fill('2026-09-28');await p.getByLabel('为 独立合成行动 添加批注').waitFor();}
async function delaySaves(p,count){await p.evaluate(count=>{const orig=IDBDatabase.prototype.transaction;let left=count;IDBDatabase.prototype.transaction=function(names,mode,...rest){const tx=orig.call(this,names,mode,...rest);if(mode==='readwrite'){let complete;Object.defineProperty(tx,'oncomplete',{get(){return complete;},set(fn){complete=fn;tx.addEventListener('complete',event=>setTimeout(()=>fn.call(tx,event),1500),{once:true});}});if(--left===0)IDBDatabase.prototype.transaction=orig;}return tx;};},count);}
try {
 await check('G2-annotation-busy-protects-own-input-and-other-draft',async p=>{await twoFacts(p);const first=p.getByLabel('为 独立合成行动 添加批注'),second=p.getByLabel('为 第二事实 添加批注');await first.fill('要保存的第一段');await second.fill('其它原草稿');await delaySaves(p,1);await p.locator('.fact-item').filter({hasText:'独立合成行动'}).getByRole('button',{name:'添加批注'}).click();assert.equal(await first.isDisabled(),true,'saving annotation input must be disabled');assert.equal(await second.isEnabled(),true);await second.fill('其它事实的新草稿');await p.getByText('要保存的第一段',{exact:true}).waitFor();assert.equal(await first.inputValue(),'');assert.equal(await second.inputValue(),'其它事实的新草稿','async success must preserve other facts drafts');const d=(await state(p)).data;assert.equal(d.planner.annotations.filter(a=>a.text==='要保存的第一段').length,1);assert.equal(d.planner.annotations.filter(a=>a.factId==='f2').length,0);return{ownInputProtected:true,otherDraftPreserved:true};});
 await check('G2-annotations-two-pending-facts-stay-independently-busy',async p=>{await twoFacts(p);const first=p.getByLabel('为 独立合成行动 添加批注'),second=p.getByLabel('为 第二事实 添加批注');await first.fill('并发第一段');await second.fill('并发第二段');await delaySaves(p,2);await p.locator('.fact-item').filter({hasText:'独立合成行动'}).getByRole('button',{name:'添加批注'}).click();await p.locator('.fact-item').filter({hasText:'第二事实'}).getByRole('button',{name:'添加批注'}).click();assert.equal(await first.isDisabled(),true);assert.equal(await second.isDisabled(),true);await p.getByText('并发第一段',{exact:true}).waitFor();await p.getByText('并发第二段',{exact:true}).waitFor();assert.equal(await first.inputValue(),'');assert.equal(await second.inputValue(),'');const d=(await state(p)).data;assert.equal(d.planner.annotations.filter(a=>a.text==='并发第一段').length,1);assert.equal(d.planner.annotations.filter(a=>a.text==='并发第二段').length,1);return{perFactBusy:true,eachSavedOnce:true};});
} finally {await browser.close();await server.close();await fs.writeFile(path.join(out,'results.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));console.log('Evidence:',out);}
console.log('2G annotation:',results.filter(r=>r.status==='pass').length+'/'+results.length);if(results.some(r=>r.status==='fail'))process.exitCode=1;
