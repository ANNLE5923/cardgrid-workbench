// Journal browser gate: real React UI, real IndexedDB and named SaveJournalEntry commands,
// plus a synthetic harness for the autosave failure/retry/trailing state machine.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root=fileURLToPath(new URL('../../',import.meta.url));
const out=path.join(process.env.CARDGRID_2G_OUTPUT||path.join(root,'test-results/journal'));
await fs.mkdir(out,{recursive:true});
const {chromium}=await import(process.env.CARDGRID_PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({root,configFile:path.join(root,'scripts/vite.config.ts'),configLoader:'native',
  server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error',
  plugins:[{name:'journal-reset',configureServer(vite){
    vite.middlewares.use((req,res,next)=>{
      if((req.url||'').split('?')[0]==='/__reset'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>reset</title>');return;}
      next();
    });
  }}]});
await server.listen();
const origin='http://127.0.0.1:'+server.httpServer.address().port;
const browser=await chromium.launch({headless:true,...(process.env.CARDGRID_CHROME_PATH?{executablePath:process.env.CARDGRID_CHROME_PATH}:{})});
const results=[];
const nav=(page,name)=>page.locator('nav').getByRole('button',{name});
const raw=page=>page.evaluate(async()=>{
  const {createWorkspaceStore}=await import('/src/workspace/store.ts');const store=createWorkspaceStore();
  try{return {current:(await store.read())??null,recovery:await store.readRecovery()};}finally{store.close();}
});
async function check(id,fn,options={}){
  if(process.env.CARDGRID_CASE && id!==process.env.CARDGRID_CASE)return;
  const viewport=options.viewport??{width:1280,height:900};
  const context=await browser.newContext({timezoneId:'Asia/Tokyo',serviceWorkers:'block',viewport}),page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
  // Drop the shared default IndexedDB so every case starts from a clean workspace.
  await page.goto(origin+'/__reset');
  await page.evaluate(()=>new Promise((resolve,reject)=>{
    const r=indexedDB.deleteDatabase('cardgrid-workspace');
    r.onsuccess=()=>resolve(undefined);r.onerror=()=>reject(r.error);r.onblocked=()=>reject(new Error('delete blocked'));
  }));
  if(options.clock!==false)await page.clock.install({time:new Date('2026-10-05T12:00:00Z')});
  else await page.clock.setFixedTime(new Date('2026-10-05T12:00:00Z')); // Fixed Date; real autosave timers keep running.
  try{const detail=await fn(page);assert.deepEqual(errors,[]);results.push({id,status:'pass',detail});console.log('PASS',id);}
  catch(e){results.push({id,status:'fail',error:String(e.stack??e),errors});console.error('FAIL',id,e);
    await page.screenshot({path:path.join(out,'failure-'+id+'.png'),fullPage:true}).catch(()=>{});}
  finally{await context.close();}
}
const openJournal=async page=>{await page.goto(origin);await nav(page,'日记').click();
  const textarea=page.getByLabel('日记正文');await textarea.waitFor();return textarea;};
const waitSaved=page=>page.locator('.journal-statusbar').getByText(/已保存/).waitFor();
const mountHarness=async page=>{
  await page.goto(origin);
  await page.evaluate(async()=>{const m=await import('/tests/browser/journal-autosave-harness.tsx');await m.mountJournalHarness();});
  await page.waitForFunction(()=>!!window.__j);
};

try{
 await check('J01-autosave-status-and-persist',async page=>{
  const textarea=await openJournal(page);
  await textarea.fill('今天写的第一段');
  await waitSaved(page);
  const state=await raw(page),entries=state.current.data.journalEntries;
  assert.equal(entries.length,1);
  assert.equal(entries[0].text,'今天写的第一段');
  assert.equal(entries[0].zone,'Asia/Tokyo');
  assert.equal(entries[0].date,'2026-10-05');
  assert.equal(await page.locator('.journal-calendar-cell.has-entry').count(),1);
  return {persisted:true,statusSaved:true};
 }, {clock:false});

 await check('J02-calendar-backfill-neighbors-future',async page=>{
  let textarea=await openJournal(page);
  await textarea.fill('五号');await waitSaved(page);
  await page.locator('.journal-calendar-cell[title="2026-10-03"]').click();
  await page.getByRole('heading',{name:/2026年10月3日/}).waitFor();
  textarea=page.getByLabel('日记正文');
  await textarea.waitFor();
  assert.equal(await textarea.inputValue(),'');
  await textarea.fill('三号补写');await waitSaved(page);
  await page.getByRole('button',{name:'下一篇 ›'}).click();
  await page.getByRole('heading',{name:/2026年10月5日/}).waitFor();
  assert.equal(await page.locator('.journal-calendar-cell[title="2026-10-06"]').isDisabled(),true);
  return {backfill:true,neighborsSkipBlank:true,futureDisabled:true};
 }, {clock:false});

 await check('J03-clearing-keeps-record',async page=>{
  const textarea=await openJournal(page);
  await textarea.fill('有点内容');await waitSaved(page);
  await textarea.fill('');await waitSaved(page);
  const entries=(await raw(page)).current.data.journalEntries;
  assert.equal(entries.length,1);assert.equal(entries[0].text,'');
  return {recordKeptWhenBlank:true};
 }, {clock:false});

 await check('J04-failure-keeps-draft-and-retry',async page=>{
  await mountHarness(page);
  await page.evaluate(()=>{window.__j.failNext=true;});
  const t=page.getByLabel('harness text');
  await t.fill('没存上的话');await page.clock.runFor(300);
  await page.waitForFunction(()=>window.__j.autosave.status==='error');
  assert.equal(await t.inputValue(),'没存上的话');
  await page.evaluate(()=>window.__j.autosave.retry());
  await page.waitForFunction(()=>window.__j.autosave.status==='saved');
  return {draftKept:true,retryRecovers:true};
 });

 await check('J05-trailing-save-while-busy',async page=>{
  await mountHarness(page);
  await page.evaluate(()=>{window.__j.hangNext=true;});
  const t=page.getByLabel('harness text');
  await t.fill('第一版');await page.clock.runFor(300);
  await page.waitForFunction(()=>window.__j.autosave.status==='saving');
  await t.fill('第二版');
  await page.evaluate(()=>window.__j.release());
  await page.waitForFunction(()=>window.__j.autosave.status==='saved');
  const calls=await page.evaluate(()=>window.__j.calls);
  assert.deepEqual(calls,['第一版','第二版']);
  return {trailingSave:true};
 });
}catch(e){console.error('journal gate fatal',e);process.exitCode=1;}
await server.close();await browser.close();
await fs.writeFile(path.join(out,'journal-browser-results.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));
if(results.some(r=>r.status==='fail'))process.exitCode=1;
