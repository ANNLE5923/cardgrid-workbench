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
const result={id:'R06-real-ui-explicit-restore-discards-old-draft',status:'pass'};
try{
  await page.clock.install({time:new Date('2026-10-05T01:00:00Z')});
  await page.goto('http://127.0.0.1:53319');
  await page.locator('nav').getByRole('button',{name:'日记'}).click();
  await page.getByLabel('日记正文').fill('old draft must not enter restored workspace');
  const restore=await page.evaluate(async()=>{
    const {createWorkspaceClient}=await import('/src/workspace/client.ts');
    const {emptyWorkspaceData}=await import('/src/workspace/format.ts');
    const client=createWorkspaceClient();
    try{
      const p=await client.prepareBackup();if(!p.ok)throw new Error(p.message);
      const text=JSON.stringify({format:'cardgrid',version:4,kind:'backup',dataFormat:'action-v4',data:emptyWorkspaceData()});
      const preview=await client.previewRestore({token:p.value.token,text});if(!preview.ok)throw new Error(preview.message);
      return await client.submit({commandId:crypto.randomUUID(),expected:p.value.token,type:'RestoreWorkspace',payload:{previewId:preview.value.previewId,backup:{token:p.value.token,dataFingerprint:p.value.dataFingerprint,fileSavedConfirmed:true},discardDraftsConfirmed:true}});
    }finally{client.close();}
  });
  assert.equal(restore.ok,true);
  await page.waitForFunction(()=>document.querySelector('.message')?.textContent.includes('工作区已被替换'));
  await page.getByLabel('日记正文').waitFor();
  // Allow post-restore component effects and the queued IndexedDB command to settle.
  await page.waitForTimeout(500);
  const raw=await page.evaluate(async()=>{
    const {createWorkspaceStore}=await import('/src/workspace/store.ts');const s=createWorkspaceStore();try{return await s.read();}finally{s.close();}
  });
  result.evidence={restoredEpoch:restore.value?.token?.epoch,currentEpoch:raw.epoch,journalEntries:raw.data.journalEntries,receipts:raw.data.commandReceipts};
  assert.deepEqual(raw.data.journalEntries,[],'explicit RestoreWorkspace with discardDraftsConfirmed must keep the restored empty journal exact');
}catch(error){result.status='fail';result.error=String(error);await page.screenshot({path:path.join(out,'R06-real-ui.png'),fullPage:true});}
finally{await fs.writeFile(path.join(out,'independent-real-ui-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));await context.close();await browser.close();await server.close();}
if(result.status==='fail')process.exitCode=1;
