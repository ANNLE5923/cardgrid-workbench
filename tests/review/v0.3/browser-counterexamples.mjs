import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const out = process.env.CARDGRID_INDEPENDENT_OUTPUT || fileURLToPath(new URL('./browser-evidence/', import.meta.url));
await fs.mkdir(out, {recursive: true});
const server = await createServer({root, configFile: false, logLevel: 'error', server: {host: '127.0.0.1', port: 0},
  optimizeDeps: {noDiscovery: true, entries: [], include: ['@js-temporal/polyfill', 'jsbi']},
  plugins: [{name: 'independent-acceptance-only', configureServer(v) {v.middlewares.use(async (req, res, next) => {
    if (req.url === '/__independent-api') {res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Independent acceptance</title>');}
    else if (req.url === '/__independent-built' || /^\/assets\/[^/]+\.(js|css)$/.test(req.url || '')) {
      try {const relative = req.url === '/__independent-built' ? 'index.html' : req.url.slice(1);
        res.setHeader('Content-Type', relative.endsWith('.html') ? 'text/html' : relative.endsWith('.js') ? 'text/javascript' : 'text/css');
        res.end(await fs.readFile(path.join(root, 'dist', relative)));} catch (error) {next(error);}
    } else next();
  });}}]});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({headless: true, executablePath: process.env.CARDGRID_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
const results = [];
async function pageIn(context, name = 'cardgrid-independent-v03', clockAt = null) {
  const p = await context.newPage();
  if (clockAt) {await p.clock.install({time:new Date(clockAt)}); await p.clock.pauseAt(new Date(new Date(clockAt).getTime()+1000));}
  await p.goto(origin + '/__independent-api');
  await p.evaluate(async name => {
    const {createWorkspaceStore} = await import('/src/workspace/store.ts'), {createWorkspaceClient} = await import('/src/workspace/client.ts');
    const base = createWorkspaceStore({name}); let at = '2026-10-03T03:00:00Z', lose = false, sequence = 0;
    const store = {...base, async atomic(reduce) {const result = await base.atomic(reduce); if (lose) {lose = false; throw new Error('independent lost reply');} return result;}};
    const client = createWorkspaceClient({store, now: () => at, random: () => 0, id: () => `ind-browser-${++sequence}-${crypto.randomUUID()}`});
    const ok = r => {if (!r.ok) throw new Error(JSON.stringify(r)); return r.value;};
    const token = async () => ok(await client.load()).token;
    const command = async (type, payload) => ({type, payload, expected: await token(), commandId: crypto.randomUUID()});
    const send = async (type, payload) => ok(await client.submit(await command(type, payload)));
    const data = async () => ok(await client.load()).data;
    const content = title => ({title, criteria:'读一章', presetMinutes:30,color:'#447755',categoryId:null,categoryLabel:null,minimum:false,
      projectIds:[],goalIds:[],projectLabels:[],goalLabels:[]});
    const action = (id, title, slot = true) => ({id,version:1,kind:'action',content:content(title),slots:slot ? [{id:'ind-slot',label:'书名',poolId:'ind-book-pool',required:true,valueKind:'entry'}] : [],status:'active',parentId:null,source:{kind:'manual'}});
    const rule = id => ({id:'rule-'+id,version:1,name:'独立规则 '+id,actionCardId:id,schedule:{mode:'daily'},startDate:'2026-10-03',zone:'Asia/Shanghai',status:'active',source:{kind:'manual'}});
    globalThis.ind = {client, store, ok, token, command, send, data, external:0, setNow(value) {at = value;}, loseNext() {lose = true;},
      snapshot: async () => ({raw: await store.read(), recovery: await store.readRecovery()}),
      async setup(two = false) {
        for (const [id,title] of [['ind-book-a','独立书甲'],['ind-book-b','独立书乙']]) await send('SaveBookEntry',{bookEntry:{id,version:1,kind:'book',title,author:null,status:'active',source:{kind:'manual'}},expectedVersion:null});
        await send('SavePool',{pool:{id:'ind-book-pool',version:1,name:'独立书目池',poolKind:'book',parentPoolId:null,memberIds:['ind-book-a','ind-book-b'],source:{kind:'manual'}},expectedVersion:null});
        await send('SaveActionCard',{actionCard:action('ind-reading','阅读《{书名}》'),expectedVersion:null});
        await send('SaveGenerationRule',{generationRule:rule('ind-reading'),expectedVersion:null});
        if (two) {await send('SaveActionCard',{actionCard:action('ind-walk','独立散步',false),expectedVersion:null}); await send('SaveGenerationRule',{generationRule:rule('ind-walk'),expectedVersion:null});}
      },
      async generate() {await send('GenerateDailyCopies',{target:'current'}); return (await data()).dailyCopies.at(-1);},
      async acceptCommand(copyId) {
        const copy = (await data()).dailyCopies.find(c => c.id === copyId) || (await data()).dailyCopies[0], ref = {id:copy.id,version:copy.version};
        const selections = copy.slotSpecSnapshot.length ? [ok(await client.selectEntry({token:await token(),copy:ref,slotId:'ind-slot',choice:{mode:'manual',entryId:'ind-book-a'}})).selection] : [];
        const preview = ok(await client.previewCombo({token:await token(),copy:ref,selections}));
        return command('AcceptDailyCopy',{copy:ref,selections,composedText:preview.composedText});
      },
      async accept(copyId) {return ok(await client.submit(await ind.acceptCommand(copyId)));},
      async abortOnce(command) {
        const before = await ind.snapshot(), put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(...args) {const request = put.apply(this,args); if (this.name === 'workspace') this.transaction.abort(); return request;};
        let failure; try {failure = await client.submit(command);} finally {IDBObjectStore.prototype.put = put;}
        const after = await ind.snapshot(); return {before,after,failure};
      },
    };
    store.subscribe(external => {if (external) ind.external++;});
  }, name);
  return p;
}
async function readUI(page) {
  return page.evaluate(async () => {const {createWorkspaceClient} = await import('/src/workspace/client.ts'); const client = createWorkspaceClient();
    try {const result = await client.load(); if (!result.ok) throw new Error(JSON.stringify(result)); return result.value.data;} finally {client.close();}});
}
async function seedUI(context, two = false, days = [5]) {
  await context.addInitScript(() => {const RealDate = Date, fixed = RealDate.parse('2026-10-05T04:00:00Z');
    class FixedDate extends RealDate {constructor(...args) {super(...(args.length ? args : [fixed]));} static now() {return fixed;}}
    globalThis.Date = FixedDate;
  });
  const page = await pageIn(context,'cardgrid-workspace');
  await page.evaluate(async ({two, days}) => {await ind.setup(two); for (const day of days) {ind.setNow(`2026-10-${String(day).padStart(2,'0')}T03:00:00Z`); await ind.generate();}}, {two,days});
  await page.goto(origin + '/__independent-built'); await page.getByRole('button',{name:/抽卡手牌/}).click();
  await page.getByRole('heading',{name:'每日库存抽卡',exact:true}).waitFor();
  await page.getByRole('button',{name:'更新今日库存',exact:true}).waitFor({state:'visible'});
  return page;
}
async function check(name, run, options = {}) {
  const context = await browser.newContext({timezoneId:'Asia/Shanghai',serviceWorkers:'block',...options}); const started = Date.now();
  const pageErrors = []; context.on('page',page=>page.on('pageerror',error=>pageErrors.push(error.message)));
  try {const detail = await run(context); assert.deepEqual(pageErrors,[],'No uncaught page errors are allowed');
    results.push({name,status:'pass',durationMs:Date.now()-started,detail}); console.log('PASS',name);}
  catch (error) {const page = context.pages().at(-1); if (page) await page.screenshot({path:path.join(out,`${name}-failed.png`),fullPage:true}).catch(()=>{});
    results.push({name,status:'fail',error:error.stack}); console.error('FAIL',name,error.message);}
  finally {await context.close();}
}
try {
  await check('I-V03-01-real-idb-accept-and-archive-abort-are-atomic', async context => {
    const p = await pageIn(context);
    const details = await p.evaluate(async () => {
      await ind.setup(); await ind.generate(); const accept = await ind.acceptCommand(), aborted = await ind.abortOnce(accept);
      const retry = await ind.client.submit(accept); const replay = await ind.client.submit(accept);
      ind.setNow('2026-10-10T03:00:00Z'); const archive = await ind.command('ArchiveDueCopies',{}), archiveAbort = await ind.abortOnce(archive);
      const archiveRetry = await ind.client.submit(archive); return {aborted,retry,replay,archiveAbort,archiveRetry,final:await ind.data()};
    });
    assert.equal(details.aborted.failure.code,'STORAGE_FAILED'); assert.deepEqual(details.aborted.before,details.aborted.after);
    assert.equal(details.retry.ok,true); assert.equal(details.replay.value.replayed,true); assert.equal(details.archiveAbort.failure.code,'STORAGE_FAILED');
    assert.deepEqual(details.archiveAbort.before,details.archiveAbort.after); assert.equal(details.archiveRetry.ok,true);
    assert.equal(details.final.planner.instances.length,1); assert.equal(details.final.archiveLogs.length,1); assert.equal(details.final.dailyCopies.length,0);
    return {acceptAbort:true,archiveAbort:true,receipts:details.final.commandReceipts.length};
  });
  await check('I-V03-02-two-pages-reject-stale-and-lost-reply-does-not-duplicate', async context => {
    const one = await pageIn(context,'independent-two-pages'); await one.evaluate(async()=>{await ind.setup();await ind.generate();});
    const two = await pageIn(context,'independent-two-pages');
    const a = await one.evaluate(()=>ind.acceptCommand()), b = await two.evaluate(()=>ind.acceptCommand());
    const first = await one.evaluate(async command=>{ind.loseNext();return ind.client.submit(command);},a);
    assert.equal(first.code,'STORAGE_FAILED'); const second = await two.evaluate(command=>ind.client.submit(command),b); assert.equal(second.code,'REVISION_CONFLICT');
    const retry = await two.evaluate(command=>ind.client.submit(command),a); assert.equal(retry.value.replayed,true);
    const after = await two.evaluate(()=>ind.data()); assert.equal(after.planner.instances.length,1);
    return {stale:second.code,replayed:retry.value.replayed,instances:after.planner.instances.length};
  });
  await check('I-V03-03-production-selector-fixes-choice-immediately-and-cancel-writes-no-action', async context => {
    const page = await seedUI(context); await page.getByRole('button',{name:'抽今天的一张',exact:true}).click();
    await page.getByRole('button',{name:'翻开查看',exact:true}).click(); await page.getByRole('button',{name:'填写槽位',exact:true}).click();
    const picker = page.getByRole('combobox',{name:'书名选择',exact:true}); await picker.waitFor();
    assert.equal(await picker.inputValue(),''); assert.equal((await readUI(page)).planner.instances.length,0);
    const options = await picker.locator('option').evaluateAll(items=>items.filter(i=>!i.disabled).map(i=>({value:i.value,text:i.textContent})));
    assert.equal(options[0].value,'random'); await picker.selectOption('random');
    await page.waitForFunction(()=>document.querySelector('[aria-label="书名选择"]')?.value.startsWith('book:'));
    const fixed = await picker.inputValue(); assert.match(fixed,/^book:ind-book-[ab]$/);
    await page.getByRole('button',{name:'从球面选书名',exact:true}).click(); await page.getByRole('button',{name:'关闭归位',exact:true}).click();
    assert.equal(await picker.inputValue(),fixed); await page.getByRole('button',{name:'取消本次抽卡',exact:true}).click();
    assert.equal((await readUI(page)).planner.instances.length,0); return {randomFirst:true,fixed,cancelInstances:0};
  });
  await check('I-V03-04-production-sphere-locks-exact-card-and-keyboard-escape-restores-trigger', async context => {
    const page = await seedUI(context,true); const before = await readUI(page), trigger = page.getByRole('button',{name:'球面抽卡',exact:true});
    await trigger.click(); const dialog = page.getByRole('dialog',{name:'卡球面'}); await dialog.waitFor();
    await dialog.getByRole('button',{name:'静止列表',exact:true}).click();
    assert.equal(await dialog.getByText('独立散步',{exact:true}).count(),0); assert.equal(await dialog.getByText('阅读《{书名}》',{exact:true}).count(),0);
    const card = dialog.locator('button.sphere-card').nth(1); const id = await card.getAttribute('data-card-id'); await card.focus(); await page.keyboard.press('Enter');
    assert.equal(await dialog.locator('.sphere-presented button').getAttribute('data-card-id'),id);
    assert.equal(await dialog.getByText('独立散步',{exact:true}).count(),0); assert.equal(await dialog.getByText('阅读《{书名}》',{exact:true}).count(),0);
    await page.keyboard.press('Enter'); const chosen = before.dailyCopies.find(c=>c.id===id); await dialog.getByText(chosen.contentSnapshot.title,{exact:true}).waitFor();
    assert.equal(await dialog.locator('.sphere-presented button').getAttribute('data-card-id'),id); await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'});
    assert.equal(await trigger.evaluate(el=>document.activeElement===el),true);
    assert.equal((await readUI(page)).planner.instances.length,0); return {id,front:chosen.contentSnapshot.title,cancelInstances:0};
  });
  await check('I-V03-05-320px-reduced-motion-uses-static-two-step-list-and-no-overflow', async context => {
    const page = await seedUI(context,true); await page.getByRole('button',{name:'球面抽卡',exact:true}).click(); const dialog = page.getByRole('dialog',{name:'卡球面'}); await dialog.waitFor();
    assert.equal(await dialog.locator('.sphere-stage.is-list').count(),1); const count = await dialog.locator('button.sphere-card').count(); assert.equal(count,2);
    const card = dialog.locator('button.sphere-card').first(); await card.focus(); await page.keyboard.press('Enter');
    const presented = dialog.locator('.sphere-presented button'); assert.match(await presented.getAttribute('aria-label'),/未翻开/);
    await page.keyboard.press('Enter'); assert.doesNotMatch(await presented.getAttribute('aria-label'),/未翻开/);
    const dimensions = await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth})); assert.ok(dimensions.scroll<=dimensions.width+1,JSON.stringify(dimensions));
    await page.keyboard.press('Escape'); return {staticList:true,count,...dimensions};
  }, {viewport:{width:320,height:800},reducedMotion:'reduce'});
  await check('I-V03-06-distinct-source-dates-stack-as-display-only-and-one-withdraw-leaves-other-instances', async context => {
    const page = await seedUI(context,false,[3,4,5]);
    // Use the production dropdown and acceptance UI for three independent source dates.
    const copies = (await readUI(page)).dailyCopies;
    for (const copy of copies) {
      await page.getByRole('combobox',{name:'手选库存副本',exact:true}).selectOption(copy.id);
      await page.getByRole('button',{name:'翻开查看',exact:true}).click(); await page.getByRole('button',{name:'填写槽位',exact:true}).click();
      await page.getByRole('combobox',{name:'书名选择',exact:true}).selectOption('book:ind-book-a');
      await page.getByRole('button',{name:'接受，加入手牌',exact:true}).click();
      await page.getByRole('button',{name:'查看手牌',exact:true}).waitFor();
    }
    await page.getByRole('tab',{name:/^手牌/}).click(); await page.getByText('×3',{exact:true}).waitFor();
    await page.getByText('展开 3 份独立手牌',{exact:true}).click(); const members = page.locator('.hand-stack-member'); assert.equal(await members.count(),3);
    const before = await readUI(page); assert.deepEqual(before.planner.instances.map(i=>i.daily.sourceDate),['2026-10-03','2026-10-04','2026-10-05']);
    const target = await members.nth(1).getAttribute('data-instance-id'); await members.nth(1).getByRole('button',{name:'撤出',exact:true}).click();
    await page.getByRole('tab',{name:'手牌（2）',exact:true}).waitFor(); const after = await readUI(page);
    assert.equal(after.planner.instances.length,3); assert.equal(after.planner.handOrder.length,2); assert.equal(after.planner.instances.find(i=>i.id===target).state,'withdrawn');
    assert.equal(after.planner.instances.filter(i=>i.state==='open').length,2); return {sourceDates:before.planner.instances.map(i=>i.daily.sourceDate),withdrawn:target,remaining:2};
  });
  await check('I-V03-07-visible-v3-rule-midnight-generates-once-and-archives-due-with-browsed-date-independent', async context => {
    const page = await pageIn(context,'cardgrid-workspace','2026-10-09T15:59:30Z');
    await page.evaluate(async()=>{await ind.setup();await ind.generate();await ind.accept();});
    await page.goto(origin+'/__independent-built');
    const previous=page.getByRole('button',{name:'查看前一天',exact:true});await previous.waitFor();
    async function until(test){for(let attempt=0;attempt<60;attempt++){const data=await readUI(page);if(test(data))return data;await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Expected authoritative inventory state was not reached');}
    const before=await until(data=>data.dailyCopies.some(copy=>copy.sourceDate==='2026-10-09'));
    assert.deepEqual(before.dailyCopies.map(copy=>copy.sourceDate),['2026-10-03','2026-10-09']);
    for(let day=0;day<3;day++)await previous.click();
    await page.locator('.toolbar strong').filter({hasText:'2026-10-06'}).waitFor();
    const afterBrowse=await readUI(page);assert.deepEqual(afterBrowse.dailyCopies,before.dailyCopies);
    await page.clock.runFor(31050);
    const crossed=await until(data=>data.archiveLogs.length===1&&data.dailyCopies.some(copy=>copy.sourceDate==='2026-10-10'));
    assert.deepEqual(crossed.dailyCopies.map(copy=>copy.sourceDate),['2026-10-09','2026-10-10']);
    assert.equal(crossed.planner.instances.length,1);assert.equal(crossed.planner.handOrder.length,0);
    assert.equal(crossed.archiveLogs[0].sourceDate,'2026-10-03');
    assert.equal(crossed.generationLedger.filter(item=>item.sourceDate==='2026-10-10').length,1);
    await page.locator('.toolbar strong').filter({hasText:'2026-10-06'}).waitFor();
    const revision=crossed.commandReceipts.length;
    await page.clock.runFor(120000);await page.getByRole('button',{name:'重新载入',exact:true}).click();
    const repeated=await until(data=>data.dailyCopies.some(copy=>copy.sourceDate==='2026-10-10'));
    assert.equal(repeated.generationLedger.filter(item=>item.sourceDate==='2026-10-10').length,1);assert.equal(repeated.archiveLogs.length,1);
    assert.equal(repeated.commandReceipts.length,revision);
    return {viewDate:'2026-10-06',sourceDates:repeated.dailyCopies.map(copy=>copy.sourceDate),archived:'2026-10-03',newDayLedger:1,duplicateWrites:0};
  },{reducedMotion:'reduce'});
} finally {
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify({role:'independent read-only acceptance',builtUI:true,results},null,2));
  await browser.close(); await server.close();
}
console.log('Evidence',out); if (results.some(r=>r.status==='fail')) process.exitCode=1;
