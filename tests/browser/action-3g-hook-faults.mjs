import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=path.join(process.env.CARDGRID_BROWSER_OUTPUT_ROOT||path.join(root,'test-results'),'action-3g-hook-faults');
await fs.mkdir(out,{recursive:true});
const {chromium}=await import(process.env.CARDGRID_PLAYWRIGHT_MODULE);
const server=await createServer({root,configLoader:'native',server:{host:'127.0.0.1',port:0,strictPort:false}});
await server.listen();
const origin='http://127.0.0.1:'+server.httpServer.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.CARDGRID_CHROME_PATH});
const results=[];
const state=p=>p.evaluate(()=>window.__g3.state);
const read=p=>p.evaluate(()=>window.__g3.read());
async function settled(p,status='preview'){await p.waitForFunction(s=>window.__g3.state.status===s&&!window.__g3.state.busy,status);}
async function check(id,fn,kind='hand'){
 const context=await browser.newContext({serviceWorkers:'block',timezoneId:'Asia/Shanghai'}),p=await context.newPage();
 p.setDefaultTimeout(5000);const row={id,status:'passed'},errors=[];p.on('pageerror',e=>errors.push(String(e)));
 try{await p.goto(origin);await p.evaluate(async kind=>{const {mountHarness}=await import('/tests/browser/placement-session-harness.tsx');await mountHarness(kind);},kind);await p.waitForFunction(()=>!!window.__g3?.session);await fn(p);assert.deepEqual(errors,[]);}
 catch(e){row.status='failed';row.error=String(e.stack??e);row.errors=errors;row.ui=await p.locator('body').innerText().catch(()=>null);}
 finally{row.probe=await p.evaluate(()=>{const q=window.__g3;return q?{state:q.state,calls:q.calls,commands:q.commands,cancels:q.cancels,maximum:q.maximum}:null;}).catch(()=>null);results.push(row);console.log(id+' '+row.status+(row.error?' '+row.error.split('\n')[0]:''));await context.close();}
}
try{
 await check('E01-serial-coalesce-pending',async p=>{
  await p.evaluate(()=>window.__g3.start());await settled(p);
  await p.evaluate(()=>{const q=window.__g3;q.delay='preview';void q.session.moveTo('2026-09-28',600);});
  await p.waitForFunction(()=>!!window.__g3.releaseDelay);
  await p.evaluate(()=>{void window.__g3.session.moveTo('2026-09-28',605);void window.__g3.session.moveTo('2026-09-28',610);void window.__g3.session.moveTo('2026-09-28',615);});
  assert.equal((await state(p)).preview,null);
  assert.equal(await p.locator('.adjust-candidate').count(),0);
  assert.equal(await p.getByRole('button',{name:'确认排期',exact:true}).isDisabled(),true);
  assert.equal(await p.evaluate(()=>window.__g3.calls.length),2);
  await p.evaluate(()=>window.__g3.releaseDelay());await settled(p);
  assert.equal((await state(p)).preview.query.focusMinuteOfDay,615);
  assert.equal(await p.evaluate(()=>window.__g3.calls.length),3);
  assert.equal(await p.evaluate(()=>window.__g3.maximum),1);
 });
 await check('E02-late-preview-cancelled',async p=>{
  const before=await read(p);await p.evaluate(()=>{window.__g3.delay='preview';void window.__g3.start();});
  await p.waitForFunction(()=>!!window.__g3.releaseDelay);
  await p.evaluate(()=>{window.__g3.session.release();window.__g3.releaseDelay();});
  await p.waitForFunction(()=>window.__g3.cancels.length===1);assert.equal((await state(p)).status,'idle');assert.deepEqual(await read(p),before);
 });
 await check('E03-storage-retry-complete-command',async p=>{
  await p.evaluate(()=>window.__g3.start());await settled(p);const before=await read(p);
  await p.evaluate(async()=>{window.__g3.failBefore=true;await window.__g3.commit();});await settled(p);assert.deepEqual(await read(p),before);
  await p.evaluate(()=>window.__g3.commit());await settled(p,'committed');
  const commands=await p.evaluate(()=>window.__g3.commands);assert.equal(commands.length,2);assert.deepEqual(commands[0],commands[1]);assert.equal((await read(p)).data.planner.plans.length,1);
 });
 await check('E04-new-input-clears-retry-command',async p=>{
  await p.evaluate(()=>window.__g3.start());await settled(p);
  await p.evaluate(async()=>{window.__g3.failBefore=true;await window.__g3.commit();});
  await p.evaluate(()=>window.__g3.session.moveTo('2026-09-28',660));await settled(p);
  await p.evaluate(()=>window.__g3.commit());await settled(p,'committed');
  const commands=await p.evaluate(()=>window.__g3.commands);assert.notEqual(commands[0].commandId,commands[1].commandId);
  assert.equal((await read(p)).data.planner.plans[0].range.localStart,'2026-09-28T11:00');
 });
 await check('E05-lost-response-idempotent-replay',async p=>{
  await p.evaluate(()=>window.__g3.start());await settled(p);
  await p.evaluate(async()=>{window.__g3.loseAfter=true;await window.__g3.commit();});await settled(p);
  const first=await read(p);assert.equal(first.data.planner.plans.length,1);
  await p.evaluate(()=>window.__g3.commit());await settled(p,'committed');
  const commands=await p.evaluate(()=>window.__g3.commands);assert.deepEqual(commands[0],commands[1]);
  assert.deepEqual(await read(p),first);assert.equal(await p.evaluate(()=>window.__g3.outcome.replayed),true);
 });
 await check('E06-fixed-repreview-fresh-unlock',async p=>{
  await p.evaluate(()=>window.__g3.start());await settled(p);const before=await read(p);
  await p.evaluate(()=>window.__g3.session.moveTo('2026-09-28',660));await settled(p);assert.equal((await state(p)).error,null);
  await p.evaluate(()=>window.__g3.commit());await settled(p,'committed');
  const after=await read(p);assert.equal(after.data.planner.fixed[0].range.localStart,'2026-09-28T11:00');assert.deepEqual(after.data.planner.fixed[1],before.data.planner.fixed[1]);assert.equal(after.data.planner.plans.length,0);
 },'fixed');
 await check('E07-late-fixed-unlock-released',async p=>{
  await p.evaluate(()=>window.__g3.start());await settled(p);const before=await read(p);
  await p.evaluate(()=>{window.__g3.delay='unlock';void window.__g3.session.moveTo('2026-09-28',660);});
  await p.waitForFunction(()=>!!window.__g3.releaseDelay);
  await p.evaluate(()=>{window.__g3.session.release();window.__g3.releaseDelay();});
  await p.waitForFunction(()=>window.__g3.active===0&&window.__g3.cancels.length>=2);
  const result=await p.evaluate(()=>window.__g3.tryLastUnlock());assert.equal(result.ok,false);assert.equal(result.code,'FIXED_LOCKED');assert.deepEqual(await read(p),before);
 },'fixed');
 await check('E08-fixed-invalid-preview-cleans-unlock',async p=>{
  await p.evaluate(()=>window.__g3.start());await settled(p);const before=await read(p);
  await p.evaluate(()=>window.__g3.session.moveTo('2026-09-28',541));await settled(p,'error');
  const result=await p.evaluate(()=>window.__g3.tryLastUnlock());assert.equal(result.ok,false);assert.equal(result.code,'FIXED_LOCKED');assert.deepEqual(await read(p),before);
 },'fixed');
 await check('E09-pending-cannot-commit',async p=>{
  await p.evaluate(()=>{window.__g3.delay='preview';void window.__g3.start();});await p.waitForFunction(()=>!!window.__g3.releaseDelay);
  assert.equal(await p.evaluate(()=>window.__g3.commit()),false);assert.equal(await p.evaluate(()=>window.__g3.commands.length),0);
  await p.evaluate(()=>window.__g3.releaseDelay());await settled(p);
 });
 await check('E10-double-submit-one-command',async p=>{
  await p.evaluate(()=>window.__g3.start());await settled(p);
  await p.evaluate(()=>Promise.all([window.__g3.commit(),window.__g3.commit()]));
  assert.equal(await p.evaluate(()=>window.__g3.commands.length),1);assert.equal((await read(p)).data.planner.plans.length,1);
 });
}finally{await browser.close();await server.close();await fs.writeFile(path.join(out,'hook-faults.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));}
console.log(JSON.stringify({total:results.length,passed:results.filter(r=>r.status==='passed').length,out}));
if(results.some(r=>r.status!=='passed'))process.exitCode=1;
