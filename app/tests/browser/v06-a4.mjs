// v0.6 A4 decision-matrix browser check. Fresh contexts, synthetic seed only:
// no personal IndexedDB. Drives question face -> explicit draw -> fixed answer,
// plus manual pick, redraw/cancel, answer-only vs answer+action accept, and the
// empty-candidate state. Desktop (1280) and narrow (320). Extra candidates and
// decisions are prepared via window.__host (test fixture); the matrix itself
// never randomizes or writes.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {chromium} = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.CARDGRID_V06A4_OUTPUT || path.join(root, 'test-results/v06-a4');
await fs.mkdir(output, {recursive: true});

const server = await createServer({root, configFile: false, server: {host: '127.0.0.1', port: 0},
  optimizeDeps: {noDiscovery: true, entries: [],
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@js-temporal/polyfill', 'jsbi']},
  plugins: [{name: 'v06-a4-page', configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (req.url === '/__v06a4') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>v0.6 A4</title><div id="root"></div><script type="module" src="/tests/browser/v06-a4/v06-a4-harness.tsx"></script>');
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
      await page.goto(origin + '/__v06a4', {waitUntil: 'networkidle'});
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

  const pickDecision = (page, label) =>
    page.locator('select[aria-label="选择决策"]').selectOption({label});
  const waitFront = page => waitFor(async () =>
    (await page.locator('.dm6-flip').getAttribute('class')) === 'dm6-flip', {label: 'front face'});
  const addBookB = page => page.evaluate(async () => {
    const h = window.__host;
    await h.saveEntry({draft: {id: 'book-b', version: 1, title: '合成书目乙', attributes: {}, url: null,
      status: 'active', source: {kind: 'manual'}}, expectedVersion: null});
    const cat = (await h.readCatalog()).value.data;
    const books = cat.decks.find(d => d.id === 'books');
    await h.saveDeck({draft: {...books, memberIds: [...books.memberIds, 'book-b']}, expectedVersion: 1});
  });
  const addEmptyDecision = page => page.evaluate(async () => {
    const h = window.__host;
    await h.saveDecision({draft: {id: 'read-empty', version: 1, question: '空候选？', ownerActionId: 'read',
      deckIds: ['empty-list'], mappings: [{fieldId: 'subject', entryPath: 'title'}], status: 'active',
      source: {kind: 'manual'}}, expectedVersion: null});
  });

  /* ---------- Desktop ---------- */

  await test('matrix-random-answer-only', desktop, async page => {
    await pickDecision(page, '读哪本？（which-book）');
    await waitMatch(page.locator('.dm6-front'), /候选 1 个/);
    await shot(page, '01-front.png');
    await page.getByRole('button', {name: '翻牌抽取'}).click();
    await page.waitForTimeout(700);
    await waitMatch(page.locator('.dm6-back'), /合成书目甲/);
    await waitMatch(page.locator('.dm6-stable'), /答案已固定/);
    await shot(page, '02-back.png');
    await page.getByRole('button', {name: '只取答案'}).click();
    await waitMatch(page.locator('.dm6-note'), /已加入本次手牌/);
    await waitMatch(page.locator('.a4h-hand'), /本次手牌：1 张/);
    await shot(page, '03-accepted.png');
  });

  await test('matrix-manual-with-action', desktop, async page => {
    await addBookB(page);
    await page.getByRole('button', {name: '刷新决策列表'}).click();
    await pickDecision(page, '读哪本？（which-book）');
    await page.getByRole('button', {name: '手选候选'}).click();
    await waitMatch(page.locator('.dm6-manual'), /手选/);
    assert.equal(await page.locator('.dm6-candidates button').count(), 2);
    await shot(page, '04-manual.png');
    await page.locator('.dm6-candidates button', {hasText: '合成书目乙'}).click();
    await page.waitForTimeout(700);
    await waitMatch(page.locator('.dm6-back'), /合成书目乙/);
    await shot(page, '05-manual-back.png');
    await page.getByRole('button', {name: '同时拿行动牌'}).click();
    await waitMatch(page.locator('.dm6-note'), /已加入本次手牌/);
    await waitMatch(page.locator('.a4h-hand'), /本次手牌：2 张/);
    await shot(page, '06-with-action.png');
  });

  await test('matrix-cancel-keeps-empty', desktop, async page => {
    await pickDecision(page, '读哪本？（which-book）');
    await page.getByRole('button', {name: '翻牌抽取'}).click();
    await page.waitForTimeout(700);
    await waitMatch(page.locator('.dm6-back'), /合成书目甲/);
    await page.getByRole('button', {name: '取消'}).click();
    await waitFront(page);
    await waitMatch(page.locator('.a4h-hand'), /本次手牌：0 张/);
    await shot(page, '07-cancel.png');
  });

  await test('matrix-empty-candidates', desktop, async page => {
    await addEmptyDecision(page);
    await page.getByRole('button', {name: '刷新决策列表'}).click();
    await pickDecision(page, '空候选？（read-empty）');
    await waitMatch(page.locator('.dm6-front'), /没有可用条目/);
    assert.equal(await page.getByRole('button', {name: '翻牌抽取'}).isDisabled(), true);
    await shot(page, '08-empty.png');
  });

  /* ---------- Narrow (320) ---------- */

  await test('narrow-pick-front', narrow, async page => {
    await pickDecision(page, '读哪本？（which-book）');
    await waitMatch(page.locator('.dm6-front'), /候选 1 个/);
    await shot(page, 'm01-front.png');
  });

  await test('narrow-draw-back', narrow, async page => {
    await pickDecision(page, '读哪本？（which-book）');
    await page.getByRole('button', {name: '翻牌抽取'}).click();
    await page.waitForTimeout(700);
    await waitMatch(page.locator('.dm6-back'), /合成书目甲/);
    await shot(page, 'm02-back.png');
  });

  await test('narrow-manual-panel', narrow, async page => {
    await addBookB(page);
    await page.getByRole('button', {name: '刷新决策列表'}).click();
    await pickDecision(page, '读哪本？（which-book）');
    await page.getByRole('button', {name: '手选候选'}).click();
    await waitMatch(page.locator('.dm6-manual'), /手选/);
    assert.equal(await page.locator('.dm6-candidates button').count(), 2);
    await shot(page, 'm03-manual.png');
  });

  await test('narrow-answer-only', narrow, async page => {
    await pickDecision(page, '读哪本？（which-book）');
    await page.getByRole('button', {name: '翻牌抽取'}).click();
    await page.waitForTimeout(700);
    await page.getByRole('button', {name: '只取答案'}).click();
    await waitMatch(page.locator('.a4h-hand'), /本次手牌：1 张/);
    await shot(page, 'm04-accepted.png');
  });

  await test('narrow-empty-candidate', narrow, async page => {
    await addEmptyDecision(page);
    await page.getByRole('button', {name: '刷新决策列表'}).click();
    await pickDecision(page, '空候选？（read-empty）');
    await waitMatch(page.locator('.dm6-front'), /没有可用条目/);
    assert.equal(await page.getByRole('button', {name: '翻牌抽取'}).isDisabled(), true);
    await shot(page, 'm05-empty.png');
  });

  /* ---------- Summary ---------- */

  await fs.writeFile(path.join(output, 'v06-a4-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => r.status === 'fail');
  for (const r of results) console.log(`${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.name}`);
  console.log('Evidence:', output);
  if (results.length !== 9 || failed.length) {
    console.error('A4 checks failed:', failed.map(r => r.name));
    process.exit(1);
  }
} finally {
  await server.close();
  if (browser) await browser.close();
}
