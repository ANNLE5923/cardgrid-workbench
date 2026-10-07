// v0.6 A3 synthesis-bench browser check. Fresh contexts, synthetic seed only:
// no personal IndexedDB. Answer materials are staged via window.__host (the
// accepted-answer UI ships in A4). Drives slot selection, the result preview,
// per-field conflict resolution, missing-required and owner-mismatch states,
// and the atomic confirm. Desktop (1280) and narrow (320).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {chromium} = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.CARDGRID_V06A3_OUTPUT || path.join(root, 'test-results/v06-a3');
await fs.mkdir(output, {recursive: true});

const server = await createServer({root, configFile: false, server: {host: '127.0.0.1', port: 0},
  optimizeDeps: {noDiscovery: true, entries: [],
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@js-temporal/polyfill', 'jsbi']},
  plugins: [{name: 'v06-a3-page', configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (req.url === '/__v06a3') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>v0.6 A3</title><div id="root"></div><script type="module" src="/tests/browser/v06-a3/v06-a3-harness.tsx"></script>');
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
const waitMatch = (loc, re) => waitFor(async () => re.test(await loc.innerText()), {label: re.toString()});

try {
  browser = await chromium.launch({headless: true,
    ...(process.env.CARDGRID_CHROME_PATH ? {executablePath: process.env.CARDGRID_CHROME_PATH} : {})});

  async function test(name, options, fn) {
    const context = await browser.newContext({serviceWorkers: 'block', ...options});
    const page = await context.newPage();
    const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
    const started = Date.now();
    try {
      await page.goto(origin + '/__v06a3', {waitUntil: 'networkidle'});
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

  const openBench = page => page.getByRole('button', {name: '三槽合成台'}).click();
  const slot1 = page => page.locator('select[aria-label="槽 1 · 本次行动"]');
  const slot2 = page => page.locator('select[aria-label="槽 2 · 本次答案"]');

  /* ---------- Desktop ---------- */

  await test('bench-happy-confirm', desktop, async page => {
    await page.evaluate(async () => {
      const h = window.__host;
      await h.takeAction({action: {id: 'read', version: 1}});
      await h.stageAnswerMaterial({decision: {id: 'which-book', version: 1}, entry: {id: 'book-a', version: 1}});
    });
    await openBench(page);
    await slot1(page).selectOption({label: '行动：阅读《{对象}》'});
    await slot2(page).selectOption({label: '答案：合成书目甲'});
    await waitMatch(page.locator('.we3-result'), /可确认/);
    assert.match(await page.locator('.we3-fields').innerText(), /合成书目甲/);
    assert.equal(await page.locator('.we3-conflicts').count(), 0);
    await shot(page, '01-preview.png');

    await page.getByRole('button', {name: '确认合成'}).click();
    await waitMatch(page.locator('.we3-done'), /合成完成/);
    await shot(page, '02-confirmed.png');
    await page.getByRole('button', {name: '返回矩阵'}).click();
    await waitMatch(page.locator('.we2-hand summary'), /1 张/);
    await shot(page, '03-matrix-after.png');
  });

  await test('bench-conflict-keep-replace', desktop, async page => {
    await page.evaluate(async () => {
      const h = window.__host;
      await h.saveEntry({draft: {id: 'book-b', version: 1, title: '合成书目乙', attributes: {}, url: null,
        status: 'active', source: {kind: 'manual'}}, expectedVersion: null});
      const cat = (await h.readCatalog()).value.data;
      const books = cat.decks.find(d => d.id === 'books');
      await h.saveDeck({draft: {...books, memberIds: [...books.memberIds, 'book-b']}, expectedVersion: 1});
      // First synthesis -> composite subject 甲.
      const a = (await h.takeAction({action: {id: 'read', version: 1}})).value.card;
      const ans = (await h.stageAnswerMaterial({decision: {id: 'which-book', version: 1},
        entry: {id: 'book-a', version: 1}})).value.card;
      const p = (await h.previewSynthesis({inputs: [{id: a.id, version: a.version},
        {id: ans.id, version: ans.version}], resolutions: []})).value;
      await h.confirmSynthesis({previewId: p.previewId});
      // Second answer 乙.
      await h.stageAnswerMaterial({decision: {id: 'which-book', version: 1}, entry: {id: 'book-b', version: 1}});
    });
    await openBench(page);
    await slot1(page).selectOption({label: '行动：阅读《{对象}》'});
    await slot2(page).selectOption({label: '答案：合成书目乙'});
    await waitMatch(page.locator('.we3-conflicts'), /同字段冲突/);
    assert.match(await page.locator('.we3-conflict-head span').innerText(), /合成书目甲[\s\S]*合成书目乙/);
    assert.equal(await page.getByRole('button', {name: '确认合成'}).isDisabled(), true);
    await shot(page, '04-conflict.png');

    await page.locator('.we3-radio', {hasText: '采用新值'}).locator('input').click();
    await waitMatch(page.locator('.we3-result'), /可确认/);
    await page.getByRole('button', {name: '确认合成'}).click();
    await waitMatch(page.locator('.we3-done'), /合成完成/);
    await shot(page, '05-conflict-resolved.png');
  });

  await test('bench-missing-required', desktop, async page => {
    await page.evaluate(async () => {
      const h = window.__host;
      await h.saveDecision({draft: {id: 'read-nomap', version: 1, question: '无映射？', ownerActionId: 'read',
        deckIds: ['books'], mappings: [], status: 'active', source: {kind: 'manual'}}, expectedVersion: null});
      await h.takeAction({action: {id: 'read', version: 1}});
      await h.stageAnswerMaterial({decision: {id: 'read-nomap', version: 1}, entry: {id: 'book-a', version: 1}});
    });
    await openBench(page);
    await slot1(page).selectOption({label: '行动：阅读《{对象}》'});
    await slot2(page).selectOption({label: '答案：合成书目甲'});
    await waitMatch(page.locator('.we3-missing'), /待补全/);
    assert.equal(await page.getByRole('button', {name: '确认合成'}).isDisabled(), true);
    await shot(page, '06-missing.png');
  });

  await test('bench-owner-mismatch', desktop, async page => {
    await page.evaluate(async () => {
      const h = window.__host;
      await h.takeAction({action: {id: 'read', version: 1}});
      await h.stageAnswerMaterial({decision: {id: 'which-food', version: 1}, entry: {id: 'food-a', version: 1}});
    });
    await openBench(page);
    await slot1(page).selectOption({label: '行动：阅读《{对象}》'});
    await slot2(page).selectOption({label: '答案：合成餐食甲'});
    await waitMatch(page.locator('.we3-error'), /ACTION_OWNER_MISMATCH/);
    await shot(page, '07-owner-mismatch.png');
  });

  /* ---------- Narrow (320) ---------- */

  await test('narrow-bench-renders', narrow, async page => {
    await page.evaluate(async () => {
      const h = window.__host;
      await h.takeAction({action: {id: 'read', version: 1}});
      await h.stageAnswerMaterial({decision: {id: 'which-book', version: 1}, entry: {id: 'book-a', version: 1}});
    });
    await openBench(page);
    assert.equal(await slot1(page).count(), 1);
    assert.equal(await slot2(page).count(), 1);
    await shot(page, 'm01-bench.png');
  });

  await test('narrow-select-preview', narrow, async page => {
    await page.evaluate(async () => {
      const h = window.__host;
      await h.takeAction({action: {id: 'read', version: 1}});
      await h.stageAnswerMaterial({decision: {id: 'which-book', version: 1}, entry: {id: 'book-a', version: 1}});
    });
    await openBench(page);
    await slot1(page).selectOption({label: '行动：阅读《{对象}》'});
    await slot2(page).selectOption({label: '答案：合成书目甲'});
    await waitMatch(page.locator('.we3-preview'), /成品预览/);
    await shot(page, 'm02-preview.png');
  });

  await test('narrow-conflict-choice', narrow, async page => {
    await page.evaluate(async () => {
      const h = window.__host;
      await h.saveEntry({draft: {id: 'book-b', version: 1, title: '合成书目乙', attributes: {}, url: null,
        status: 'active', source: {kind: 'manual'}}, expectedVersion: null});
      const cat = (await h.readCatalog()).value.data;
      const books = cat.decks.find(d => d.id === 'books');
      await h.saveDeck({draft: {...books, memberIds: [...books.memberIds, 'book-b']}, expectedVersion: 1});
      const a = (await h.takeAction({action: {id: 'read', version: 1}})).value.card;
      const ans = (await h.stageAnswerMaterial({decision: {id: 'which-book', version: 1},
        entry: {id: 'book-a', version: 1}})).value.card;
      const p = (await h.previewSynthesis({inputs: [{id: a.id, version: a.version},
        {id: ans.id, version: ans.version}], resolutions: []})).value;
      await h.confirmSynthesis({previewId: p.previewId});
      await h.stageAnswerMaterial({decision: {id: 'which-book', version: 1}, entry: {id: 'book-b', version: 1}});
    });
    await openBench(page);
    await slot1(page).selectOption({label: '行动：阅读《{对象}》'});
    await slot2(page).selectOption({label: '答案：合成书目乙'});
    await waitMatch(page.locator('.we3-conflicts'), /同字段冲突/);
    await page.locator('.we3-radio', {hasText: '采用新值'}).locator('input').click();
    await waitMatch(page.locator('.we3-result'), /可确认/);
    await shot(page, 'm03-conflict.png');
  });

  await test('narrow-confirm', narrow, async page => {
    await page.evaluate(async () => {
      const h = window.__host;
      await h.takeAction({action: {id: 'read', version: 1}});
      await h.stageAnswerMaterial({decision: {id: 'which-book', version: 1}, entry: {id: 'book-a', version: 1}});
    });
    await openBench(page);
    await slot1(page).selectOption({label: '行动：阅读《{对象}》'});
    await slot2(page).selectOption({label: '答案：合成书目甲'});
    await waitMatch(page.locator('.we3-result'), /可确认/);
    await page.getByRole('button', {name: '确认合成'}).click();
    await waitMatch(page.locator('.we3-done'), /合成完成/);
    await shot(page, 'm04-done.png');
  });

  await test('narrow-empty-state', narrow, async page => {
    await openBench(page);
    assert.match(await page.locator('.we3-empty').innerText(), /还没有可合成的本次素材/);
    await shot(page, 'm05-empty.png');
  });

  /* ---------- Summary ---------- */

  await fs.writeFile(path.join(output, 'v06-a3-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => r.status === 'fail');
  for (const r of results) console.log(`${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.name}`);
  console.log('Evidence:', output);
  if (results.length !== 9 || failed.length) {
    console.error('A3 checks failed:', failed.map(r => r.name));
    process.exit(1);
  }
} finally {
  await server.close();
  if (browser) await browser.close();
}
