// v0.6 A2 workshop-editor browser check. Fresh contexts, synthetic seed only:
// no personal IndexedDB. The desktop pass is one continuous, stateful editing
// flow (create deck/entry/decision, reorder and move members, take materials,
// and trigger an inline cycle error). Narrow (320) passes are self-contained.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {chromium} = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.CARDGRID_V06A2_OUTPUT || path.join(root, 'test-results/v06-a2');
await fs.mkdir(output, {recursive: true});

const server = await createServer({root, configFile: false, server: {host: '127.0.0.1', port: 0},
  optimizeDeps: {noDiscovery: true, entries: [],
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@js-temporal/polyfill', 'jsbi']},
  plugins: [{name: 'v06-a2-page', configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (req.url === '/__v06a2') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>v0.6 A2</title><div id="root"></div><script type="module" src="/tests/browser/v06-a2/v06-a2-harness.tsx"></script>');
      } else next();
    });
  }}], logLevel: 'error'});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const results = [];
let browser;

const shot = (page, name) => page.screenshot({path: path.join(output, name), fullPage: true}).catch(() => {});

// Minimal polling waits (the project depends on `playwright`, not @playwright/test).
const waitFor = async (fn, {timeout = 8000, label = 'condition'} = {}) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {if (await fn()) return;} catch (e) {last = e;}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`waitFor timed out (${label})${last ? `: ${last.message}` : ''}`);
};
const waitCount = (loc, n) => waitFor(async () => (await loc.count()) === n, {label: `count === ${n}`});
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
      await page.goto(origin + '/__v06a2', {waitUntil: 'networkidle'});
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

  const cardByName = (page, name) =>
    page.locator('.we2-grid .act-card', {has: page.locator('.act-titles strong', {hasText: name})});
  const openDeckMembers = async (page, name) => {
    await cardByName(page, name).getByRole('button', {name: '管理成员'}).click();
    return page.locator('.we2-modal');
  };
  const createEntry = async (page, title, deckLabel) => {
    await page.getByRole('button', {name: '＋ 新建条目'}).click();
    const form = page.locator('.we2-form');
    await form.locator('input').first().fill(title);
    await form.locator('select').nth(1).selectOption({label: deckLabel});
    await form.getByRole('button', {name: '创建条目'}).click();
  };

  /* ---------- Desktop: one continuous editing flow ---------- */

  await test('full-workshop-editing-flow', desktop, async page => {
    // 1. Initial matrix (6 decks; empty list renders its empty state).
    assert.equal(await page.getByText(/内存编辑模式/).count(), 1);
    assert.equal(await page.locator('.we2-grid .act-card').count(), 6);
    assert.match(await cardByName(page, '空清单').innerText(), /空牌堆/);
    await shot(page, '01-matrix.png');

    // 2. Create deck "周末计划".
    await page.getByRole('button', {name: '＋ 新建牌堆'}).click();
    let form = page.locator('.we2-form');
    await form.locator('input').first().fill('周末计划');
    await form.getByRole('button', {name: '创建牌堆'}).click();
    assert.equal(await page.locator('.we2-grid .act-card').count(), 7);
    await shot(page, '02-create-deck.png');

    // 3-4. Two entries into the new deck.
    await createEntry(page, '复盘', '周末计划');
    await createEntry(page, '散步', '周末计划');
    assert.match(await cardByName(page, '周末计划').innerText(), /2 个成员/);
    await shot(page, '03-create-entry.png');

    // 5. Parent the deck to 书目.
    await cardByName(page, '周末计划').getByRole('button', {name: '编辑牌堆'}).click();
    form = page.locator('.we2-form');
    await form.locator('select').nth(1).selectOption({label: '书目'});
    await form.getByRole('button', {name: '保存牌堆'}).click();
    assert.match(await cardByName(page, '周末计划').innerText(), /父牌堆：书目/);
    await shot(page, '04-deck-parent.png');

    // 6. Reorder: move 散步 above 复盘.
    let modal = await openDeckMembers(page, '周末计划');
    assert.deepEqual(await modal.locator('.we2-member strong').allInnerTexts(), ['复盘', '散步']);
    await modal.locator('.we2-member', {hasText: '散步'}).getByRole('button', {name: '上移'}).click();
    assert.deepEqual(await modal.locator('.we2-member strong').allInnerTexts(), ['散步', '复盘']);
    await shot(page, '05-reorder.png');
    await modal.getByRole('button', {name: '关闭'}).click();

    // 7. Move 复盘 out to 书目.
    modal = await openDeckMembers(page, '周末计划');
    await modal.locator('.we2-move-group').nth(0).locator('select').selectOption({label: '书目'});
    await modal.locator('.we2-member', {hasText: '复盘'}).getByRole('button', {name: '移动到…'}).click();
    await waitCount(modal.locator('.we2-member'), 1);
    await modal.getByRole('button', {name: '关闭'}).click();
    assert.match(await cardByName(page, '周末计划').innerText(), /1 个成员/);
    assert.match(await cardByName(page, '书目').innerText(), /2 个成员/);

    // 8. Move food-a in from 餐食 to 书目.
    modal = await openDeckMembers(page, '书目');
    const group = modal.locator('.we2-move-group').nth(1);
    await group.locator('select').nth(0).selectOption({label: '餐食'});
    await group.locator('select').nth(1).selectOption({label: '合成餐食甲'});
    await group.getByRole('button', {name: '移入'}).click();
    await waitCount(modal.locator('.we2-member'), 3);
    await modal.getByRole('button', {name: '关闭'}).click();
    assert.match(await cardByName(page, '书目').innerText(), /3 个成员/);
    await shot(page, '06-move-in.png');

    // 9. Take an action material directly from the action deck.
    await cardByName(page, '行动原卡').getByRole('button', {name: /直接拿牌/}).first().click();
    const hand = page.locator('.we2-hand');
    await waitMatch(hand.locator('summary'), /1 张/);
    await hand.locator('summary').click();
    await waitMatch(hand.locator('.we2-hand-list'), /阅读/);
    await shot(page, '07-take-action.png');

    // 10. Take an entry material from the standalone list.
    modal = await openDeckMembers(page, '独立清单');
    await modal.locator('.we2-member', {hasText: '合成网址'}).getByRole('button', {name: '拿牌'}).click();
    await waitMatch(page.locator('.we2-notice.success'), /手牌/);
    await modal.getByRole('button', {name: '关闭'}).click();
    await waitMatch(page.locator('.we2-hand summary'), /2 张/);
    await shot(page, '08-take-entry.png');

    // 11. Create a decision with a candidate deck and a mapping.
    await page.getByRole('button', {name: '＋ 新建决策'}).click();
    form = page.locator('.we2-form');
    await form.locator('input').first().fill('周末做啥？');
    await form.locator('.we2-check', {hasText: '独立清单'}).locator('input').check();
    await form.getByRole('button', {name: '＋ 添加映射'}).click();
    await form.getByRole('button', {name: '创建决策'}).click();
    assert.match(await cardByName(page, '独立清单').innerText(), /决策候选：周末做啥？/);
    await shot(page, '09-decision.png');

    // 12. Parenting 书目 to its own descendant 周末计划 must fail with a cycle.
    await cardByName(page, '书目').getByRole('button', {name: '编辑牌堆'}).click();
    form = page.locator('.we2-form');
    await form.locator('select').nth(1).selectOption({label: '周末计划'});
    await form.getByRole('button', {name: '保存牌堆'}).click();
    const notice = page.locator('.we2-notice.error');
    await waitMatch(notice, /PARENT_CYCLE/);
    // A failed save keeps the form open; cancel back to the matrix, then confirm
    // 书目 was not changed (still has no parent).
    await form.getByRole('button', {name: '取消'}).click();
    const booksText = await cardByName(page, '书目').innerText();
    assert.equal(/父牌堆/.test(booksText), false); // not saved
    await shot(page, '10-cycle-error.png');
  });

  /* ---------- Narrow (320), each self-contained ---------- */

  await test('narrow-matrix-renders', narrow, async page => {
    assert.equal(await page.locator('.we2-grid .act-card').count(), 6);
    await shot(page, 'm01-matrix.png');
  });

  await test('narrow-create-deck', narrow, async page => {
    await page.getByRole('button', {name: '＋ 新建牌堆'}).click();
    const form = page.locator('.we2-form');
    await form.locator('input').first().fill('窄屏堆');
    await form.getByRole('button', {name: '创建牌堆'}).click();
    assert.equal(await page.locator('.we2-grid .act-card').count(), 7);
    await shot(page, 'm02-create.png');
  });

  await test('narrow-members-open', narrow, async page => {
    const modal = await openDeckMembers(page, '行动原卡');
    assert.equal(await modal.locator('.we2-member').count(), 3);
    await shot(page, 'm03-members.png');
  });

  await test('narrow-take-action', narrow, async page => {
    const modal = await openDeckMembers(page, '行动原卡');
    await modal.locator('.we2-member', {hasText: '阅读'}).getByRole('button', {name: '拿牌'}).click();
    await waitMatch(page.locator('.we2-notice.success'), /手牌/);
    await modal.getByRole('button', {name: '关闭'}).click();
    await waitMatch(page.locator('.we2-hand summary'), /1 张/);
    await shot(page, 'm04-take.png');
  });

  await test('narrow-create-decision', narrow, async page => {
    await page.getByRole('button', {name: '＋ 新建决策'}).click();
    const form = page.locator('.we2-form');
    await form.locator('input').first().fill('窄屏决策？');
    await form.locator('.we2-check', {hasText: '书目'}).locator('input').check();
    await form.getByRole('button', {name: '创建决策'}).click();
    assert.match(await cardByName(page, '书目').innerText(), /窄屏决策？/);
    await shot(page, 'm05-decision.png');
  });

  /* ---------- Summary ---------- */

  await fs.writeFile(path.join(output, 'v06-a2-results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => r.status === 'fail');
  for (const r of results) console.log(`${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.name}`);
  console.log('Evidence:', output);
  if (results.length !== 6 || failed.length) {
    console.error('A2 checks failed:', failed.map(r => r.name));
    process.exit(1);
  }
} finally {
  await server.close();
  if (browser) await browser.close();
}
