import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const root=fileURLToPath(new URL('../../',import.meta.url));
const out=path.join(process.env.CARDGRID_JOURNAL_REVIEW_OUTPUT||path.join(root,'test-results/v05-journal-independent'));
await fs.mkdir(out,{recursive:true});
const server=await createServer({root,configFile:path.join(root,'scripts/vite.config.ts'),configLoader:'native',server:{host:'127.0.0.1',port:53319,strictPort:true},logLevel:'error'});
await server.listen();
const browser=await chromium.launch({headless:true,...(process.env.CARDGRID_CHROME_PATH?{executablePath:process.env.CARDGRID_CHROME_PATH}:{})});
const context=await browser.newContext({timezoneId:'UTC',serviceWorkers:'block'}),page=await context.newPage();
page.setDefaultTimeout(5000);
const result={id:'R08-real-ui-failed-navigation-keeps-draft',status:'pass'};
try{
  await page.clock.install({time:new Date('2026-10-05T01:00:00Z')});
  await page.goto('http://127.0.0.1:53319');
  await page.locator('nav').getByRole('button',{name:'日记'}).click();
  await page.getByLabel('日记正文').waitFor();
  await page.evaluate(()=>{
    window.__failJournalWrites=true;window.__journalWriteAborted=false;
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(value,...args){
      const request=original.call(this,value,...args);
      if(window.__failJournalWrites&&this.name==='workspace'&&value?.data?.commandReceipts?.some(r=>r.type==='SaveJournalEntry')){
        window.__journalWriteAborted=true;this.transaction.abort();
      }
      return request;
    };
  });
  await page.getByLabel('日记正文').fill('draft must survive failed navigation');
  await page.locator('nav').getByRole('button',{name:'数据与备份'}).click();
  await page.waitForFunction(()=>window.__journalWriteAborted);
  await page.getByRole('button',{name:'保存失败，点着重试'}).waitFor();
  assert.equal(await page.locator('nav').getByRole('button',{name:'日记'}).getAttribute('aria-current'),'page');
  assert.equal(await page.getByLabel('日记正文').inputValue(),'draft must survive failed navigation');
  await page.evaluate(()=>{window.__failJournalWrites=false;});
  await page.getByRole('button',{name:'保存失败，点着重试'}).click();
  await page.locator('.journal-status.saved').waitFor();
  assert.equal(await page.locator('.journal-notice').count(),0,'successful retry clears the obsolete save error');
  await page.locator('nav').getByRole('button',{name:'数据与备份'}).click();
  await page.getByRole('heading',{name:'数据与备份',exact:true}).waitFor();
  const raw=await page.evaluate(async()=>{
    const {createWorkspaceStore}=await import('/src/workspace/store.ts');const s=createWorkspaceStore();try{return await s.read();}finally{s.close();}
  });
  assert.equal(raw.data.journalEntries[0].text,'draft must survive failed navigation');
  result.evidence={journalEntries:raw.data.journalEntries};
}catch(error){result.status='fail';result.error=String(error);result.ui=await page.evaluate(()=>({activeTab:document.querySelector('nav [aria-current=page]')?.textContent,text:document.querySelector('.journal-textarea')?.value}));await page.screenshot({path:path.join(out,'R08-real-ui.png'),fullPage:true});}
finally{await fs.writeFile(path.join(out,'independent-navigation-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));await context.close();await browser.close();await server.close();}
if(result.status==='fail')process.exitCode=1;
