// Integrated author supplement: formal Host/IDB and production UI, synthetic only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
const root=fileURLToPath(new URL('../../',import.meta.url)),output=process.env.CARDGRID_I1_OUTPUT||path.join(root,'test-results/v06-i1-20261007/browser');
await fs.mkdir(output,{recursive:true});
const {chromium}=await import(process.env.CARDGRID_PLAYWRIGHT_MODULE||'playwright');
const server=await createServer({root,configFile:false,logLevel:'error',server:{host:'127.0.0.1',port:0},optimizeDeps:{noDiscovery:true,entries:[],include:['react','react-dom/client','react/jsx-dev-runtime','@js-temporal/polyfill','jsbi']},plugins:[{name:'i1',configureServer(v){v.middlewares.use((req,res,next)=>{if(req.url==='/__v06i1'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/browser/v06-b9-harness.tsx"></script>');}else next();});}}]});
await server.listen();const origin=server.resolvedUrls.local[0].replace(/\/$/,''),results=[];let browser;
const nav=(p,name)=>p.getByRole('navigation',{name:'主导航'}).getByRole('button',{name,exact:true});
const journal=p=>p.getByRole('region',{name:'时间线日记',exact:true});
const files=p=>p.getByRole('region',{name:'文本文件',exact:true});
const data=p=>p.evaluate(()=>cg.data());
async function saved(p){await p.getByText('随记保存：已保存到本机',{exact:true}).waitFor();}
async function abortOnce(p,type){await p.evaluate(type=>{const submit=cg.host.submit;cg.host.submit=async command=>{if(command.type!==type)return submit(command);const put=IDBObjectStore.prototype.put;let aborted=false;IDBObjectStore.prototype.put=function(...args){const result=put.apply(this,args);if(!aborted&&this.name==='workspace'){aborted=true;this.transaction.abort();}return result;};try{return await submit(command);}finally{IDBObjectStore.prototype.put=put;cg.host.submit=submit;}};},type);}
async function createList(p,name){await p.getByRole('button',{name:'＋ 新建牌堆',exact:true}).click();await p.getByLabel('牌堆名称').fill(name);await p.getByRole('button',{name:'创建牌堆',exact:true}).click();await p.getByText(`牌堆「${name}」已保存`,{exact:true}).waitFor();return (await data(p)).decks.find(d=>d.name===name);}
async function entryDraft(p,title,deckId){await p.getByRole('button',{name:'＋ 新建条目',exact:true}).click();await p.getByLabel('标题',{exact:true}).fill(title);if(deckId)await p.getByLabel('加入牌堆（可选）').selectOption(deckId);}
async function run(name,fn,width=1280){
  if(process.env.CARDGRID_I1_ONLY&&!new RegExp(process.env.CARDGRID_I1_ONLY).test(name))return;
  const c=await browser.newContext({viewport:{width,height:900},timezoneId:'Asia/Shanghai',serviceWorkers:'block',reducedMotion:'reduce',acceptDownloads:true}),p=await c.newPage(),errors=[];
  p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));
  try{await p.clock.setFixedTime(new Date('2026-10-06T00:12:00Z'));await p.goto(origin+'/__v06i1');await p.locator('.dial-svg').waitFor();const detail=await fn(p,c);assert.deepEqual(errors,[]);await p.screenshot({path:path.join(output,name+'.png'),fullPage:true});results.push({name,status:'pass',detail});console.log('PASS',name);}
  catch(e){results.push({name,status:'fail',error:e.stack,errors,ui:await p.locator('body').innerText().catch(()=>'' )});console.error('FAIL',name,e);await p.screenshot({path:path.join(output,name+'-failure.png'),fullPage:true}).catch(()=>{});}
  finally{await c.close();}
}
async function importSample(p){
  const sample=await p.evaluate(async()=>{const {configurationExample}=await import('/src/workspace/v5-config-example.ts');return configurationExample();});
  await nav(p,'备份与恢复').click();const config=p.getByRole('region',{name:'通用配置',exact:true});
  await config.getByLabel('选择通用配置').setInputFiles({name:'three-domains.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(sample))});
  await config.getByText(/目录变更/).waitFor();const download=p.waitForEvent('download');await config.getByRole('button',{name:'下载导入前活动 JSON 备份',exact:true}).click();await (await download).saveAs(path.join(output,'three-domains-before.json'));
  await config.getByLabel('确认已保存这份 JSON 及所需归档 ZIP').check();await config.getByRole('button',{name:'确认导入配置',exact:true}).click();await p.getByText('通用配置已导入，原事实与日记已保留',{exact:true}).waitFor();return sample;
}
try{
  browser=await chromium.launch({headless:true,...(process.env.CARDGRID_CHROME_PATH?{executablePath:process.env.CARDGRID_CHROME_PATH}:{})});
  await run('restore-selection-late-read-keeps-current-file',async p=>{
    const old=await p.evaluate(()=>cg.host.prepareBackup().then(cg.ok));
    const entry=await p.evaluate(async()=>{const draft={...cg.catalog.catalogEntries[0],id:'quality-current-file',title:'新版文件唯一条目'};await cg.submit('SaveCatalogEntry',{entry:draft,expectedVersion:null});return draft;});
    const latest=await p.evaluate(()=>cg.host.prepareBackup().then(cg.ok));
    await nav(p,'备份与恢复').click();const panel=p.getByRole('region',{name:'备份与恢复',exact:true});
    const download=p.waitForEvent('download');await panel.getByRole('button',{name:'下载活动 JSON 与归档索引备份'}).click();await download;await panel.getByLabel('确认备份已保存',{exact:true}).check();
    await p.evaluate(()=>{const text=File.prototype.text;File.prototype.text=async function(){const value=await text.call(this);if(this.name==='slow-a.json'){window.slowReadStarted=true;await new Promise(r=>window.finishSlowRead=r);}return value;};});
    await panel.getByLabel('选择恢复备份').setInputFiles({name:'slow-a.json',mimeType:'application/json',buffer:Buffer.from(old.text)});await p.waitForFunction(()=>window.slowReadStarted===true);
    assert.equal(await panel.getByRole('button',{name:'确认丢弃草稿并恢复'}).count(),0);
    await panel.getByLabel('选择恢复备份').setInputFiles({name:'current-b.json',mimeType:'application/json',buffer:Buffer.from(latest.text)});await panel.getByText('待恢复文件：current-b.json',{exact:true}).waitFor();
    await p.evaluate(()=>{window.finishSlowRead();});await panel.getByRole('button',{name:'确认丢弃草稿并恢复'}).click();
    await p.waitForFunction(()=>cg.data().then(d=>d.catalogEntries.some(e=>e.id==='quality-current-file')));assert.deepEqual((await data(p)).catalogEntries.find(e=>e.id===entry.id),entry);
    return {lateFileIgnored:true,confirmedCurrentFile:true,actualIDB:true};
  });
  await run('restore-file-switch-invalid-and-oversize-clear-old-preview',async p=>{
    const backup=await p.evaluate(()=>cg.host.prepareBackup().then(cg.ok));await nav(p,'备份与恢复').click();const panel=p.getByRole('region',{name:'备份与恢复',exact:true}),input=panel.getByLabel('选择恢复备份');
    const choose=()=>input.setInputFiles({name:'valid.json',mimeType:'application/json',buffer:Buffer.from(backup.text)});
    await choose();await panel.getByText('待恢复文件：valid.json',{exact:true}).waitFor();
    await input.setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{')});await p.getByRole('status').filter({hasText:/JSON|格式|备份/}).first().waitFor();assert.equal(await panel.getByRole('button',{name:'确认丢弃草稿并恢复'}).count(),0);
    await choose();await panel.getByText('待恢复文件：valid.json',{exact:true}).waitFor();
    await input.evaluate(el=>{const files=new DataTransfer();files.items.add(new File([new Uint8Array(64*1024*1024+1)],'too-big.json',{type:'application/json'}));el.files=files.files;el.dispatchEvent(new Event('change',{bubbles:true}));});
    await p.getByText('输入超过 64 MiB，未读取或恢复',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'确认丢弃草稿并恢复'}).count(),0);
    assert.deepEqual(await data(p),JSON.parse(backup.text).data);return {invalidAndOversizeClearPrevious:true,noWrites:true};
  });
  for(const cancel of [false,true])await run(`reference-late-preview-${cancel?'cancel-reopen':'input-edit'}`,async p=>{
    const card=await p.evaluate(()=>cg.answer());await p.getByRole('button',{name:/^手牌 \d+ 张，展开$/}).click();const dock=p.getByRole('dialog',{name:'本次手牌',exact:true}),item=dock.locator(`[data-hand-id="${card.id}"]`);
    const answerRow=item;await answerRow.getByRole('button',{name:'打出',exact:true}).click();
    const panel=p.getByRole('dialog',{name:'放置答案参考',exact:true});await panel.getByLabel('位置',{exact:true}).selectOption('point');await panel.getByLabel('当地时点',{exact:true}).fill('09:00');
    await p.evaluate(()=>{const preview=cg.host.previewReference;cg.host.previewReference=async input=>{const r=await preview(input);cg.host.previewReference=preview;window.oldPreviewEntered=true;await new Promise(resolve=>window.releaseOldPreview=()=>{resolve();window.oldPreviewFinished=true;});return r;};});
    await panel.getByRole('button',{name:'预览参考',exact:true}).click();await p.waitForFunction(()=>window.oldPreviewEntered===true);
    if(cancel){await panel.getByRole('button',{name:'取消参考',exact:true}).click();await answerRow.getByRole('button',{name:'打出',exact:true}).click();await panel.getByLabel('位置',{exact:true}).selectOption('point');}
    await panel.getByLabel('当地时点',{exact:true}).fill('10:00');await p.evaluate(()=>window.releaseOldPreview());await p.waitForFunction(()=>window.oldPreviewFinished===true);
    assert.equal(await panel.getByRole('button',{name:'确认放置参考',exact:true}).count(),0);
    await panel.getByRole('button',{name:'预览参考',exact:true}).click();await panel.getByRole('button',{name:'确认放置参考',exact:true}).click();await panel.waitFor({state:'detached'});
    const current=(await data(p)).referencePlacements.find(r=>r.answerId===card.id);assert.ok(current);assert.equal(current.point.localTime,'2026-10-06T10:00');return {latePreviewIgnored:true,cancelReopen:cancel,onlyCurrentTimeCommitted:true};
  });
  await run('workshop-action-create-join-retry-edit-and-freeze',async p=>{
    await nav(p,'工坊').click();await p.getByRole('button',{name:'＋ 新建牌堆',exact:true}).click();await p.getByLabel('牌堆名称').fill('新行动牌堆');await p.getByLabel('牌堆类型').selectOption('action');await p.getByRole('button',{name:'创建牌堆',exact:true}).click();await p.getByText('牌堆「新行动牌堆」已保存',{exact:true}).waitFor();const deck=(await data(p)).decks.find(d=>d.name==='新行动牌堆');
    await p.getByRole('button',{name:'＋ 新建行动',exact:true}).click();await p.getByLabel('行动标题',{exact:true}).fill('学习 {对象}');await p.getByLabel('完成标准',{exact:true}).fill('完成一个可核对结果');await p.getByLabel('加入行动牌堆（可选）').selectOption(deck.id);await p.getByRole('button',{name:'＋ 添加字段',exact:true}).click();await p.getByLabel('字段 1 名称').fill('对象');await p.getByLabel('必填',{exact:true}).check();
    await abortOnce(p,'SaveDeck');await p.getByRole('button',{name:'创建行动',exact:true}).click();await p.locator('.we2-notice.error').filter({hasText:'加入牌堆未完成'}).waitFor();const created=(await data(p)).actionCards.find(a=>a.content.title==='学习 {对象}');assert.ok(created);assert.equal(await p.getByLabel('行动标题',{exact:true}).isDisabled(),true);
    await p.getByRole('button',{name:'创建行动',exact:true}).click();await p.getByText('行动「学习 {对象}」已保存并加入牌堆',{exact:true}).waitFor();assert.deepEqual((await data(p)).actionCards.filter(a=>a.id===created.id),[created]);assert.deepEqual((await data(p)).decks.find(d=>d.id===deck.id).memberIds,[created.id]);
    await p.getByRole('button',{name:'直接拿牌：学习 {对象}',exact:true}).click();await p.getByText('已加入本次手牌',{exact:true}).waitFor();const taken=(await data(p)).handCards.find(c=>c.ownerAction?.id===created.id);
    await p.getByRole('region',{name:'行动原库',exact:true}).locator('.act-card').filter({hasText:'学习 {对象}'}).getByRole('button',{name:'编辑行动',exact:true}).click();await p.getByLabel('行动标题',{exact:true}).fill('学习新版 {对象}');await p.getByLabel('行动状态').selectOption('paused');await p.getByRole('button',{name:'保存行动',exact:true}).click();await p.getByText('行动「学习新版 {对象}」已保存',{exact:true}).waitFor();const after=await data(p),edited=after.actionCards.find(a=>a.id===created.id);assert.equal(edited.version,2);assert.deepEqual(edited.fields,created.fields);assert.deepEqual(after.handCards.find(c=>c.id===taken.id),taken);
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await p.reload();await p.locator('.dial-svg').waitFor();assert.deepEqual((await data(p)).actionCards.find(a=>a.id===created.id),edited);return {createWithoutConfigImport:true,actualIDBAbort:true,membershipOnlyRetry:true,editedSourceKeepsFrozenMaterial:true,reload:true};
  },320);
  await run('workshop-create-lost-reply-retries-one-entry',async p=>{
    await nav(p,'工坊').click();await entryDraft(p,'创建丢回复只保留一份');
    await p.evaluate(()=>{const submit=cg.host.submit;cg.host.submit=async command=>{if(command.type==='SaveCatalogEntry'){cg.host.submit=submit;cg.loseNext();}return submit(command);};});
    await p.getByRole('button',{name:'创建条目',exact:true}).click();await p.locator('.we2-notice.error').waitFor();
    const first=(await data(p)).catalogEntries.find(e=>e.title==='创建丢回复只保留一份');assert.ok(first);
    await p.getByRole('button',{name:'创建条目',exact:true}).click();await p.getByText('条目「创建丢回复只保留一份」已保存',{exact:true}).waitFor();
    assert.deepEqual((await data(p)).catalogEntries.filter(e=>e.title===first.title),[first]);return {committedReplyLost:true,oneEntrySameIdAndVersion:true};
  });
  await run('workshop-entry-join-abort-retries-only-membership',async p=>{
    await nav(p,'工坊').click();const deck=await createList(p,'部分成功可续办清单');await entryDraft(p,'加入失败仍是原条目',deck.id);await abortOnce(p,'SaveDeck');
    await p.getByRole('button',{name:'创建条目',exact:true}).click();await p.locator('.we2-notice.error').filter({hasText:'条目「加入失败仍是原条目」已保存，加入牌堆未完成'}).waitFor();
    const first=(await data(p)).catalogEntries.find(e=>e.title==='加入失败仍是原条目');assert.ok(first);assert.equal(await p.getByLabel('标题',{exact:true}).isDisabled(),true);
    assert.deepEqual((await data(p)).decks.find(d=>d.id===deck.id).memberIds,[]);
    await p.getByRole('button',{name:'创建条目',exact:true}).click();await p.getByText('条目「加入失败仍是原条目」已保存并加入牌堆',{exact:true}).waitFor();
    const after=await data(p);assert.deepEqual(after.catalogEntries.filter(e=>e.title===first.title),[first]);assert.deepEqual(after.decks.find(d=>d.id===deck.id).memberIds,[first.id]);return {actualIDBAbort:true,partialSuccessExplained:true,retryOnlyMembership:true};
  });
  await run('workshop-member-move-abort-visible-and-retry',async p=>{
    await nav(p,'工坊').click();const a=await createList(p,'成员移动 A'),b=await createList(p,'成员移动 B');await entryDraft(p,'移动失败项',a.id);await p.getByRole('button',{name:'创建条目',exact:true}).click();await p.getByText('条目「移动失败项」已保存并加入牌堆',{exact:true}).waitFor();
    await p.locator('.act-card').filter({has:p.getByText(a.name,{exact:true})}).getByRole('button',{name:'管理成员',exact:true}).click();const panel=p.getByRole('dialog',{name:a.name+' 成员管理',exact:true});await panel.locator('.we2-move-group select').first().selectOption(b.id);
    const before=await data(p);await abortOnce(p,'MoveDeckMember');await panel.getByRole('button',{name:'移动到…',exact:true}).click();await panel.getByRole('alert').waitFor();assert.deepEqual((await data(p)).decks,before.decks);
    await panel.getByRole('button',{name:'移动到…',exact:true}).click();await p.waitForFunction(id=>cg.data().then(d=>d.decks.find(x=>x.id===id).memberIds.length===1),b.id);
    const after=await data(p);assert.equal(after.decks.find(d=>d.id===a.id).memberIds.length,0);assert.equal(await panel.getByRole('alert').count(),0);return {failureVisible:true,noPartialMove:true,retryOnce:true};
  });
  await run('three-domains-formal-ui-and-standalone-list',async p=>{
    const before=await data(p),sample=await importSample(p),completed=[];
    for(const [i,id] of ['sample-eat','sample-read','sample-exercise'].entries()){
      const source=sample.config.actionCards.find(a=>a.id===id),domain=['吃饭','阅读','锻炼'][i];
      if(i===0){await nav(p,'工坊').click();await p.getByRole('button',{name:`直接拿牌：${source.content.title}`,exact:true}).click();}
      else{
        await nav(p,'抽卡与决策').click();await p.getByRole('button',{name:'行动抽卡',exact:true}).click();const scope=p.getByRole('group',{name:'候选行动牌堆'});
        for(const box of await scope.getByRole('checkbox').all())await box.uncheck();await scope.getByRole('checkbox',{name:`${domain}行动`,exact:true}).check();
        if(i===1){await p.getByRole('button',{name:'行动球面',exact:true}).click();const sphere=p.getByRole('dialog',{name:'卡球面',exact:true}),card=sphere.locator(`[data-card-id="${id}"]`);await card.focus();await p.keyboard.press('Enter');await p.keyboard.press('Enter');await sphere.getByRole('button',{name:'接受行动，加入手牌',exact:true}).click();}
        else{await p.getByLabel('手选行动',{exact:true}).selectOption(id);await p.getByRole('button',{name:'翻开行动',exact:true}).click();await p.getByRole('button',{name:'接受行动，加入手牌',exact:true}).click();}
      }
      await p.waitForFunction(id=>cg.data().then(d=>d.handCards.some(c=>c.kind==='action'&&c.ownerAction.id===id)),id);
      await nav(p,'抽卡与决策').click();await p.getByRole('button',{name:'决策答案',exact:true}).click();await p.getByLabel('选择问题',{exact:true}).selectOption(`${id}-decision`);
      if(i===1){await p.getByRole('button',{name:'手选候选',exact:true}).click();await p.locator('.dm6-candidates button').click();}else await p.getByRole('button',{name:'翻牌抽取',exact:true}).click();
      await p.getByRole('button',{name:'只取答案',exact:true}).click();await p.waitForFunction(id=>cg.data().then(d=>d.handCards.some(c=>c.kind==='answer'&&c.answer.ownerAction.id===id)),id);
      const d=await data(p),action=d.handCards.find(c=>c.kind==='action'&&c.ownerAction.id===id),answer=d.handCards.find(c=>c.kind==='answer'&&c.answer.ownerAction.id===id);
      await nav(p,'工坊').click();await p.getByRole('button',{name:'三槽合成台',exact:true}).click();await p.getByLabel('槽 1 · 本次行动',{exact:true}).selectOption(action.id);await p.getByLabel('槽 2 · 本次答案',{exact:true}).selectOption(answer.id);
      await p.getByRole('button',{name:'确认合成',exact:true}).click();await p.getByText(/合成完成：两张素材/).waitFor();const synthesized=await data(p),composite=synthesized.handCards.find(c=>c.kind==='composite'&&c.ownerAction.id===id);
      assert.equal(synthesized.handCards.find(c=>c.id===action.id).state,'consumed');assert.equal(synthesized.handCards.find(c=>c.id===answer.id).state,'consumed');assert.deepEqual(synthesized.actionCards,d.actionCards);
      await nav(p,'Today').click();await p.getByLabel('默认落点',{exact:true}).fill(`${9+i}:00`.padStart(5,'0'));
      const trigger=p.getByRole('button',{name:/^手牌 \d+ 张，展开$/});if(await trigger.count())await trigger.click();const dock=p.getByRole('dialog',{name:'本次手牌',exact:true});await dock.locator('li').filter({hasText:composite.contentSnapshot.title}).getByRole('button',{name:'打出',exact:true}).click();
      const placement=p.getByRole('dialog',{name:'排期与重叠确认',exact:true});await placement.getByRole('button',{name:'确认排期',exact:true}).click();await placement.waitFor({state:'detached'});
      await p.locator('.dayboard-row').filter({hasText:composite.contentSnapshot.title}).getByRole('button',{name:'确认实际',exact:true}).click();const actual=p.getByRole('dialog',{name:'确认实际发生',exact:true});await actual.getByRole('button',{name:'确认实际',exact:true}).click();await actual.waitFor({state:'detached'});
      assert.ok((await data(p)).planner.facts.some(f=>f.contentSnapshot.title===composite.contentSnapshot.title));await p.getByRole('button',{name:'关闭手牌',exact:true}).click();completed.push(domain);
    }
    await nav(p,'工坊').click();const card=p.locator('.act-card').filter({hasText:'独立网址清单'});await card.getByRole('button',{name:'管理成员',exact:true}).click();const members=p.getByRole('dialog',{name:'独立网址清单 成员管理',exact:true});assert.match(await members.innerText(),/独立清单示例/);await members.getByRole('button',{name:'关闭',exact:true}).click();
    const final=await data(p);assert.deepEqual(final.journalEntries,before.journalEntries);assert.equal(final.planner.facts.length,3);await p.reload();await p.locator('.dial-svg').waitFor();assert.equal((await data(p)).planner.facts.length,3);await nav(p,'时间线日记').click();await journal(p).getByText(/已确认事实/).first().waitFor();assert.equal(await journal(p).locator('[data-journal-row="automatic"]').filter({hasText:'已确认事实'}).count(),3);assert.match(await journal(p).innerText(),/睡眠/);
    return {completed,randomAndManual:true,workshopAndSphere:true,consumedOnlySelected:true,originalLibraryPreserved:true,reload:true,sleepFromDial:true};
  });
  for(const width of [320,390,720,1280])await run(`journal-keyboard-modified-time-${width}`,async p=>{
    await nav(p,'时间线日记').click();const editor=p.getByRole('textbox',{name:'独立感想',exact:true});await editor.focus();await p.keyboard.type('第一条感想\nhttps://example.com/'+ 'long'.repeat(60));await p.keyboard.press('Tab');await saved(p);
    const before=(await data(p)).journalNotes[0],row=journal(p).locator('[data-journal-row="reflection"]');await p.evaluate(()=>cg.setNow('2026-10-06T02:30:00Z'));
    await row.getByRole('button',{name:'编辑感想',exact:true}).focus();await p.keyboard.press('Enter');await p.waitForFunction(()=>document.querySelector('textarea[aria-label="独立感想"]').value.startsWith('第一条'));
    await editor.focus();await p.keyboard.press('ControlOrMeta+A');await p.keyboard.type('改写感想\nhttps://example.com/'+ 'long'.repeat(60));await p.keyboard.press('Tab');await saved(p);await row.getByText(/修改于/).waitFor();
    const after=(await data(p)).journalNotes[0];assert.equal(after.id,before.id);assert.equal(after.recordedAt,before.recordedAt);assert.notEqual(after.updatedAt,before.updatedAt);assert.equal(after.version,before.version+1);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await row.locator('time').first().getAttribute('datetime'),before.recordedAt);
    return {width,keyboardCreateAndEdit:true,originalTimeRetained:true,modifiedTimeVisible:true,noHorizontalOverflow:true};
  },width);
  await run('journal-day-and-navigation-flush-error-recovery',async p=>{
    await nav(p,'时间线日记').click();await p.evaluate(()=>{const original=IDBObjectStore.prototype.put;window.restoreWrites=()=>{IDBObjectStore.prototype.put=original;};IDBObjectStore.prototype.put=function(...args){const r=original.apply(this,args);if(this.name==='workspace')this.transaction.abort();return r;};});
    const editor=p.getByRole('textbox',{name:'独立感想',exact:true});await editor.fill('失败时保留同一感想');await journal(p).getByLabel('归属日',{exact:true}).fill('2026-10-05');await journal(p).getByText(/保存未完成/).waitFor();assert.equal(await journal(p).getByLabel('归属日').inputValue(),'2026-10-06');assert.equal(await editor.inputValue(),'失败时保留同一感想');
    await nav(p,'Today').click();await p.getByText('感想尚未保存，草稿保留在当前页面',{exact:true}).waitFor();assert.equal((await data(p)).journalNotes.length,0);await p.evaluate(()=>restoreWrites());await nav(p,'Today').click();await p.locator('.dial-svg').waitFor();assert.equal((await data(p)).journalNotes.length,1);
    await nav(p,'时间线日记').click();await journal(p).getByLabel('归属日').fill('2026-10-05');await p.waitForFunction(()=>!!document.querySelector('.v06-journal pre'));await editor.fill('过去日补记');await nav(p,'维护日志').click();await p.getByRole('region',{name:'维护日志',exact:true}).waitFor();assert.ok((await data(p)).journalNotes.some(n=>n.date==='2026-10-05'&&n.text==='过去日补记'));
    await nav(p,'时间线日记').click();await journal(p).getByText(/补记于/).waitFor();const legacy=(await data(p)).journalEntries[0];assert.equal(await journal(p).locator('pre').innerText(),legacy.text);return {dayHeldOnFailure:true,navigationHeld:true,retryCreatesOne:true,pastDayFlush:true,legacyFullText:true};
  });
  await run('file-error-permission-and-external-recovery-feedback',async p=>{
    await nav(p,'时间线日记').click();await files(p).getByRole('button',{name:'连接文本目录',exact:true}).click();await p.waitForFunction(()=>b9.connection().then(Boolean).catch(()=>false));await p.evaluate(()=>b9.files.flush());
    const before=await data(p);await p.evaluate(async()=>{b9.denied(true);const c=await b9.connection();await b9.files.refreshTextFiles({bindingId:c.bindingId,connectionVersion:c.connectionVersion,epoch:c.epoch});});await files(p).getByText(/需要重新授权/).first().waitFor();assert.deepEqual(await data(p),before);
    await p.evaluate(()=>{const original=b9.files.reconnectTextDirectory;b9.files.reconnectTextDirectory=(...args)=>{window.reconnectRequest=original(...args);b9.files.reconnectTextDirectory=original;return window.reconnectRequest;};});await files(p).getByRole('button',{name:'重新授权并补写',exact:true}).click();await p.evaluate(()=>window.reconnectRequest);await p.evaluate(()=>b9.files.flush());await files(p).getByText(/文件状态：已同步/).waitFor();
    await p.evaluate(()=>b9.streamFailure(true));await p.getByRole('textbox',{name:'独立感想',exact:true}).fill('主数据保存而文件失败');await p.getByRole('button',{name:'立即保存',exact:true}).click();await saved(p);await p.evaluate(()=>b9.files.flush());await files(p).getByText(/文件写入失败/).first().waitFor();assert.equal((await data(p)).journalNotes.length,1);
    await p.evaluate(async()=>{b9.streamFailure(false);const c=await b9.connection();await b9.files.refreshTextFiles({bindingId:c.bindingId,connectionVersion:c.connectionVersion,epoch:c.epoch});});await files(p).getByText(/文件状态：已同步/).waitFor();const bytes=await p.evaluate(()=>b9.bytes());
    await p.evaluate(async()=>{await b9.external([255,0,88]);const c=await b9.connection();await b9.files.refreshTextFiles({bindingId:c.bindingId,connectionVersion:c.connectionVersion,epoch:c.epoch});});await files(p).getByText(/外部修改副本：/).waitFor();assert.deepEqual(await p.evaluate(()=>b9.conflict()),[255,0,88]);assert.deepEqual(await p.evaluate(()=>b9.bytes()),bytes);
    return {realOPFS:true,permissionSeamOnly:true,writeFailureRetainsBusiness:true,externalCopyVisible:true,originalExternalBytesPreserved:true};
  },320);
}finally{await browser?.close();await server.close();const passed=results.filter(r=>r.status==='pass').length;await fs.writeFile(path.join(output,'report.json'),JSON.stringify({scope:'I1/A7 author supplement, formal Host with synthetic IDB and OPFS; OS chooser/revocation and non-author acceptance separate',passed,total:results.length,results},null,2));console.log(`${passed}/${results.length}`);if(passed!==results.length)process.exitCode=1;}
