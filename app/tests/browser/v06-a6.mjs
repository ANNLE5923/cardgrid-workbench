// v0.6 A6 timeline-journal browser check. Fresh contexts, synthetic data only
// (no IndexedDB/personal data/real files). Drives TimelineJournalV06 against
// the in-memory test adapter: automatic segments interleaved with reflections,
// add/edit reflection (original vs updated time), retract keeping reflections
// (P16), move updating the same row (P13), file error/permission flows, a
// read-only archive, and narrow 320. Keyboard editing is A7.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {chromium} = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.CARDGRID_V06A6_OUTPUT || path.join(root, 'test-results/v06-a6');
await fs.mkdir(output, {recursive: true});

const server = await createServer({root, configFile: false, server: {host: '127.0.0.1', port: 0},
  optimizeDeps: {noDiscovery: true, entries: [],
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@js-temporal/polyfill', 'jsbi']},
  plugins: [{name: 'v06-a6-page', configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (req.url === '/__v06a6') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>v0.6 A6</title><div id="root"></div><script type="module" src="/tests/browser/v06-a6/v06-a6-harness.tsx"></script>');
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
const rowCount = page => page.locator('.tj6-timeline > article').count();
const breakfastSeg = page => page.locator('.tj6-seg').filter({hasText: '早餐'});

try {
  browser = await chromium.launch({headless: true,
    ...(process.env.CARDGRID_CHROME_PATH ? {executablePath: process.env.CARDGRID_CHROME_PATH} : {})});

  async function test(name, options, fn) {
    const context = await browser.newContext({serviceWorkers: 'block', ...options});
    const page = await context.newPage();
    const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
    const started = Date.now();
    try {
      await page.goto(origin + '/__v06a6', {waitUntil: 'networkidle'});
      await page.locator('.tj6-banner').waitFor({timeout: 60000});
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

  // Warm up Vite's first-time full transform chain. Throwaway context.
  {
    const warmContext = await browser.newContext({serviceWorkers: 'block'});
    const warmPage = await warmContext.newPage();
    await warmPage.goto(origin + '/__v06a6', {waitUntil: 'networkidle'});
    await warmPage.locator('.tj6-banner').waitFor({timeout: 120000});
    await warmContext.close();
  }

  /* ---------- Desktop ---------- */

  await test('01-initial-timeline', desktop, async page => {
    await page.locator('.tj6-file-synced').waitFor();
    assert.equal(await rowCount(page), 3);
    await page.locator('.tj6-legacy-block').waitFor();
    await shot(page, '01-initial.png');
  });

  await test('02-add-reflection-marks-pending', desktop, async page => {
    await page.locator('.tj6-compose textarea').fill('新写下的感想');
    await page.getByRole('button', {name: '保存随记'}).click();
    await page.locator('.tj6-file-pending').waitFor();
    assert.equal(await rowCount(page), 4);
    await shot(page, '02-add.png');
  });

  await test('03-edit-reflection-shows-updated-time', desktop, async page => {
    await page.evaluate(() => window.session.setNow('2026-10-06T01:30:00Z'));
    await page.getByRole('button', {name: '编辑'}).click();
    await page.locator('.tj6-edit textarea').fill('修改后的感想');
    await page.getByRole('button', {name: '保存修改'}).click();
    await page.locator('.tj6-modified', {hasText: '修改于 09:30'}).waitFor();
    await shot(page, '03-edit.png');
  });

  await test('04-retract-breakfast-keeps-reflection', desktop, async page => {
    await page.getByRole('button', {name: /测试：收回/}).click();
    await waitFor(async () => (await rowCount(page)) === 2);
    assert.equal(await breakfastSeg(page).count(), 0);
    assert.equal(await page.locator('.tj6-note').count(), 1);
    await shot(page, '04-retract.png');
  });

  await test('05-move-breakfast-to-ten', desktop, async page => {
    await page.getByRole('button', {name: /测试：移到 10:00/}).click();
    await breakfastSeg(page).locator('time', {hasText: '10:00'}).waitFor();
    await shot(page, '05-move.png');
  });

  await test('06-file-error-then-retry', desktop, async page => {
    await page.getByRole('button', {name: /测试：模拟失败/}).click();
    await page.locator('.tj6-file-error').waitFor();
    await page.getByRole('button', {name: '重试写入'}).click();
    await page.locator('.tj6-file-synced').waitFor();
    await shot(page, '06-error.png');
  });

  await test('07-permission-then-reauthorize', desktop, async page => {
    await page.getByRole('button', {name: /测试：模拟失权/}).click();
    await page.locator('.tj6-file-permission-required').waitFor();
    await page.getByRole('button', {name: '重新授权后写入'}).click();
    await page.locator('.tj6-file-synced').waitFor();
    await shot(page, '07-permission.png');
  });

  await test('08-archive-read-only', desktop, async page => {
    await page.getByRole('button', {name: /历史归档/}).click();
    await page.locator('.tj6-archive-flag').waitFor();
    await page.locator('.tj6-readonly').waitFor();
    assert.equal(await page.locator('.tj6-compose').count(), 0);
    await shot(page, '08-archive.png');
  });

  /* ---------- Narrow (320) ---------- */

  await test('m01-narrow-add-reflection', narrow, async page => {
    await page.locator('.tj6-compose textarea').fill('窄屏感想');
    await page.getByRole('button', {name: '保存随记'}).click();
    assert.equal(await rowCount(page), 4);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot(page, 'm01-add.png');
  });

  await test('m02-narrow-retract', narrow, async page => {
    await page.getByRole('button', {name: /测试：收回/}).click();
    await waitFor(async () => (await rowCount(page)) === 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await shot(page, 'm02-retract.png');
  });

  /* ---------- Summary ---------- */

  await fs.writeFile(path.join(output, 'v06-a6-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => r.status === 'fail');
  for (const r of results) console.log(`${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.name}`);
  console.log('Evidence:', output);
  if (results.length !== 10 || failed.length) {
    console.error('A6 checks failed:', failed.map(r => r.name));
    process.exit(1);
  }
} finally {
  await server.close();
  if (browser) await browser.close();
}
