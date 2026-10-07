// v0.6 A5 formal-wiring browser check. Fresh contexts, synthetic IndexedDB only
// (no personal data). The WorkshopEditorV06 (with built-in SynthesisBenchV06)
// runs against the real IndexedDB-backed host through the A5 adapter. Verifies:
// formal banner, direct action take, standalone-list editing, three-slot
// synthesis, persistence across reload (no fake success), a real IDB abort that
// is surfaced as failure and then retried, a keyboard confirm, and narrow 320.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {chromium} = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.CARDGRID_V06A5_OUTPUT || path.join(root, 'test-results/v06-a5');
await fs.mkdir(output, {recursive: true});

const server = await createServer({root, configFile: false, server: {host: '127.0.0.1', port: 0},
  optimizeDeps: {noDiscovery: true, entries: [],
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@js-temporal/polyfill', 'jsbi']},
  plugins: [{name: 'v06-a5-page', configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (req.url === '/__v06a5') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>v0.6 A5</title><div id="root"></div><script type="module" src="/tests/browser/v06-a5/v06-a5-harness.tsx"></script>');
      } else next();
    });
  }}], logLevel: 'error'});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const results = [];
let browser;

const shot = (page, name) => page.screenshot({path: path.join(output, name), fullPage: true}).catch(() => {});
const waitFor = async (fn, {timeout = 8000, label = 'condition'} = {}) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {if (await fn()) return;} catch (e) {last = e;}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('waitFor timed out (' + label + ')' + (last ? ': ' + last.message : ''));
};
const handCount = async page => {
  const text = await page.locator('.we2-hand summary').innerText();
  return Number(text.match(/本次手牌：(\d+) 张/)[1]);
};
const actionDeckTake = page =>
  page.locator('.we2-grid .act-card').filter({hasText: '行动·阅读'})
    .locator('.act-mini.primary');
const takeActionViaUi = async page => {
  await actionDeckTake(page).click();
  await page.locator('.we2-notice.success').filter({hasText: '已加入本次手牌'}).waitFor();
};
const openSynthesis = async page => {
  await page.getByRole('button', {name: '三槽合成台'}).click();
  await page.locator('.we3').waitFor();
};
const chooseSlots = async page => {
  await page.locator('select[aria-label="槽 1 · 本次行动"]').selectOption({index: 1});
  await page.locator('select[aria-label="槽 2 · 本次答案"]').selectOption({index: 1});
  await page.locator('.we3-preview').waitFor();
};

try {
  browser = await chromium.launch({headless: true,
    ...(process.env.CARDGRID_CHROME_PATH ? {executablePath: process.env.CARDGRID_CHROME_PATH} : {})});

  async function test(name, options, fn) {
    const context = await browser.newContext({serviceWorkers: 'block', ...options});
    const page = await context.newPage();
    const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
    const started = Date.now();
    try {
      await page.goto(origin + '/__v06a5', {waitUntil: 'networkidle'});
      await page.locator('.we2-banner').waitFor({timeout: 60000});
      await fn(page, pageErrors);
      assert.deepEqual(pageErrors, []);
      results.push({name, status: 'pass', durationMs: Date.now() - started}); console.log('PASS', name);
    } catch (error) {
      await page.screenshot({path: path.join(output, `failure-${name}.png`), fullPage: true}).catch(() => {});
      results.push({name, status: 'fail', error: error.message}); console.error('FAIL', name, error);
    } finally {await context.close();}
  }

  const desktop = {viewport: {width: 1280, height: 900}};
  const narrow = {viewport: {width: 320, height: 680}};
  const reducedMotion = {viewport: {width: 1280, height: 900}, reducedMotion: 'reduce'};

  // Warm up Vite's first-time full transform chain so the first real test does
  // not time out on cold compilation. Throwaway context: its IndexedDB is
  // independent of every test's fresh context.
  {
    const warmContext = await browser.newContext({serviceWorkers: 'block'});
    const warmPage = await warmContext.newPage();
    await warmPage.goto(origin + '/__v06a5', {waitUntil: 'networkidle'});
    await warmPage.locator('.we2-banner').waitFor({timeout: 120000});
    await warmContext.close();
  }

  /* ---------- Desktop ---------- */

  await test('01-formal-banner-and-initial-answer', desktop, async page => {
    await waitFor(async () => /正式存储模式/.test(await page.locator('.we2-banner').innerText()));
    const banner = await page.locator('.we2-banner').innerText();
    assert.match(banner, /刷新后保留/);
    assert.equal(await handCount(page), 1);
    await page.locator('.we2-hand summary').click();
    await page.locator('.we2-hand-list', {hasText: '答案：合成书目甲'}).waitFor();
    await shot(page, '01-banner.png');
  });

  await test('02-direct-take-action-persists', desktop, async page => {
    await takeActionViaUi(page);
    assert.equal(await handCount(page), 2);
    await shot(page, '02-take-action.png');
  });

  await test('03-reload-keeps-hand', desktop, async page => {
    await takeActionViaUi(page);
    assert.equal(await handCount(page), 2);
    await page.reload({waitUntil: 'networkidle'});
    await page.locator('.we2-banner').waitFor();
    assert.equal(await handCount(page), 2);
    await shot(page, '03-reload.png');
  });

  await test('04-create-standalone-list-persists', desktop, async page => {
    await page.getByRole('button', {name: '＋ 新建牌堆'}).click();
    await page.locator('.we2-form h2', {hasText: '新建牌堆'}).waitFor();
    await page.locator('.we2-form input').first().fill('我的独立清单');
    await page.locator('.we2-form button', {hasText: '创建牌堆'}).click();
    await page.locator('.we2-grid .act-card').filter({hasText: '我的独立清单'}).waitFor();
    await page.locator('.we2-notice.success').waitFor();
    await page.reload({waitUntil: 'networkidle'});
    await page.locator('.we2-banner').waitFor({timeout: 60000});
    await page.locator('.we2-grid .act-card').filter({hasText: '我的独立清单'}).waitFor();
    await shot(page, '04-standalone-list.png');
  });

  await test('05-synthesis-preview', desktop, async page => {
    await takeActionViaUi(page);
    await openSynthesis(page);
    await chooseSlots(page);
    await page.locator('.we3-fields', {hasText: '合成书目甲'}).waitFor();
    assert.match(await page.locator('.we3-result').getAttribute('class'), /is-filled/);
    assert.equal(await page.locator('.we3-actions button', {hasText: '确认合成'}).isDisabled(), false);
    await shot(page, '05-synthesis-preview.png');
  });

  await test('06-confirm-synthesis-persists', desktop, async page => {
    await takeActionViaUi(page);
    await openSynthesis(page);
    await chooseSlots(page);
    await page.locator('.we3-actions button', {hasText: '确认合成'}).click();
    await page.locator('.we3-done').waitFor();
    await page.getByRole('button', {name: '返回矩阵'}).click();
    await page.locator('.we2-hand').waitFor();
    assert.equal(await handCount(page), 1);
    await page.reload({waitUntil: 'networkidle'});
    await page.locator('.we2-banner').waitFor({timeout: 60000});
    assert.equal(await handCount(page), 1);
    await shot(page, '06-synthesis-done.png');
  });

  await test('07-idb-abort-no-fake-success-then-retry', desktop, async page => {
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put; window.__put = original;
      IDBObjectStore.prototype.put = function (...args) {
        const r = original.apply(this, args);
        if (this.name === 'workspace') this.transaction.abort();
        return r;
      };
    });
    await actionDeckTake(page).click();
    await page.locator('.we2-notice.error').waitFor();
    assert.equal(await handCount(page), 1);
    await page.evaluate(() => {IDBObjectStore.prototype.put = window.__put;});
    await takeActionViaUi(page);
    assert.equal(await handCount(page), 2);
    await shot(page, '07-abort-retry.png');
  });

  await test('08-keyboard-confirm-synthesis', reducedMotion, async page => {
    await takeActionViaUi(page);
    await openSynthesis(page);
    await chooseSlots(page);
    const confirm = page.locator('.we3-actions button', {hasText: '确认合成'});
    await confirm.focus();
    await page.keyboard.press('Enter');
    await page.locator('.we3-done').waitFor();
    await page.getByRole('button', {name: '返回矩阵'}).click();
    await page.locator('.we2-hand').waitFor();
    assert.equal(await handCount(page), 1);
    await shot(page, '08-keyboard.png');
  });

  /* ---------- Narrow (320) ---------- */

  await test('m01-narrow-grid-and-take', narrow, async page => {
    await takeActionViaUi(page);
    assert.equal(await handCount(page), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot(page, 'm01-grid.png');
  });

  await test('m02-narrow-synthesis', narrow, async page => {
    await takeActionViaUi(page);
    await openSynthesis(page);
    await chooseSlots(page);
    await page.locator('.we3-actions button', {hasText: '确认合成'}).click();
    await page.locator('.we3-done').waitFor();
    await page.getByRole('button', {name: '返回矩阵'}).click();
    await page.locator('.we2-hand').waitFor();
    assert.equal(await handCount(page), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot(page, 'm02-synthesis.png');
  });

  /* ---------- Summary ---------- */

  await fs.writeFile(path.join(output, 'v06-a5-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => r.status === 'fail');
  for (const r of results) console.log(`${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.name}`);
  console.log('Evidence:', output);
  if (results.length !== 10 || failed.length) {
    console.error('A5 checks failed:', failed.map(r => r.name));
    process.exit(1);
  }
} finally {
  await server.close();
  if (browser) await browser.close();
}
