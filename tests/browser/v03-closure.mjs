// Production bundle, real IndexedDB, synthetic records in fresh contexts only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=process.env.CARDGRID_V03_OUTPUT||path.join(root,'test-results/v03-closure/browser');
await fs.mkdir(output,{recursive:true});
const {chromium}=await import(process.env.CARDGRID_PLAYWRIGHT_MODULE||'playwright');
let previousShell=false,activationDelayMs=0;
const server=await createServer({root,configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0},
  optimizeDeps:{noDiscovery:true,entries:[],include:['@js-temporal/polyfill','jsbi']},plugins:[{name:'closure-built-shell',configureServer(vite){
    vite.middlewares.use(async(req,res,next)=>{
      const url=(req.url||'').split('?')[0];
      if(url==='/__seed'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Synthetic fixture only</title>');return;}
      const file=url==='/'?'index.html':url.slice(1);
      if(!['index.html','sw.js','favicon.svg','manifest.webmanifest'].includes(file)&&!/^assets\/[^/]+\.(js|css)$/.test(file))return next();
      try{let body=await fs.readFile(path.join(root,'dist',file));
        if(previousShell&&file==='sw.js')body=Buffer.from(body.toString().replace(/cardgrid-shell-[a-f0-9]+/,'cardgrid-shell-previous-fixture'));
        if(file==='sw.js'&&activationDelayMs)body=Buffer.from(body.toString()+`\nself.addEventListener('activate',e=>e.waitUntil(new Promise(resolve=>setTimeout(resolve,${activationDelayMs}))));`);
        if(previousShell&&file==='index.html')body=Buffer.from(body.toString().replace('<head>','<head><meta name="test-prior-shell" content="yes">'));
        res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');
        res.setHeader('Cache-Control','no-cache');res.end(body);
      }catch(error){next(error);}
    });
  }}]});
await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const results=[];let browser;
async function read(page){return page.evaluate(async()=>{
  const {createWorkspaceClient}=await import('/src/workspace/client.ts'),{createWorkspaceStore}=await import('/src/workspace/store.ts');
  const store=createWorkspaceStore(),client=createWorkspaceClient({store});
  try{const r=await client.load();if(!r.ok)throw Error(JSON.stringify(r));return r.value.data;}finally{client.close();}
});}
async function seed(page,{days=[0],accepts=0,books=2,poolMembers=books,secondAction=false,archive=false}={}){
  await page.goto(origin+'/__seed');
  return page.evaluate(async options=>{
    const {createWorkspaceClient}=await import('/src/workspace/client.ts'),{createWorkspaceStore}=await import('/src/workspace/store.ts');
    const fx=await import('/tests/modules/workshop/a1-fixtures.ts'),time=await import('/src/daily/time.ts');
    const today=time.dateAt(new Date().toISOString(),'Asia/Shanghai'),date=n=>time.nextDate(today,n);
    let at=`${date(-8)}T04:00:00Z`;const store=createWorkspaceStore(),client=createWorkspaceClient({store,now:()=>at,random:()=>0});
    const ok=r=>{if(!r.ok)throw Error(JSON.stringify(r));return r.value;},data=async()=>ok(await client.load()).data;
    const submit=async(type,payload)=>ok(await client.submit({commandId:crypto.randomUUID(),expected:ok(await client.load()).token,type,payload}));
    for(let i=1;i<=options.books;i++)await submit('SaveBookEntry',{bookEntry:fx.bookEntry({id:`book-${i}`,title:`书目${i}`}),expectedVersion:null});
    const members=Array.from({length:options.poolMembers},(_,i)=>`book-${i+1}`);
    await submit('SavePool',{pool:fx.pool({memberIds:members}),expectedVersion:null});
    await submit('SavePool',{pool:fx.pool({id:'book-child',name:'从属池',parentPoolId:'books',memberIds:[]}),expectedVersion:null});
    await submit('SaveActionCard',{actionCard:fx.actionCard(),expectedVersion:null});
    await submit('SaveGenerationRule',{generationRule:fx.rule({startDate:date(-8)}),expectedVersion:null});
    if(options.secondAction){await submit('SaveActionCard',{actionCard:fx.actionCard({id:'walk',content:{...fx.actionCard().content,title:'散步'},slots:[]}),expectedVersion:null});
      await submit('SaveGenerationRule',{generationRule:fx.rule({id:'daily-walk',actionCardId:'walk',startDate:date(-8)}),expectedVersion:null});}
    const accept=async copy=>{
      const token=ok(await client.load()).token,ref={id:copy.id,version:copy.version};
      const selected=ok(await client.selectEntry({token,copy:ref,slotId:'book',choice:{mode:'manual',entryId:'book-1'}})).selection;
      const preview=ok(await client.previewCombo({token,copy:ref,selections:[selected]}));
      return submit('AcceptDailyCopy',{copy:ref,selections:[selected],composedText:preview.composedText});
    };
    for(const n of options.days){at=n===0?new Date().toISOString():`${date(n)}T04:00:00Z`;await submit('GenerateDailyCopies',{target:'current'});
      for(let i=0;i<options.accepts;i++)await accept((await data()).dailyCopies.find(c=>c.sourceDate===date(n)&&c.ruleId==='daily-reading'));}
    if(options.archive){
      const ids=(await data()).planner.handOrder;
      for(let i=0;i<ids.length;i++){
        const instance=(await data()).planner.instances.find(x=>x.id===ids[i]);
        const p=ok(await client.previewPlacement({token:ok(await client.load()).token,subject:{kind:'hand',instanceId:instance.id,version:instance.version},date:date(i===0?-7:-1),zone:'Asia/Shanghai',focusMinuteOfDay:540}));
        await submit('CommitPlacement',{previewId:p.previewId,candidateId:p.candidates[0].id,acknowledgedOverlap:null});
        if(i===0){const plan=(await data()).planner.plans.find(p=>p.instanceId===instance.id);
          const actual=ok(await client.previewActual({token:ok(await client.load()).token,draft:{mode:'planned',instanceId:instance.id,instanceVersion:instance.version,planId:plan.id,planVersion:plan.version,
            start:{date:date(-7),time:'09:00',zone:'Asia/Shanghai'},end:{date:date(-7),time:'09:30',zone:'Asia/Shanghai'}}}));
          await submit('ConfirmActual',{previewId:actual.previewId,acknowledgedOverlap:null});
          await submit('AppendAnnotation',{factId:(await data()).planner.facts[0].id,text:'到期也要保留的批注'});
        }
      }
    }
    const value=await data();client.close();return {today,dates:options.days.map(date),data:value};
  },{days,accepts,books,poolMembers,secondAction,archive});
}
const hand=page=>page.locator('nav').getByRole('button',{name:'抽卡手牌'}).click();
async function combo(page,copyId){await page.getByLabel('手选库存副本').selectOption(copyId);await page.getByRole('button',{name:'翻开查看',exact:true}).click();await page.getByRole('button',{name:'填写槽位',exact:true}).click();await page.getByLabel('书名选择').waitFor();}
const waitData=async(page,predicate)=>{for(let i=0;i<100;i++){const value=await read(page);if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Authoritative data condition timed out');};
// The worker acknowledges listener installation before the old page is released. The latch
// remains readable after the event, even if Node starts observing it late.
async function waitForActivation(worker){
  const deadline=Date.now()+10000;
  do{
    if(await worker.evaluate(()=>self.__cardgridActivationStarted))return;
    await new Promise(resolve=>setTimeout(resolve,50));
  }while(Date.now()<deadline);
  throw Error('Expected update worker did not dispatch activate');
}
async function offlineUpdate(page,context,{observerDelayMs=0}={}){
  previousShell=true;await seed(page,{accepts:1});await page.goto(origin);
  await page.waitForFunction(async()=>(await navigator.serviceWorker.getRegistration())?.active?.state==='activated');
  await page.reload();await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
  const before=await read(page);assert.equal(await page.locator('meta[name="test-prior-shell"]').count(),1);
  const expectedCache=(await fs.readFile(path.join(root,'dist/sw.js'),'utf8')).match(/const CACHE='([^']+)'/)[1];
  // Arm before changing the server's worker bytes and requesting the update.
  const nextWorkerPromise=context.waitForEvent('serviceworker',{predicate:async worker=>worker.url()===origin+'/sw.js'&&await worker.evaluate(()=>CACHE)===expectedCache});
  previousShell=false;await page.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});
  const nextWorker=await nextWorkerPromise;
  await page.waitForFunction(async()=>(await navigator.serviceWorker.getRegistration())?.waiting?.state==='installed');
  await nextWorker.evaluate(()=>{
    self.__cardgridActivationStarted=false;
    self.addEventListener('activate',()=>{self.__cardgridActivationStarted=true;},{once:true});
  });
  await page.goto('about:blank');
  if(observerDelayMs)await new Promise(resolve=>setTimeout(resolve,observerDelayMs));
  await waitForActivation(nextWorker);
  await page.goto(origin);await page.waitForFunction(()=>!document.querySelector('meta[name="test-prior-shell"]'));
  assert.deepEqual(await read(page),before);
  await page.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
  const cached=await page.evaluate(async()=>{const names=await caches.keys();return Promise.all(names.map(async name=>{
    const cache=await caches.open(name);return {name,assets:await Promise.all((await cache.keys()).map(async r=>({url:r.url,requestHeaders:[...r.headers],responseHeaders:[...(await cache.match(r)).headers]})))};
  }));});
  assert(cached.some(cache=>cache.name===expectedCache),'current build cache must exist');
  await fs.writeFile(path.join(output,`offline-cache-${activationDelayMs}-${observerDelayMs}.json`),JSON.stringify(cached,null,2));
  page.on('requestfailed',r=>console.log('OFFLINE request failed:',r.url(),r.failure()?.errorText));
  await context.setOffline(true);await page.reload();await hand(page);await page.getByRole('tab',{name:/^手牌（/}).click();
  await page.locator('.act-titles strong').filter({hasText:/^阅读《书目1》$/}).waitFor();
  return {offlineReopen:true,cacheTransition:'synthetic prior shell -> real final shell',idbPreserved:true,activationDelayMs,observerDelayMs};
}
async function test(name,fn,options={}){
  if(process.env.CARDGRID_V03_ONLY&&!new RegExp(process.env.CARDGRID_V03_ONLY).test(name))return;
  const context=await browser.newContext({timezoneId:'Asia/Shanghai',serviceWorkers:'block',...options}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));const start=Date.now();
  try{const detail=await fn(page,context);assert.deepEqual(errors,[]);results.push({name,status:'pass',durationMs:Date.now()-start,detail});console.log('PASS',name);}
  catch(error){results.push({name,status:'fail',error:error.stack});console.error('FAIL',name,error);await page.screenshot({path:path.join(output,`failure-${name}.png`),fullPage:true}).catch(()=>{});}
  finally{await context.close();}
}
try{
  browser=await chromium.launch({headless:true,...(process.env.CARDGRID_CHROME_PATH?{executablePath:process.env.CARDGRID_CHROME_PATH}:{})});
  await test('blank-workshop-build-create-and-reload',async page=>{
    await page.goto(origin);assert.equal((await read(page)).bookEntries.length,0);
    await page.locator('nav').getByRole('button',{name:'制卡工坊'}).click();await page.getByRole('button',{name:'＋ 新建',exact:true}).click();
    await page.getByLabel('书名',{exact:true}).fill('第一本书');await page.getByRole('button',{name:'保存',exact:true}).click();
    const data=await waitData(page,d=>d.bookEntries.length===1);assert.equal(data.bookEntries[0].title,'第一本书');
    await page.reload();await page.locator('nav').getByRole('button',{name:'制卡工坊'}).click();await page.getByRole('button',{name:/第一本书/}).waitFor();
    return {version:data.version,realIdb:true};
  });
  await test('I1-blank-ui-workshop-generate-random-accept-reload-plan-actual',async page=>{
    await page.goto(origin);const today=await page.evaluate(async()=> (await import('/src/daily/time.ts')).dateAt(new Date().toISOString(),'Asia/Shanghai'));
    await page.locator('nav').getByRole('button',{name:'制卡工坊'}).click();
    await page.getByRole('button',{name:'＋ 新建',exact:true}).click();await page.getByLabel('书名',{exact:true}).fill('从零到一');await page.getByRole('button',{name:'保存',exact:true}).click();
    await waitData(page,d=>d.bookEntries.length===1);
    await page.getByRole('tab',{name:'卡池',exact:true}).click();await page.getByRole('button',{name:'＋ 在此新建',exact:true}).click();
    await page.getByLabel('池名称').fill('我的书目');await page.getByRole('checkbox',{name:'从零到一',exact:true}).check();await page.getByRole('button',{name:'保存',exact:true}).click();
    const catalog=await waitData(page,d=>d.pools.length===1);
    await page.getByRole('tab',{name:'行动原卡',exact:true}).click();await page.getByRole('button',{name:'＋ 新建',exact:true}).click();
    await page.getByLabel('行动名称').fill('阅读《{书名}》');await page.getByLabel('预设时长',{exact:true}).fill('30');
    await page.getByRole('button',{name:'＋ 添加槽'}).click();await page.getByLabel('槽标签').fill('书名');await page.getByLabel('绑定书目池').selectOption(catalog.pools[0].id);
    await page.getByRole('button',{name:'保存',exact:true}).click();const actions=await waitData(page,d=>d.actionCards.length===1);
    await page.getByRole('tab',{name:'生成规则',exact:true}).click();await page.getByRole('button',{name:'＋ 新建',exact:true}).click();
    await page.getByLabel('规则名称').fill('每天阅读');await page.getByLabel('绑定行动原卡').selectOption(actions.actionCards[0].id);await page.getByLabel('开始日期').fill(today);await page.getByLabel('时区',{exact:true}).fill('Asia/Shanghai');
    await page.getByRole('button',{name:'保存',exact:true}).click();await waitData(page,d=>d.generationRules.length===1);
    await hand(page);const inventory=await waitData(page,d=>d.dailyCopies.length===1);await combo(page,inventory.dailyCopies[0].id);
    await page.getByLabel('书名选择').selectOption('random');await page.getByRole('button',{name:'接受，加入手牌'}).click();await waitData(page,d=>d.planner.instances.length===1);
    await page.reload();await hand(page);await page.getByRole('button',{name:'当日',exact:true}).click();await page.locator('.fan-card').getByRole('button',{name:'打出',exact:true}).click();
    const placement=page.getByRole('dialog',{name:'排期与重叠确认',exact:true});await placement.getByRole('button',{name:'确认排期',exact:true}).click();
    await placement.waitFor({state:'detached'});await waitData(page,d=>d.planner.plans.length===1);
    await page.getByRole('button',{name:'确认实际',exact:true}).click();const actual=page.getByRole('dialog',{name:'确认实际发生',exact:true});await actual.getByRole('button',{name:'确认实际',exact:true}).click();await actual.waitFor({state:'detached'});
    const final=await waitData(page,d=>d.planner.facts.length===1);assert.equal(final.planner.instances[0].daily.sourceDate,today);assert.equal(final.planner.facts[0].contentSnapshot.title,'阅读《从零到一》');
    return {fromBlank:true,formalSaved:true,planned:true,actualFact:true,sourceDate:today};
  });
  await test('random-first-option-immediate-fixed-selection-and-independent-repeat',async page=>{
    const s=await seed(page);await page.goto(origin);await hand(page);await combo(page,s.data.dailyCopies[0].id);
    const select=page.getByLabel('书名选择');assert.equal(await select.inputValue(),'');
    assert.equal(await select.locator('option:not([disabled])').first().textContent(),'随机');
    assert.equal(await page.getByRole('button',{name:'接受，加入手牌'}).isEnabled(),false);
    await select.selectOption('random');await page.waitForFunction(()=>document.querySelector('[aria-label="书名选择"]').value.startsWith('book:'));
    const chosen=await select.inputValue(),title=await select.locator('option:checked').textContent();
    await page.getByRole('button',{name:'更新今日库存'}).click();assert.equal(await select.inputValue(),chosen);
    assert.equal((await read(page)).planner.instances.length,0);
    await page.getByRole('button',{name:'接受，加入手牌'}).click();await waitData(page,d=>d.planner.instances.length===1);
    await combo(page,(await read(page)).dailyCopies[0].id);await select.selectOption(chosen);await page.getByRole('button',{name:'接受，加入手牌'}).click();
    const d=await waitData(page,d=>d.planner.instances.length===2);assert.notEqual(d.planner.instances[0].id,d.planner.instances[1].id);
    assert.equal(d.planner.instances[0].currentContent.title,`阅读《${title}》`);assert.equal(d.planner.instances[0].daily.sourceDate,s.today);
    return {independentInstances:2,sourceDate:s.today};
  });
  await test('sphere-two-keyboard-steps-fix-clicked-copy-no-front-leak-or-write',async page=>{
    await seed(page,{secondAction:true});await page.goto(origin);await hand(page);await page.getByRole('button',{name:'球面抽卡',exact:true}).click();
    const sphere=page.getByRole('dialog',{name:'卡球面'});await sphere.waitFor();
    assert.equal(await sphere.locator('strong').count(),0);
    const card=sphere.locator('.sphere-card').nth(1),id=await card.getAttribute('data-card-id');
    await card.focus();await page.keyboard.press('Enter');assert.equal(await sphere.locator('.is-chosen .sphere-card').getAttribute('data-card-id'),id);
    assert.equal(await sphere.locator('strong').count(),0);await page.keyboard.press('Enter');
    assert.equal(await sphere.locator('.is-chosen .sphere-card').getAttribute('data-card-id'),id);assert.equal(await sphere.locator('strong').count(),1);
    for(let i=0;i<12;i++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('[role="dialog"]')),true);}
    await page.keyboard.press('Escape');assert.equal(await sphere.count(),0);assert.equal((await read(page)).planner.instances.length,0);
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),'球面抽卡');return {clickedId:id};
  });
  await test('slot-sphere-cancel-preserves-combo-and-manual-book-is-exact',async page=>{
    const s=await seed(page);await page.goto(origin);await hand(page);await combo(page,s.data.dailyCopies[0].id);
    await page.getByRole('button',{name:'从球面选书名'}).click();await page.keyboard.press('Escape');
    assert.equal(await page.getByLabel('书名选择').inputValue(),'');assert.equal(await page.getByRole('heading',{name:'组合行动'}).count(),1);
    await page.getByRole('button',{name:'从球面选书名'}).click();const sphere=page.getByRole('dialog',{name:'卡球面'});
    const card=sphere.locator('.sphere-card').first(),id=await card.getAttribute('data-card-id');await card.focus();await page.keyboard.press('Enter');await page.keyboard.press('Enter');
    await sphere.getByRole('button',{name:'使用这本书'}).click();await sphere.waitFor({state:'detached'});
    assert.equal(await page.getByLabel('书名选择').inputValue(),`book:${id}`);assert.equal((await read(page)).planner.instances.length,0);
    await page.getByRole('button',{name:'接受，加入手牌'}).click();const d=await waitData(page,d=>d.planner.instances.length===1);
    assert.equal(d.planner.instances[0].daily.slotSelections[0].entryId,id);return {entryId:id};
  });
  await test('workshop-matrix-sphere-foreground-edit-and-return',async page=>{
    await seed(page);await page.goto(origin);await page.locator('nav').getByRole('button',{name:'制卡工坊'}).click();await page.getByRole('tab',{name:'卡池',exact:true}).click();
    await page.getByRole('button',{name:/^书目池/}).click();await page.getByRole('button',{name:/展开当前牌堆/}).click();
    const sphere=page.getByRole('dialog',{name:'卡球面'});assert.equal(await page.locator('.matrix-board.is-paused').count(),1);
    const card=sphere.locator('.sphere-card').first(),id=await card.getAttribute('data-card-id');await card.focus();await page.keyboard.press('Enter');
    assert.equal(await sphere.locator('.sphere-world').evaluate(el=>getComputedStyle(el).animationPlayState),'paused');
    await sphere.getByLabel('书名',{exact:true}).fill('球面编辑保存');await sphere.getByRole('button',{name:'保存',exact:true}).click();
    await waitData(page,d=>d.bookEntries.some(b=>b.id===id&&b.title==='球面编辑保存'));
    await sphere.getByRole('button',{name:'卡片归位'}).click();assert.equal(await sphere.locator('.is-chosen').count(),0);
    await sphere.getByRole('button',{name:'关闭归位'}).click();assert.equal(await page.locator('.matrix-board.is-paused').count(),0);
    return {edited:id};
  });
  await test('dated-hand-stack-expands-and-withdraws-only-one-member',async page=>{
    const s=await seed(page,{days:[-2,0],accepts:2});await page.goto(origin);await hand(page);await page.getByRole('tab',{name:/^手牌（/}).click();
    assert.equal(await page.getByText('×4',{exact:true}).count(),1);await page.getByText('展开 4 份独立手牌',{exact:true}).click();
    const members=page.locator('.hand-stack-member');assert.equal(await members.count(),4);
    assert.ok((await members.allTextContents()).some(t=>t.includes(s.dates[0])));
    const removed=await members.first().getAttribute('data-instance-id');await members.first().getByRole('button',{name:'撤出'}).click();
    const d=await waitData(page,d=>d.planner.handOrder.length===3);assert.equal(d.planner.handOrder.includes(removed),false);
    assert.equal(d.planner.instances.length,4);assert.equal(d.planner.instances.find(i=>i.id===removed).daily.sourceDate,s.dates[0]);
    await page.getByRole('button',{name:'当日',exact:true}).click();await page.getByRole('button',{name:'展开 3 份',exact:true}).click();
    assert.equal(await page.locator('.fan-card').count(),3);return {remaining:3,withdrawn:removed};
  });
  await test('archive-ui-keeps-facts-annotations-and-retracted-plan',async page=>{
    const s=await seed(page,{days:[-7],accepts:2,archive:true});await page.goto(origin);await hand(page);
    const d=await waitData(page,d=>d.archiveLogs.length===1);assert.deepEqual(d.planner.facts,s.data.planner.facts);assert.deepEqual(d.planner.annotations,s.data.planner.annotations);
    assert.equal(d.planner.handOrder.length,0);assert.equal(d.planner.plans.filter(p=>p.status==='retracted').length,1);
    await page.getByRole('tab',{name:'归档日志',exact:true}).click();await page.locator('.hand-archive summary').click();
    assert.equal(await page.getByText(/到期也要保留的批注/).count(),1);assert.equal(await page.getByText(/^已撤销排期：/).count(),1);
    await page.getByRole('tab',{name:/^手牌（/}).click();assert.equal(await page.getByRole('button',{name:'放回手牌'}).count(),0);return {logs:d.archiveLogs.length,facts:d.planner.facts.length};
  });
  await test('manual-backfill-ui-today-only-and-expired-future-rejection',async page=>{
    const s=await seed(page,{days:[]});await page.goto(origin);await hand(page);await waitData(page,d=>d.dailyCopies.length===1);
    await page.getByText('手动补生成漏日',{exact:true}).click();await page.getByLabel('补生成规则').selectOption('daily-reading');
    const yesterday=await page.evaluate(async today=>(await import('/src/daily/time.ts')).nextDate(today,-1),s.today);
    await page.getByLabel('补生成来源日期').fill(yesterday);await page.getByRole('button',{name:'补生成这一天'}).click();await waitData(page,d=>d.dailyCopies.length===2);
    for(const offset of [1,-7]){
      const date=await page.evaluate(async({today,offset})=>(await import('/src/daily/time.ts')).nextDate(today,offset),{today:s.today,offset});
      await page.getByLabel('补生成来源日期').fill(date);await page.getByRole('button',{name:'补生成这一天'}).click();await page.locator('.production-draw [role="alert"]').waitFor();
      assert.equal((await read(page)).dailyCopies.length,2);
    }return {sourceDates:(await read(page)).dailyCopies.map(c=>c.sourceDate)};
  });
  await test('external-save-invalidates-combo-without-silent-book-replacement',async(page,context)=>{
    const s=await seed(page);await page.goto(origin);await hand(page);await combo(page,s.data.dailyCopies[0].id);await page.getByLabel('书名选择').selectOption('book:book-1');
    const other=await context.newPage();await other.goto(origin+'/__seed');await other.evaluate(async()=>{
      const {createWorkspaceClient}=await import('/src/workspace/client.ts'),{createWorkspaceStore}=await import('/src/workspace/store.ts');const client=createWorkspaceClient({store:createWorkspaceStore()});
      const loaded=await client.load(),book=loaded.value.data.bookEntries[0];const r=await client.submit({commandId:crypto.randomUUID(),expected:loaded.value.token,type:'SaveBookEntry',payload:{bookEntry:{...book,version:book.version+1,status:'archived'},expectedVersion:book.version}});
      if(!r.ok)throw Error(JSON.stringify(r));client.close();
    });await page.getByText('工作区已更新，抽卡草稿已失效，请重新选择。',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'接受，加入手牌'}).count(),0);assert.equal((await read(page)).planner.instances.length,0);
    await combo(page,(await read(page)).dailyCopies[0].id);assert.equal(await page.getByLabel('书名选择').inputValue(),'');
    assert.equal(await page.getByLabel('书名选择').locator('option[value="book:book-1"]').count(),0);return {invalidated:true};
  });
  for(const width of [320,390,720])await test(`responsive-${width}-random-and-modal-accessible`,async page=>{
    const s=await seed(page);await page.goto(origin);await hand(page);await combo(page,s.data.dailyCopies[0].id);
    await page.getByLabel('书名选择').selectOption('random');await page.getByRole('button',{name:'从球面选书名'}).click();
    const sphere=page.getByRole('dialog',{name:'卡球面'});await sphere.waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    const box=await sphere.boundingBox();assert.ok(box.x>=-1&&box.x+box.width<=width+1);
    await page.screenshot({path:path.join(output,`responsive-${width}.png`),fullPage:true});return {width};
  },{viewport:{width,height:860},reducedMotion:'reduce'});
  await test('dropdown-ten-stable-options-random-draws-from-full-pool',async page=>{
    const s=await seed(page,{books:100});
    await page.addInitScript(()=>{const original=crypto.getRandomValues.bind(crypto);crypto.getRandomValues=values=>
      values instanceof Uint32Array?values.fill(99):original(values);});
    await page.goto(origin);await hand(page);await combo(page,s.data.dailyCopies[0].id);
    const picker=page.getByLabel('书名选择'),options=picker.locator('option[value^="book:"]');
    await options.first().waitFor({state:'attached'});
    const initial=await options.evaluateAll(nodes=>nodes.map(node=>node.value));
    assert.equal(initial.length,9);assert.equal(new Set(initial).size,9);assert.ok(!initial.includes('book:book-100'));
    assert.equal(await picker.locator('option:not([hidden])').count(),10);
    assert.equal(await picker.inputValue(),'');assert.equal((await read(page)).planner.instances.length,0);
    await page.getByRole('button',{name:'从球面选书名'}).click();await page.getByRole('dialog',{name:'卡球面'}).waitFor();await page.keyboard.press('Escape');
    assert.deepEqual(await options.evaluateAll(nodes=>nodes.map(node=>node.value)),initial);
    await picker.selectOption('random');await page.getByText('已固定：书目100',{exact:true}).waitFor();
    assert.equal(await picker.inputValue(),'book:book-100');assert.equal(await options.count(),9);
    assert.deepEqual((await options.evaluateAll(nodes=>nodes.map(node=>node.value))).slice(0,8),initial.slice(0,8));
    assert.equal((await read(page)).planner.instances.length,0);
    return {displayed:10,fullPool:100,randomSelected:'book-100',noImplicitAcceptance:true};
  });
  await test('pool-full-100-blocks-101st-member-until-a-place-is-freed',async page=>{
    await seed(page,{books:101,poolMembers:100});await page.goto(origin);
    await page.locator('nav').getByRole('button',{name:'制卡工坊'}).click();await page.getByRole('tab',{name:'卡池',exact:true}).click();
    const row=page.locator('.action-list-row',{hasText:'书目池'});
    await row.getByRole('button',{name:'编辑',exact:true}).click();
    assert.equal(await page.getByRole('checkbox',{name:'书目101',exact:true}).isDisabled(),true);
    await page.getByRole('checkbox',{name:'书目100',exact:true}).uncheck();await page.getByRole('checkbox',{name:'书目101',exact:true}).check();
    assert.equal((await read(page)).pools.find(pool=>pool.id==='books').memberIds.includes('book-101'),false,'editing the draft does not save');
    await page.getByRole('button',{name:'保存',exact:true}).click();
    const replaced=await waitData(page,d=>d.pools.find(pool=>pool.id==='books').memberIds.includes('book-101'));
    assert.equal(replaced.pools.find(pool=>pool.id==='books').memberIds.length,100);
    await page.reload();await page.locator('nav').getByRole('button',{name:'制卡工坊'}).click();await page.getByRole('tab',{name:'卡池',exact:true}).click();
    await row.getByRole('button',{name:'编辑',exact:true}).click();
    assert.equal(await page.getByRole('checkbox',{name:'书目100',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('checkbox',{name:'书目101',exact:true}).isChecked(),true);
    return {members:100,blocked101st:true,explicitSave:true};
  });
  for(const count of [10,100])await test(`production-capacity-${count}-static-book-selection`,async page=>{
    const s=await seed(page,{books:count});await page.goto(origin);await hand(page);await combo(page,s.data.dailyCopies[0].id);
    await page.getByLabel('书名选择').locator('option[value^="book:"]').first().waitFor({state:'attached'});
    assert.equal(await page.getByLabel('书名选择').locator('option[value^="book:"]').count(),9);
    assert.equal(await page.getByLabel('书名选择').locator('option:not([hidden])').count(),10);
    await page.getByRole('button',{name:'从球面选书名'}).click();const sphere=page.getByRole('dialog',{name:'卡球面'});
    await sphere.waitFor();
    assert.equal(await sphere.locator('.sphere-card').count(),count);assert.equal(await sphere.locator('strong').count(),0);
    const card=sphere.locator(`.sphere-card[data-card-id="book-${count}"]`);await card.focus();await page.keyboard.press('Enter');await page.keyboard.press('Enter');
    await sphere.getByRole('button',{name:'使用这本书'}).click();await sphere.waitFor({state:'detached'});
    assert.equal(await page.getByLabel('书名选择').inputValue(),`book:book-${count}`);
    assert.equal(await page.getByLabel('书名选择').locator('option[value^="book:"]').count(),9);
    return {count,dropdownCapacity:10,fullSphere:true};
  },{reducedMotion:'reduce'});
  await test('offline-shell-update-keeps-idb-and-current-build-reopens',offlineUpdate,{serviceWorkers:'allow'});
  await test('offline-shell-late-observer-keeps-idb-and-current-build-reopens',
    (page,context)=>offlineUpdate(page,context,{observerDelayMs:250}),{serviceWorkers:'allow'});
  activationDelayMs=1500;
  await test('offline-shell-delayed-activation-keeps-idb-and-current-build-reopens',offlineUpdate,{serviceWorkers:'allow'});
}finally{
  previousShell=false;activationDelayMs=0;await fs.writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2));
  await browser?.close();await server.close();
}
const failures=results.filter(r=>r.status!=='pass');console.log(`v0.3 production browser: ${results.length-failures.length}/${results.length}; evidence ${output}`);
if(failures.length)process.exitCode=1;
