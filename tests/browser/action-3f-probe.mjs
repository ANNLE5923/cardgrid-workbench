// 3F source snapshot and first production browser inspection; synthetic context only.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {preview} from 'vite';
import {hand,envelope} from '../fixtures/action/independent.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=path.join(root,'tests/fixtures/action/3f-evidence');
await fs.mkdir(out,{recursive:true});
async function walk(dir){const result=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())result.push(...await walk(p));else result.push(p);}return result;}
const paths=[...await walk(path.join(root,'src')),...await walk(path.join(root,'dist')),...['package.json','package-lock.json','tests/time-dial-3b.test.ts','tests/time-dial-3c.test.ts','docs/产品设计/11-3A正式投影几何与手势合同.md'].map(p=>path.join(root,p))];
const hashes=Object.fromEntries(await Promise.all(paths.map(async p=>[path.relative(root,p).replaceAll('\\','/'),createHash('sha256').update(await fs.readFile(p)).digest('hex')])));
await fs.writeFile(path.join(out,'scope.json'),JSON.stringify({task:'3F',at:new Date().toISOString(),scope:'production/source/build and author tests frozen for independent review',hashes},null,2));
const {chromium}=await import(process.env.CARDGRID_PLAYWRIGHT_MODULE);
const server=await preview({root,configLoader:'native',preview:{host:'127.0.0.1',port:0,strictPort:false}});
const origin='http://127.0.0.1:'+server.httpServer.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CARDGRID_CHROME_PATH});
const ctx=await browser.newContext({timezoneId:'Asia/Shanghai',serviceWorkers:'block',viewport:{width:1280,height:900}});
try{
const p=await ctx.newPage();await p.goto(origin);await p.getByRole('button',{name:'重新载入',exact:true}).waitFor();
await p.evaluate(async v=>{const db=await new Promise((res,rej)=>{const r=indexedDB.open('cardgrid-workspace',3);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);});await new Promise((res,rej)=>{const t=db.transaction('workspace','readwrite');t.objectStore('workspace').put(v,'current');t.oncomplete=res;t.onabort=()=>rej(t.error);});db.close();},envelope(hand()));
await p.reload();await p.locator('nav').getByText('抽卡手牌').click();await p.getByRole('tab',{name:'当日',exact:true}).click();await p.getByLabel('日期',{exact:true}).fill('2026-09-28');await p.locator('.dial-svg').waitFor();await p.locator('.fan-card').waitFor();
console.log(JSON.stringify({text:await p.locator('body').innerText(),dial:await p.locator('.dial-svg').boundingBox(),card:await p.locator('.fan-card').boundingBox(),scroll:await p.evaluate(()=>({x:scrollX,y:scrollY,innerWidth,scrollWidth:document.documentElement.scrollWidth}))}));
await p.screenshot({path:path.join(out,'initial-desktop.png'),fullPage:true});
}finally{await ctx.close();await browser.close();await new Promise(res=>server.httpServer.close(res));}
