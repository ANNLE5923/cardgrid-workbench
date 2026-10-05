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
const out=path.join(process.env.CARDGRID_BROWSER_OUTPUT_ROOT||path.join(root,'test-results'),'action-3g-readonly-edges');
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
async function openDay(p,data=hand(),date='2026-09-28'){validateActionData(data);await p.goto(origin);await p.getByRole('button',{name:'重新载入',exact:true}).waitFor();await write(p,envelope(data));await p.reload();await p.locator('nav').getByText('抽卡手牌').click();await p.getByRole('button',{name:'当日',exact:true}).click();await p.locator('.dial-svg').waitFor();if(date)await p.getByLabel('日期',{exact:true}).fill(date);await p.waitForTimeout(120);}
async function point(p,x,y){const b=await p.locator('.dial-svg').boundingBox(),s=Math.min(b.width,b.height)/400;return{x:b.x+(b.width-400*s)/2+x*s,y:b.y+(b.height-400*s)/2+y*s};}
async function drag(p,x=200,y=294){const c=p.locator('.fan-card').first();await c.scrollIntoViewIfNeeded();const b=await c.boundingBox();await p.mouse.move(b.x+b.width/2,b.y+40);await p.mouse.down();const q=await point(p,x,y);await p.mouse.move(q.x,q.y,{steps:1});await adjust(p).waitFor();await p.mouse.up();await p.waitForTimeout(80);}
async function pathPoint(loc){return loc.evaluate(el=>{const q=el.getPointAtLength(el.getTotalLength()/2),m=el.getScreenCTM(),v=new DOMPoint(q.x,q.y).matrixTransform(m);return{x:v.x,y:v.y};});}
async function check(id,fn,options={}){const ctx=await browser.newContext({timezoneId:options.zone??'Asia/Shanghai',serviceWorkers:'block',viewport:options.viewport??{width:1280,height:900},reducedMotion:options.reduce?'reduce':'no-preference'}),p=await ctx.newPage();p.setDefaultTimeout(3000);const row={id,status:'passed',observations:{}},errors=[];p.on('pageerror',e=>errors.push(String(e)));try{if(options.clock)await p.clock.install({time:new Date(options.clock)});else await p.clock.setFixedTime(new Date('2026-10-02T01:02:47Z'));await fn(p,row.observations,ctx);assert.deepEqual(errors,[]);}catch(e){row.status='failed';row.error=String(e.stack??e);row.pageErrors=errors;try{row.state=await raw(p);row.ui=await p.locator('body').innerText();row.layout=await p.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,active:document.activeElement?.outerHTML}));}catch{} }finally{try{await p.screenshot({path:path.join(out,id+'.png'),fullPage:true});}catch{}results.push(row);await fs.writeFile(path.join(out,'edge-results.json'),JSON.stringify({task:'G3-Codex',origin,version:browser.version(),at:new Date().toISOString(),passed:results.filter(x=>x.status==='passed').length,failed:results.filter(x=>x.status==='failed').length,results},null,2));console.log(id+' '+row.status+' '+(row.error?.split('\n')[0]??''));await ctx.close();}}
try{
await check('Q01-view-only-does-not-retain-placement-origin',async(p,o)=>{
 await openDay(p);await p.getByLabel('默认落点',{exact:true}).fill('09:00');
 await p.locator('.fan-card strong').first().click();const view=p.getByRole('dialog',{name:'查看手牌',exact:true});await view.waitFor();await view.getByRole('button',{name:'关闭',exact:true}).first().click();await view.waitFor({state:'detached'});
 await p.getByLabel('默认落点',{exact:true}).fill('11:00');
 await p.getByRole('button',{name:'打出',exact:true}).click();await oldPlace(p).locator('.flow-candidate').waitFor();
 o.beforeCancel=await p.locator('.dial-center-time').textContent();await oldPlace(p).getByRole('button',{name:'取消',exact:true}).click();await oldPlace(p).waitFor({state:'detached'});
 o.afterCancel=await p.locator('.dial-center-time').textContent();assert.equal(o.afterCancel,'11:00');
});
await check('Q02-first-entry-push-threshold',async(p,o)=>{
 await openDay(p);await p.getByLabel('默认落点',{exact:true}).fill('09:00');
 const c=p.locator('.fan-card').first();await c.scrollIntoViewIfNeeded();const b=await c.boundingBox();
 await p.mouse.move(b.x+b.width/2,b.y+40);await p.mouse.down();let q=await point(p,200,332);await p.mouse.move(q.x,q.y+40,{steps:1});await adjust(p).locator('.adjust-candidate').waitFor();o.outer=await adjust(p).innerText();o.outerEdge=await p.locator('.drag-card-ghost').boundingBox();
 q=await point(p,200,294);await p.mouse.move(q.x,q.y+40,{steps:1});await p.waitForTimeout(180);o.after38=await adjust(p).innerText();o.after38Edge=await p.locator('.drag-card-ghost').boundingBox();q=await point(p,200,250);await p.mouse.move(q.x,q.y+40,{steps:1});await p.waitForTimeout(180);q=await point(p,200,294);await p.mouse.move(q.x,q.y+40,{steps:1});await p.waitForTimeout(180);o.after75=await adjust(p).innerText();await p.mouse.up();
 assert.match(o.outer,/2026-09-28T21:00/);assert.match(o.after38,/2026-09-28T21:00/);assert.match(o.after75,/2026-09-28T09:00/);
});
await check('Q03-scaled-card-real-top-edge',async(p,o)=>{
 await openDay(p);const c=p.locator('.fan-card').first();await c.scrollIntoViewIfNeeded();const b=await c.boundingBox();
 const start={x:b.x+b.width/2,y:b.y+40};await p.mouse.move(start.x,start.y);await p.mouse.down();await p.mouse.move(start.x+6,start.y,{steps:1});await p.locator('.drag-card-ghost').waitFor();const g=await p.locator('.drag-card-ghost').boundingBox();
 o.expected={x:b.x+b.width/2+6,y:b.y};o.actual={x:g.x+g.width/2,y:g.y};o.source=b;o.ghost=g;
 await p.mouse.up();assert.ok(Math.abs(o.actual.x-o.expected.x)<1,'top edge must include the ancestor scale');assert.ok(Math.abs(o.actual.y-o.expected.y)<1,'top edge must retain its real vertical position');
},{viewport:{width:320,height:568}});
}finally{await browser.close();await new Promise(r=>server.httpServer.close(r));}
const passed=results.filter(x=>x.status==='passed').length;console.log(JSON.stringify({total:results.length,passed,failed:results.length-passed,out}));if(passed!==results.length)process.exitCode=1;
