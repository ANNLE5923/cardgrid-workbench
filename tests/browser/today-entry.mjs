// Built app, real IndexedDB and named commands. Every case owns a fresh synthetic context.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root=fileURLToPath(new URL('../../',import.meta.url));
const output=path.join(process.env.CARDGRID_BROWSER_OUTPUT_ROOT||path.join(root,'test-results'),'today-entry');
await fs.mkdir(output,{recursive:true});
const {chromium}=await import(process.env.CARDGRID_PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({root,configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0},
  optimizeDeps:{noDiscovery:true,entries:[],include:['@js-temporal/polyfill','jsbi']},plugins:[{name:'today-built-shell',configureServer(vite){
    vite.middlewares.use(async(req,res,next)=>{
      const url=(req.url||'').split('?')[0],file=url==='/'?'index.html':url.slice(1);
      if(url==='/__seed'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Synthetic fixture only</title>');return;}
      if(file!=='index.html'&&!/^assets\/[^/]+\.(js|css)$/.test(file))return next();
      try{const body=await fs.readFile(path.join(root,'dist',file));res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(body);}catch(error){next(error);}
    });
  }}]});
await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.CARDGRID_CHROME_PATH?{executablePath:process.env.CARDGRID_CHROME_PATH}:{})});
const results=[];
const button=(page,name)=>page.getByRole('button',{name,exact:true});
const nav=(page,name)=>page.locator('nav').getByRole('button',{name});
const raw=page=>page.evaluate(async()=>{
  const {createWorkspaceStore}=await import('/src/workspace/store.ts');const store=createWorkspaceStore();
  try{return {current:(await store.read())??null,recovery:await store.readRecovery()};}finally{store.close();}
});
async function ready(page){await page.locator('.dial-svg').waitFor();await page.getByLabel('日期',{exact:true}).waitFor();}
async function check(name,fn,viewport={width:1280,height:900}){
  const context=await browser.newContext({timezoneId:'Asia/Shanghai',serviceWorkers:'block',viewport}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(error.message));
  await page.clock.install({time:new Date('2026-10-05T01:00:00Z')});
  try{const detail=await fn(page);assert.deepEqual(errors,[]);results.push({name,status:'pass',detail});console.log('PASS',name);}
  catch(error){results.push({name,status:'fail',error:error.stack,errors});console.error('FAIL',name,error);await page.screenshot({path:path.join(output,`failure-${name}.png`),fullPage:true}).catch(()=>{});}
  finally{await context.close();}
}
async function seed(page){
  await page.goto(origin+'/__seed');
  return page.evaluate(async()=>{
    const {createWorkspaceClient}=await import('/src/workspace/client.ts'),fx=await import('/tests/modules/workshop/a1-fixtures.ts');
    const client=createWorkspaceClient({now:()=>new Date().toISOString()});
    const ok=result=>{if(!result.ok)throw Error(JSON.stringify(result));return result.value;};
    const submit=async(type,payload)=>ok(await client.submit({commandId:crypto.randomUUID(),expected:ok(await client.load()).token,type,payload}));
    try{
      await submit('SaveActionCard',{actionCard:fx.actionCard({id:'today-card',slots:[],content:{...fx.actionCard().content,title:'Today 入口行动'}}),expectedVersion:null});
      await submit('SaveGenerationRule',{generationRule:fx.rule({actionCardId:'today-card',startDate:'2026-10-05'}),expectedVersion:null});
      await submit('GenerateDailyCopies',{target:'current'});
      return ok(await client.load()).data.dailyCopies[0].id;
    }finally{client.close();}
  });
}
try{
  await check('today-default-browsing-is-readonly-and-prepare-is-explicit',async page=>{
    await page.goto(origin);await ready(page);assert.equal(await nav(page,'Today').getAttribute('aria-current'),'page');
    assert.equal(await page.getByRole('group',{name:'旧版页面只读'}).count(),0);
    const before=await raw(page);assert.equal(before.current,null);
    await page.getByLabel('日期',{exact:true}).fill('2026-10-06');await page.getByText('当天没有已排计划。',{exact:true}).waitFor();
    await nav(page,'Schedule').click();await nav(page,'Today').click();await ready(page);
    assert.equal(await page.getByLabel('日期',{exact:true}).inputValue(),'2026-10-06');assert.deepEqual(await raw(page),before);
    await button(page,'准备这一天').click();await page.getByRole('status').filter({hasText:'已保存到本机'}).waitFor();
    const prepared=await raw(page);assert.equal(prepared.current.data.planner.days.length,1);assert.equal(prepared.current.data.planner.days[0].date,'2026-10-06');
    assert.equal(prepared.current.data.planner.instances.length,0);assert.equal(prepared.current.data.planner.facts.length,0);
    return {defaultFormalToday:true,readingDoesNotWrite:true,explicitPreparation:true};
  });
  for(const width of [1280,320])await check(`today-draw-return-plan-actual-annotation-${width}`,async page=>{
    const copyId=await seed(page);await page.goto(origin);await ready(page);
    await page.getByLabel('日期',{exact:true}).fill('2026-10-06');await page.getByLabel('时区',{exact:true}).fill('UTC');await page.getByLabel('默认落点',{exact:true}).fill('10:15');
    await button(page,'去抽卡').click();await page.getByLabel('手选库存副本').selectOption(copyId);
    await button(page,'翻开查看').click();await button(page,'准备接受').click();await button(page,'接受，加入手牌').click();
    await button(page,'返回 Today 安排').click();await ready(page);
    assert.equal(await nav(page,'Today').getAttribute('aria-current'),'page');assert.equal(await page.getByLabel('日期',{exact:true}).inputValue(),'2026-10-06');
    assert.equal(await page.getByLabel('时区',{exact:true}).inputValue(),'UTC');assert.equal(await page.getByLabel('默认落点',{exact:true}).inputValue(),'10:15');
    const accepted=(await raw(page)).current.data;assert.equal(accepted.planner.instances.length,1);assert.equal(accepted.planner.plans.length,0);assert.equal(accepted.planner.facts.length,0);
    assert.equal(accepted.planner.instances[0].daily.sourceDate,'2026-10-05');
    await page.locator('.fan-card').getByRole('button',{name:'打出',exact:true}).click();const placement=page.getByRole('dialog',{name:'排期与重叠确认'});
    await placement.locator('.flow-candidate.valid').first().waitFor();await button(placement,'确认排期').click();await placement.waitFor({state:'detached'});
    let data=(await raw(page)).current.data;assert.equal(data.planner.plans[0].range.localStart,'2026-10-06T10:15');assert.equal(data.planner.plans[0].range.zone,'UTC');
    await button(page,'确认实际').click();const actual=page.getByRole('dialog',{name:'确认实际发生'});await actual.locator('.flow-actualrange').waitFor();
    await actual.getByLabel('开始时间',{exact:true}).fill('10:17');await actual.getByLabel('结束时间',{exact:true}).fill('10:42');await button(actual,'确认实际').click();await actual.waitFor({state:'detached'});
    const input=page.getByLabel('为 Today 入口行动 添加批注');await input.fill('Today 完整路径验证');await button(page,'添加批注').click();await page.getByText('Today 完整路径验证',{exact:true}).waitFor();
    data=(await raw(page)).current.data;assert.equal(data.planner.facts.length,1);assert.equal(data.planner.facts[0].actualRange.localStart,'2026-10-06T10:17');
    assert.equal(data.planner.facts[0].actualRange.localEnd,'2026-10-06T10:42');assert.equal(data.planner.annotations.length,1);
    await page.screenshot({path:path.join(output,`today-${width}.png`),fullPage:true});
    const before=await raw(page);await page.reload();await ready(page);await page.getByLabel('日期',{exact:true}).fill('2026-10-06');await page.getByLabel('时区',{exact:true}).fill('UTC');
    await page.getByText('Today 完整路径验证',{exact:true}).waitFor();assert.deepEqual(await raw(page),before);
    return {returnedManualContext:true,sourceDayPreserved:true,actualMinutePrecision:true,factAndAnnotationPersist:true};
  },{width,height:900});
  await check('today-workspace-replacement-discards-old-browsing-session',async page=>{
    await page.goto(origin);await ready(page);await page.getByLabel('日期',{exact:true}).fill('2001-01-01');await page.getByLabel('时区',{exact:true}).fill('UTC');await page.getByLabel('默认落点',{exact:true}).fill('07:15');
    await button(page,'去抽卡').click();await page.getByRole('button',{name:'当日',exact:true}).click();await ready(page);assert.equal(await page.getByLabel('日期',{exact:true}).inputValue(),'2001-01-01');
    await page.evaluate(async()=>{
      const {createWorkspaceClient}=await import('/src/workspace/client.ts'),client=createWorkspaceClient();
      const ok=result=>{if(!result.ok)throw Error(JSON.stringify(result));return result.value;};
      try{const backup=ok(await client.prepareBackup());ok(await client.submit({commandId:crypto.randomUUID(),expected:ok(await client.load()).token,type:'ClearWorkspace',payload:{backup:{token:backup.token,dataFingerprint:backup.dataFingerprint,fileSavedConfirmed:true},discardDraftsConfirmed:true}}));}finally{client.close();}
    });
    await page.getByRole('status').filter({hasText:'工作区已被替换'}).waitFor();await ready(page);
    await page.waitForFunction(()=>document.querySelector('[aria-label="日期"]').value==='2026-10-05');
    assert.notEqual(await page.getByLabel('默认落点',{exact:true}).inputValue(),'07:15');
    await button(page,'去抽卡').click();await page.getByRole('button',{name:'当日',exact:true}).click();await ready(page);assert.equal(await page.getByLabel('日期',{exact:true}).inputValue(),'2026-10-05');
    return {shortcutReturnsToToday:true,epochResetsSession:true};
  });
}finally{await browser.close();await server.close();await fs.writeFile(path.join(output,'results.json'),JSON.stringify({at:new Date().toISOString(),results},null,2));console.log('Evidence:',output);}
console.log(`Today entry: ${results.filter(result=>result.status==='pass').length}/${results.length}`);
if(results.some(result=>result.status==='fail'))process.exitCode=1;
