import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(process.env.CARDGRID_JOURNAL_REVIEW_OUTPUT || path.join(root, 'test-results/v05-journal-independent'));
await fs.mkdir(out, {recursive: true});
const server = await createServer({root, configFile: path.join(root, 'scripts/vite.config.ts'), configLoader: 'native', server: {host:'127.0.0.1', port: 53319, strictPort: true}, logLevel:'error'});
await server.listen();
const browser = await chromium.launch({headless: true, ...(process.env.CARDGRID_CHROME_PATH ? {executablePath: process.env.CARDGRID_CHROME_PATH} : {})});
const findings = [];
const entries = [{id:'prior',version:1,date:'2026-10-03',zone:'UTC',text:'prior saved entry',createdAt:'2026-10-03T10:00:00Z',updatedAt:'2026-10-03T10:00:00Z'}];
async function check(id, fn, options = {}) {
  const context = await browser.newContext({timezoneId:'Asia/Tokyo',serviceWorkers:'block',viewport:{width:1280,height:900}});
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  let evidence;
  try {
    await page.clock.install({time:new Date('2026-10-05T01:00:00Z')});
    await page.goto('http://127.0.0.1:53319');
    await page.evaluate(async options => {const m = await import('/tests/browser/journal-independent-harness.tsx'); m.mountReview(options);}, {entries, ...options});
    await page.waitForFunction(() => !!window.__review);
    await fn(page);
    findings.push({id,status:'pass'}); console.log('PASS',id);
  } catch (error) {
    evidence = await page.evaluate(() => ({calls:window.__review?.calls, entries:window.__review?.entries, text:document.querySelector('textarea')?.value,heading:document.querySelector('.journal-editor h2')?.textContent}));
    findings.push({id,status:'fail',error:String(error),evidence}); console.log('FAIL',id,JSON.stringify(evidence));
    await page.screenshot({path:path.join(out,id+'.png'),fullPage:true});
  } finally {await context.close();}
}
try {
  await check('R01-failed-save-date-switch-keeps-draft',async page => {
    const text = page.getByLabel('日记正文'); await text.waitFor();
    await page.evaluate(() => {window.__review.failNext = true;});
    await text.fill('unsaved draft must survive');
    await page.locator('button[title="2026-10-03"]').click();
    await page.getByRole('button',{name:'保存失败，点着重试'}).waitFor();
    assert.match(await page.locator('.journal-editor h2').textContent(),/2026年10月5日/);
    assert.equal(await text.inputValue(),'unsaved draft must survive','failed save must keep the current draft and prevent a destructive switch');
  });
  await check('R02-saving-date-switch-preserves-latest-text',async page => {
    const text = page.getByLabel('日记正文'); await text.waitFor();
    await page.evaluate(() => {window.__review.hangNext = true;});
    await text.fill('first draft'); await text.press('Control+s');
    await page.waitForFunction(() => window.__review.calls.length === 1);
    await text.fill('latest draft');
    await page.locator('button[title="2026-10-03"]').click();
    await page.evaluate(() => window.__review.release());
    await page.getByRole('heading',{name:/2026年10月3日/}).waitFor();
    await page.waitForFunction(() => document.querySelector('textarea')?.value === 'prior saved entry');
    const saved = await page.evaluate(() => window.__review.entries.find(e => e.date === '2026-10-05')?.text);
    assert.equal(saved,'latest draft','switching during a save must drain the trailing text for the original day');
  });
  await check('R03-leave-during-save-drains-trailing-text',async page => {
    const text = page.getByLabel('日记正文'); await text.waitFor();
    await page.evaluate(() => {window.__review.hangNext = true;});
    await text.fill('first draft'); await text.press('Control+s');
    await page.waitForFunction(() => window.__review.calls.length === 1);
    await text.fill('latest draft');
    await page.evaluate(() => window.__review.unmount());
    await page.evaluate(() => window.__review.release());
    await page.waitForFunction(() => window.__review.entries.some(e => e.date === '2026-10-05' && e.text === 'latest draft'));
    const saved = await page.evaluate(() => window.__review.entries.find(e => e.date === '2026-10-05')?.text);
    assert.equal(saved,'latest draft','leaving while saving must not discard the trailing text');
  });
  await check('R04-open-uses-workspace-today',async page => {
    await page.getByLabel('日记正文').waitFor();
    const heading = await page.locator('.journal-editor h2').textContent();
    assert.match(heading,/2026年10月4日/,'initial selected date must be today in settings.zone');
  },{zone:'America/New_York',entries:[]});
  await check('R05-browsing-cross-zone-entry-does-not-create',async page => {
    await page.getByLabel('日记正文').waitFor();
    await page.locator('button[title="2026-10-03"]').click();
    await page.getByText('这篇写于时区 America/New_York',{exact:true}).waitFor();
    // The view renders its zone before the autosave effect adopts the loaded text.
    await page.waitForFunction(() => document.querySelector('.journal-textarea')?.value === 'prior saved entry');
    assert.equal(await page.getByLabel('日记正文').inputValue(),'prior saved entry');
    await page.evaluate(async () => {window.__review.unmount();for(let i=0;i<10;i++)await Promise.resolve();});
    assert.equal(await page.evaluate(() => window.__review.entries.length),1,'opening a historic fallback and leaving must not create a new current-zone diary');
    assert.deepEqual(await page.evaluate(() => window.__review.calls),[],'browsing a historic fallback must not submit a save');
  },{entries:entries.map(e=>({...e,zone:'America/New_York'}))});
  await check('R06-replacement-discards-old-workspace-draft',async page => {
    const text = page.getByLabel('日记正文'); await text.waitFor();
    await text.fill('old workspace draft must not enter restored workspace');
    await page.evaluate(async () => {window.__review.replace();window.__review.unmount();for(let i=0;i<10;i++)await Promise.resolve();});
    assert.equal(await page.evaluate(() => window.__review.entries.length),0,'an old component must not adopt the replacement epoch token and write into restored data');
  });
  await check('R07-repeated-flush-finishes-saved-status',async page=>{
    const text=page.getByLabel('日记正文');await text.waitFor();
    await page.evaluate(()=>{window.__review.hangNext=true;});
    await text.fill('same pending text');await text.press('Control+s');
    await page.waitForFunction(()=>window.__review.calls.length===1);
    await text.press('Control+s');
    await page.evaluate(()=>window.__review.release());
    await page.locator('.journal-status.saved').waitFor();
    assert.equal(await page.evaluate(()=>window.__review.calls.length),1,'repeated flush must not create duplicate saves');
  });
} finally {
  await fs.writeFile(path.join(out,'independent-browser-results.json'),JSON.stringify(findings,null,2));
  await browser.close(); await server.close();
}
if(findings.some(r => r.status === 'fail'))process.exitCode=1;
