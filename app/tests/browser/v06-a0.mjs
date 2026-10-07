// v0.6 A0 experience-sample browser check. Fresh contexts, synthetic data only: no personal IDB.
// Drives workshop matrix -> decision flip -> three-slot synthesis -> timeline journal, with the
// fixed hand dock present throughout. Desktop (1280) and narrow (320) passes; evidence under
// test-results/v06-a0. This validates look-and-feel only; it is not the v0.6 acceptance gate.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {chromium} = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.CARDGRID_V06A0_OUTPUT || path.join(root, 'test-results/v06-a0');
await fs.mkdir(output, {recursive: true});

const server = await createServer({root, configFile: false, server: {host: '127.0.0.1', port: 0},
  optimizeDeps: {noDiscovery: true, entries: [],
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@js-temporal/polyfill', 'jsbi']},
  plugins: [{name: 'v06-a0-page', configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (req.url === '/__v06a0') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>v0.6 A0</title><script type="module" src="/tests/browser/v06-a0/v06-a0-harness.tsx"></script>');
      } else next();
    });
  }}], logLevel: 'error'});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const results = [];
let browser;

const shot = (page, name) => page.screenshot({path: path.join(output, name), fullPage: true}).catch(() => {});
const dockCount = async page =>
  Number((await page.locator('.hd6-dock-count').innerText()).trim());
const goScene = async (page, name) =>
  page.getByRole('tab', {name}).click();

try {
  browser = await chromium.launch({headless: true,
    ...(process.env.CARDGRID_CHROME_PATH ? {executablePath: process.env.CARDGRID_CHROME_PATH} : {})});

  async function test(name, options, fn) {
    const context = await browser.newContext({serviceWorkers: 'block', ...options});
    const page = await context.newPage();
    const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
    const started = Date.now();
    try {
      await page.goto(origin + '/__v06a0', {waitUntil: 'networkidle'});
      await fn(page, pageErrors);
      assert.deepEqual(pageErrors, []);
      results.push({name, status: 'pass', durationMs: Date.now() - started}); console.log('PASS', name);
    } catch (error) {
      await page.screenshot({path: path.join(output, `failure-${name}.png`), fullPage: true}).catch(() => {});
      results.push({name, status: 'fail', error: error.message}); console.error('FAIL', name, error);
    } finally { await context.close(); }
  }

  const desktop = {viewport: {width: 1280, height: 900}};
  const narrow = {viewport: {width: 320, height: 680}};

  /* ---------- Desktop ---------- */

  await test('workshop-matrix-and-unbound-list', desktop, async page => {
    assert.equal(await page.getByText(/未连接个人 IndexedDB/).count(), 1);
    assert.equal(await page.locator('.ws6-grid .act-card').count(), 8);
    await shot(page, '01-workshop.png');
    // The URL deck is an unbound standalone list.
    const urlCard = page.locator('.act-card', {hasText: '有用网址'});
    assert.match(await urlCard.innerText(), /未绑定 · 纯清单/);
    await urlCard.getByRole('button', {name: '查看成员'}).click();
    const modal = page.locator('.ws6-modal');
    assert.match(await modal.innerText(), /未绑定任何行动或决策/);
    assert.equal(await modal.locator('.ws6-member').count(), 3);
    assert.ok(await modal.getByText('GitHub').count() >= 1);
    await shot(page, '02-url-members.png');
    await modal.getByRole('button', {name: '关闭'}).click();
  });

  await test('take-action-adds-current-copy-to-dock', desktop, async page => {
    assert.equal(await dockCount(page), 0);
    await page.locator('.act-card', {hasText: '常用行动'})
      .getByRole('button', {name: /直接拿牌：/}).first().click();
    assert.equal(await dockCount(page), 1);
    await page.locator('.hd6-dock').click();
    const panel = page.locator('.hd6-panel');
    assert.equal(await panel.locator('.hd6-group').first().locator('.hd6-card').count(), 1);
    assert.match(await panel.innerText(), /本次/);
    await shot(page, '03-dock-after-take.png');
    await panel.getByRole('button', {name: '关闭手牌'}).click();
  });

  await test('decision-draw-redraw-cancel-manual', desktop, async page => {
    await goScene(page, '决策翻牌');
    assert.equal(await page.getByText('番茄鸡蛋面', {exact: true}).count(), 0);
    await page.getByRole('button', {name: '翻牌抽取'}).click();
    assert.equal(await page.getByText('番茄鸡蛋面', {exact: true}).count(), 1);
    assert.match(await page.locator('.dc6-back').innerText(), /来自「餐食清单」/);
    await page.waitForTimeout(700); // let the 0.55s card flip settle before capturing
    await shot(page, '04-decision-revealed.png');
    await page.getByRole('button', {name: '重抽'}).click();
    assert.equal(await page.getByText('青椒肉丝饭', {exact: true}).count(), 1);
    assert.equal(await page.getByText('番茄鸡蛋面', {exact: true}).count(), 0);
    await page.getByRole('button', {name: '取消'}).click();
    assert.equal(await page.getByText('青椒肉丝饭', {exact: true}).count(), 0);
    await page.getByRole('button', {name: '手选候选'}).click();
    await page.locator('.dc6-candidates button', {hasText: '蔬菜沙拉'}).click();
    assert.equal(await page.getByText('蔬菜沙拉', {exact: true}).count(), 1);
    await page.waitForTimeout(700); // flip settle after manual pick
    await shot(page, '05-decision-manual.png');
  });

  await test('decision-accept-answer-paths', desktop, async page => {
    await goScene(page, '决策翻牌');
    await page.getByRole('button', {name: '翻牌抽取'}).click();
    const before = await dockCount(page);
    await page.getByRole('button', {name: '只取答案'}).click();
    assert.equal(await dockCount(page), before + 1);
    assert.match(await page.locator('.dc6-note').innerText(), /已加入/);
    await page.getByRole('button', {name: '取消'}).click();
    await page.getByRole('button', {name: '翻牌抽取'}).click();
    await page.getByRole('button', {name: /同时拿行动牌/}).click();
    assert.equal(await dockCount(page), before + 3); // answer + action on top of the one answer
  });

  await test('dock-preview-and-today-mode-switch', desktop, async page => {
    await page.locator('.act-card', {hasText: '常用行动'})
      .getByRole('button', {name: /直接拿牌：/}).first().click();
    await page.locator('.hd6-dock').click();
    const panel = page.locator('.hd6-panel');
    assert.equal(await panel.getByRole('button', {name: '打出'}).count(), 0);
    assert.match(await panel.innerText(), /非 Today · 仅预览/);
    await panel.getByText('模拟当前在 Today 页面').click();
    assert.ok(await panel.getByRole('button', {name: '打出'}).count() >= 1);
    await shot(page, '06-dock-today.png');
    await panel.getByText('模拟当前在 Today 页面').click();
    await panel.getByRole('button', {name: '预览'}).first().click();
    const detail = page.locator('.hd6-modal');
    assert.match(await detail.innerText(), /来源/);
    await detail.getByRole('button', {name: '关闭', exact: true}).click();
    await panel.getByRole('button', {name: '关闭手牌'}).click();
  });

  await test('synthesis-preview-conflict-cancel', desktop, async page => {
    await page.getByRole('button', {name: '重置样稿'}).click();
    await goScene(page, '三槽合成');
    assert.match(await page.locator('.syn6-empty').innerText(), /一键准备/);
    await shot(page, '07-synthesis-empty.png');
    await page.getByRole('button', {name: '一键准备两张样稿素材'}).click();
    const slotSelects = page.locator('.syn6-bench select');
    await slotSelects.nth(0).selectOption({index: 1});
    await slotSelects.nth(1).selectOption({index: 1});
    assert.match(await page.locator('.syn6-result').innerText(), /吃饭 · 番茄鸡蛋面/);
    await page.locator('.syn6-check').first().click(); // simulate field conflict
    assert.match(await page.locator('.syn6-conflict').innerText(), /字段冲突/);
    assert.equal(await page.getByRole('button', {name: '确认合成'}).isDisabled(), true);
    await shot(page, '08-synthesis-conflict.png');
    await page.locator('.syn6-check').first().click();
    assert.equal(await page.locator('.syn6-conflict').count(), 0);
    await shot(page, '09-synthesis-preview.png');
    await page.getByRole('button', {name: /取消／清空/}).click();
    assert.equal(await dockCount(page), 2); // materials stay in hand
  });

  await test('synthesis-failure-retry-then-commit', desktop, async page => {
    await page.getByRole('button', {name: '重置样稿'}).click();
    await goScene(page, '三槽合成');
    await page.getByRole('button', {name: '一键准备两张样稿素材'}).click();
    const slotSelects = page.locator('.syn6-bench select');
    await slotSelects.nth(0).selectOption({index: 1});
    await slotSelects.nth(1).selectOption({index: 1});
    await page.locator('.syn6-check').nth(1).click(); // fail next commit
    await page.getByRole('button', {name: '确认合成'}).click();
    assert.match(await page.locator('.syn6-error').innerText(), /可直接重试/);
    // The failed confirm already cleared its own one-shot failure flag; retry directly.
    await page.getByRole('button', {name: '确认合成'}).click();
    assert.match(await page.locator('.syn6-done').innerText(), /合成完成/);
    assert.equal(await dockCount(page), 1);
    await page.locator('.hd6-dock').click();
    const panel = page.locator('.hd6-panel');
    assert.equal(await panel.locator('.hd6-group').nth(2).locator('.hd6-card').count(), 1);
    assert.equal(await panel.locator('.hd6-group').nth(0).locator('.hd6-card').count(), 0);
    assert.equal(await panel.locator('.hd6-group').nth(1).locator('.hd6-card').count(), 0);
    await shot(page, '10-synthesis-committed.png');
  });

  await test('journal-move-breakfast-updates-same-record', desktop, async page => {
    await goScene(page, '时间线日记');
    assert.equal(await page.getByText('00:00–06:00').count(), 1);
    assert.equal(await page.getByText('08:00–08:30').count(), 1);
    assert.equal(await page.getByText('08:12', {exact: true}).count(), 1);
    await shot(page, '11-journal.png');
    await page.getByRole('button', {name: '移到 10:00'}).click();
    assert.equal(await page.getByText('10:00–10:30').count(), 1);
    assert.equal(await page.getByText('08:00–08:30').count(), 0);
    assert.equal(await page.getByText('08:12', {exact: true}).count(), 1); // note untouched
    await shot(page, '12-journal-moved.png');
  });

  await test('journal-retract-keeps-independent-notes', desktop, async page => {
    await goScene(page, '时间线日记');
    await page.getByRole('button', {name: '收回'}).click();
    assert.equal(await page.locator('.jn6-kind-meal').count(), 1); // lunch only
    assert.equal(await page.getByText('08:12', {exact: true}).count(), 1);
    assert.match(await page.locator('.jn6-retracted-note').innerText(), /感想仍保留/);
    await shot(page, '13-journal-retracted.png');
  });

  await test('journal-edit-add-notes-and-file-states', desktop, async page => {
    await goScene(page, '时间线日记');
    await page.locator('.jn6-note', {hasText: '昨晚睡得不错'})
      .getByRole('button', {name: '编辑'}).click();
    const editing = page.locator('.jn6-note', {hasText: '昨晚睡得不错'});
    await editing.locator('textarea').fill('昨晚睡得不错，改一下：做了个好梦。');
    await editing.getByRole('button', {name: '保存修改'}).click();
    assert.equal(await page.getByText('06:10', {exact: true}).count(), 1);
    assert.match(await editing.innerText(), /已修改 08:15/);
    await page.locator('#jn6-draft').fill('样稿：下午想去散步。');
    await page.getByRole('button', {name: '保存随记'}).click();
    assert.equal(await page.getByText('09:30', {exact: true}).count(), 1);
    await shot(page, '14-journal-notes.png');
    const filebar = page.locator('.jn6-filebar');
    await filebar.getByRole('button', {name: '模拟失败'}).click();
    assert.equal(await filebar.getAttribute('data-state'), 'error');
    assert.equal(await filebar.getByRole('button', {name: '重试写入'}).count(), 1);
    await filebar.getByRole('button', {name: '重试写入'}).click();
    assert.equal(await filebar.getAttribute('data-state'), 'synced');
    await shot(page, '15-journal-file.png');
  });

  /* ---------- Narrow (320px) ---------- */

  await test('narrow-workshop-renders', narrow, async page => {
    assert.equal(await page.locator('.ws6-grid .act-card').count(), 8);
    await shot(page, 'm01-workshop.png');
  });

  await test('narrow-decision-draw', narrow, async page => {
    await goScene(page, '决策翻牌');
    await page.getByRole('button', {name: '翻牌抽取'}).click();
    assert.equal(await page.getByText('番茄鸡蛋面', {exact: true}).count(), 1);
    await page.waitForTimeout(700);
    await shot(page, 'm02-decision.png');
  });

  await test('narrow-synthesis-preview', narrow, async page => {
    await goScene(page, '三槽合成');
    await page.getByRole('button', {name: '一键准备两张样稿素材'}).click();
    const slotSelects = page.locator('.syn6-bench select');
    await slotSelects.nth(0).selectOption({index: 1});
    await slotSelects.nth(1).selectOption({index: 1});
    assert.match(await page.locator('.syn6-result').innerText(), /吃饭 · 番茄鸡蛋面/);
    await shot(page, 'm03-synthesis.png');
  });

  await test('narrow-dock-open-close', narrow, async page => {
    await page.locator('.act-card', {hasText: '常用行动'})
      .getByRole('button', {name: /直接拿牌：/}).first().click();
    await page.locator('.hd6-dock').click();
    assert.equal(await page.locator('.hd6-panel').count(), 1);
    await shot(page, 'm04-dock.png');
    await page.locator('.hd6-panel').getByRole('button', {name: '关闭手牌'}).click();
    assert.equal(await page.locator('.hd6-panel').count(), 0);
  });

  await test('narrow-journal-move', narrow, async page => {
    await goScene(page, '时间线日记');
    await shot(page, 'm05-journal.png');
    await page.getByRole('button', {name: '移到 10:00'}).click();
    assert.equal(await page.getByText('10:00–10:30').count(), 1);
    assert.equal(await page.getByText('08:12', {exact: true}).count(), 1);
  });
} finally {
  browser?.close(); await server.close();
  await fs.writeFile(path.join(output, 'v06-a0-results.json'),
    JSON.stringify({at: new Date().toISOString(), results}, null, 2));
  console.log('Evidence:', output);
}
const failed = results.filter(r => r.status !== 'pass');
if (results.length !== 15 || failed.length) {
  console.error('A0 checks failed:', failed.map(r => r.name).join(', '));
  process.exitCode = 1;
}
