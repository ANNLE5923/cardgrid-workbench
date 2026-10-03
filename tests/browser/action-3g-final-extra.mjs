// G3 Codex independent production browser acceptance. Fresh synthetic contexts; no user profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {preview} from 'vite';
import {hand,planned,confirmed,fixed,envelope,shanghai} from '../fixtures/action/independent.ts';
import {plannedRange} from '../../src/daily/schedule/time.ts';
import {validateActionData} from '../../src/workspace/format.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=path.join(root,'test-results','action-3g-final-extra');
await fs.mkdir(out,{recursive:true});
const {chromium}=await import(process.env.CARDGRID_PLAYWRIGHT_MODULE);
const server=await preview({root,configLoader:'native',preview:{host:'127.0.0.1',port:0,strictPort:false}});
const origin='http://127.0.0.1:'+server.httpServer.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CARDGRID_CHROME_PATH});
const results=[];
const adjust=p=>p.getByRole('dialog',{name:'调整落点并确认',exact:true});
const oldPlace=p=>p.getByRole('dialog',{name:'排期与重叠确认',exact:true});
async function raw(p){return p.evaluate(async()=>{const db=await new Promise((r,j)=>{const q=indexedDB.open('cardgrid-workspace',3);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});const t=db.transaction(['workspace','recovery'],'readonly'),a=t.objectStore('workspace').get('current'),b=t.objectStore('recovery').getAll();await new Promise((r,j)=>{t.oncomplete=r;t.onabort=()=>j(t.error);});db.close();return {current:a.result??null,recovery:b.result};});}
async function write(p,value,notify=false){await p.evaluate(async({value,notify})=>{const db=await new Promise((r,j)=>{const q=indexedDB.open('cardgrid-workspace',3);q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error);});await new Promise((r,j)=>{const t=db.transaction('workspace','readwrite');t.objectStore('workspace').put(value,'current');t.oncomplete=r;t.onabort=()=>j(t.error);});db.close();if(notify){const c=new BroadcastChannel('cardgrid-workspace:v4');c.postMessage({epoch:value.epoch,revision:value.revision});setTimeout(()=>c.close(),100);}}, {value,notify});}
async function openDay(p,data=hand(),date='2026-09-28'){validateActionData(data);await p.goto(origin);await p.getByRole('button',{name:'重新载入',exact:true}).waitFor();await write(p,envelope(data));await p.reload();await p.locator('nav').getByText('抽卡手牌').click();await p.getByRole('tab',{name:'当日',exact:true}).click();await p.locator('.dial-svg').waitFor();if(date)await p.getByLabel('日期',{exact:true}).fill(date);await p.waitForTimeout(120);}
async function point(p,x,y){const b=await p.locator('.dial-svg').boundingBox(),s=Math.min(b.width,b.height)/400;return{x:b.x+(b.width-400*s)/2+x*s,y:b.y+(b.height-400*s)/2+y*s};}
async function drag(p,x=200,y=294){const c=p.locator('.fan-card').first();await c.scrollIntoViewIfNeeded();const b=await c.boundingBox();await p.mouse.move(b.x+b.width/2,b.y+40);await p.mouse.down();const q=await point(p,x,y);await p.mouse.move(q.x,q.y,{steps:1});await adjust(p).waitFor();await p.mouse.up();await p.waitForTimeout(80);}
async function pathPoint(loc){return loc.evaluate(el=>{const q=el.getPointAtLength(el.getTotalLength()/2),m=el.getScreenCTM(),v=new DOMPoint(q.x,q.y).matrixTransform(m);return{x:v.x,y:v.y};});}
async function check(id,fn,options={}){const ctx=await browser.newContext({timezoneId:options.zone??'Asia/Shanghai',serviceWorkers:'block',viewport:options.viewport??{width:1280,height:900},reducedMotion:options.reduce?'reduce':'no-preference'}),p=await ctx.newPage();p.setDefaultTimeout(3000);const row={id,status:'passed',observations:{}},errors=[];p.on('pageerror',e=>errors.push(String(e)));try{if(options.clock)await p.clock.install({time:new Date(options.clock)});else await p.clock.setFixedTime(new Date('2026-10-02T01:02:47Z'));await fn(p,row.observations,ctx);assert.deepEqual(errors,[]);}catch(e){row.status='failed';row.error=String(e.stack??e);row.pageErrors=errors;try{row.state=await raw(p);row.ui=await p.locator('body').innerText();row.layout=await p.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,active:document.activeElement?.outerHTML}));}catch{} }finally{try{await p.screenshot({path:path.join(out,id+'.png'),fullPage:true});}catch{}results.push(row);await fs.writeFile(path.join(out,'production-extra.json'),JSON.stringify({task:'G3-Codex',origin,version:browser.version(),at:new Date().toISOString(),passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length,results},null,2));console.log(id+' '+row.status+' '+(row.error?.split('\n')[0]??''));await ctx.close();}}
try{
await check('P01-next-day-scene-conflict-cancel-restores',async(p,o)=>{
 const d=hand();d.planner.fixed=[{...fixed().planner.fixed[0],range:shanghai('00:15',30,'2026-09-29'),ownerDate:'2026-09-29'}];
 await openDay(p,d);const before=await raw(p);await p.getByLabel('默认落点',{exact:true}).fill('23:55');const a=182.5*Math.PI/180;
 await drag(p,200+132*Math.sin(a),200-132*Math.cos(a));
 assert.equal(await p.getByLabel('日期',{exact:true}).inputValue(),'2026-09-29');
 assert.match(await p.locator('.dial-svg').getAttribute('aria-label'),/2026-09-29/);
 assert.equal(await p.locator('.dial-segment.fixed').count(),1);assert.match(await adjust(p).innerText(),/固定甲/);
 assert.match(await p.locator('.dayboard').innerText(),/未保存/);
 await adjust(p).getByRole('button',{name:'取消',exact:true}).click();await p.waitForTimeout(120);
 assert.equal(await p.getByLabel('日期',{exact:true}).inputValue(),'2026-09-28');
 assert.equal(await p.locator('.dial-center-time').textContent(),'23:55');
 assert.equal(await p.locator('.dial-segment.fixed').count(),0);assert.deepEqual(await raw(p),before);
});
await check('P02-cross-source-same-id-overlap-painted',async(p,o)=>{
 const d=planned();d.planner.fixed=[{...fixed().planner.fixed[0],id:'p'}];await openDay(p,d);
 assert.equal(await p.locator('.dial-segment.plan').count(),1);assert.equal(await p.locator('.dial-segment.fixed').count(),1);
 assert.ok(await p.locator('.dial-overlap').count()>0);const before=await raw(p);
 await p.locator('.dial-segment.plan').focus();await p.keyboard.press('Enter');const note=await p.locator('.preview-note').innerText();
 assert.match(note,/计划/);assert.match(note,/固定/);assert.deepEqual(await raw(p),before);
});
await check('P03-real-fixed-prefix-id-explicit-unlock',async(p,o)=>{
 const d=fixed();d.planner.fixed[0].id='template-projection:real-saved';await openDay(p,d);const before=await raw(p);
 const arc=p.locator('.dial-segment.fixed').first();await arc.dblclick();
 assert.equal(await oldPlace(p).count(),0);assert.match(await p.locator('.dayboard').innerText(),/需要解锁/);assert.deepEqual(await raw(p),before);
 await p.locator('.dayboard .message').filter({hasText:'固定安排需要解锁'}).getByRole('button',{name:'解锁并调整',exact:true}).click();
 await oldPlace(p).getByLabel('落点时间',{exact:true}).fill('11:00');await oldPlace(p).locator('.flow-candidate.valid').waitFor();
 await oldPlace(p).getByRole('button',{name:'确认排期',exact:true}).click();await oldPlace(p).waitFor({state:'detached'});
 const after=await raw(p);assert.equal(after.current.data.planner.fixed[0].range.localStart,'2026-09-28T11:00');
 assert.deepEqual(after.current.data.planner.fixed[1],before.current.data.planner.fixed[1]);
});
await check('P04-plan-pointercancel-never-retracts',async(p,o)=>{
 await openDay(p,planned());const before=await raw(p);const arc=p.locator('.dial-segment.plan').first();
 await arc.scrollIntoViewIfNeeded();const q=await pathPoint(arc),b=await p.locator('.dial-svg').boundingBox(),cx=b.x+b.width/2,cy=b.y+b.height/2;
 await p.mouse.move(q.x,q.y);await p.mouse.down();await p.mouse.move(cx+(q.x-cx)*2.2,cy+(q.y-cy)*2.2,{steps:8});
 await p.locator('.dial-svg').evaluate(el=>el.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));
 await p.mouse.up();await p.waitForTimeout(140);assert.deepEqual(await raw(p),before);
});
await check('P05-adjust-tab-trap-and-focus-return',async(p,o)=>{
 await openDay(p);await drag(p);const dlg=adjust(p);
 await dlg.getByRole('button',{name:'确认排期',exact:true}).focus();await p.keyboard.press('Tab');
 assert.equal(await dlg.evaluate(el=>el.contains(document.activeElement)),true);
 await p.keyboard.press('Escape');assert.equal(await dlg.count(),0);
 assert.equal(await p.locator('.fan-card').evaluate(el=>el===document.activeElement),true);
 await drag(p);await adjust(p).getByRole('button',{name:'确认排期',exact:true}).click();await adjust(p).waitFor({state:'detached'});
 await p.waitForTimeout(120);assert.match(await p.evaluate(()=>document.activeElement.textContent),/手牌/);
});

await check('P06-button-24-saves-complete-next-day-range',async(p,o)=>{
 await openDay(p);await p.getByLabel('默认落点',{exact:true}).fill('23:55');
 await p.getByRole('button',{name:'向后 5 分钟',exact:true}).click();
 await p.getByRole('button',{name:'打出',exact:true}).click();
 await oldPlace(p).locator('.flow-candidate.valid').waitFor();
 assert.match(await oldPlace(p).locator('.flow-candidate').innerText(),/2026-09-29T00:00—2026-09-29T00:30/);
 await oldPlace(p).getByRole('button',{name:'确认排期',exact:true}).click();await oldPlace(p).waitFor({state:'detached'});
 const after=await raw(p);assert.equal(after.current.data.planner.plans.length,1);
 assert.equal(after.current.data.planner.plans[0].range.localStart,'2026-09-29T00:00');
 assert.equal(after.current.data.planner.plans[0].range.localEnd,'2026-09-29T00:30');
 assert.equal(await p.getByLabel('日期',{exact:true}).inputValue(),'2026-09-29');
});
}finally{await browser.close();await new Promise(r=>server.httpServer.close(r));}
const passed=results.filter(x=>x.status==='passed').length;console.log(JSON.stringify({total:results.length,passed,failed:results.length-passed,out}));if(passed!==results.length)process.exitCode=1;
