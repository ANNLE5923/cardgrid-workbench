// A0 author interaction checks in fresh synthetic browser contexts.
// Playwright is an external test prerequisite; production dependencies are unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {serve} from './server.mjs';
const directory = fileURLToPath(new URL('.', import.meta.url));
const root = path.resolve(directory, '../../../../..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = process.env.CARDGRID_A0_OUTPUT ?? path.join(root, 'test-results', 'workshop-a0', stamp);
await fs.mkdir(out, {recursive: true});
const {chromium} = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE ?? 'playwright');
const server = serve(0); await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({headless: true, executablePath: process.env.CARDGRID_CHROME_PATH});
const browserVersion = browser.version();
const results = [];
const scene = page => page.locator('.scene-panel').last();
const detail = page => page.locator('.detail-panel').last();
const act = (container, action) => container.locator(`[data-action="${action}"]`);
async function start(page, params = '') {await page.goto(origin + '/?' + params); await page.locator('.page-heading h1').waitFor();}
async function openActions(page, params = 'view=drawing&still=1') {
  await start(page, params); await page.locator('.matrix-grid [data-pool="actions"]').click();
}
async function choose(page, id) {
  const card = scene(page).locator(`[data-action="pick"][data-card-id="${id}"]`);
  await card.focus(); await page.keyboard.press('Enter');
}
async function flip(page) {await act(scene(page), 'reveal').click(); await detail(page).waitFor();}
async function check(id, fn, options = {}) {
  const ctx = await browser.newContext({viewport: options.viewport ?? {width: 1280, height: 960}, timezoneId: 'Asia/Shanghai', reducedMotion: options.reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block'});
  await ctx.addInitScript(() => {
    window.__a0StorageAttempts = [];
    indexedDB.open = function() {window.__a0StorageAttempts.push('indexedDB.open'); throw new Error('A0 must not open a database');};
    for (const name of ['setItem', 'removeItem', 'clear']) {
      Storage.prototype[name] = function() {window.__a0StorageAttempts.push(name); throw new Error('A0 must not mutate storage');};
    }
  });
  const page = await ctx.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  const row = {id, status: 'passed', observations: {}};
  try {
    await fn(page, row.observations);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__a0StorageAttempts), []);
    assert.deepEqual(await page.evaluate(() => indexedDB.databases()), []);
    assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  } catch (error) {
    row.status = 'failed'; row.error = String(error.stack ?? error); row.pageErrors = errors;
    row.observations.ui = await page.locator('body').innerText().catch(() => '');
  } finally {
    await page.screenshot({path: path.join(out, id + '.png')}).catch(() => {});
    results.push(row); console.log(id + ': ' + row.status + (row.error ? ' ' + row.error.split('\n')[0] : ''));
    await ctx.close();
  }
}

try {
  await check('A01-matrix-and-layer-pause', async (p, o) => {
    await start(p); assert.equal(await p.locator('.deck-tile').count(), 6);
    assert.equal(await p.locator('#matrix').getAttribute('data-motion'), 'running');
    await p.screenshot({path: path.join(out, 'workshop-desktop.png')});
    await p.locator('.matrix-grid [data-pool="actions"]').click();
    assert.equal(await p.locator('#matrix').getAttribute('data-motion'), 'paused');
    assert.equal(await p.locator('.deck-art').first().evaluate(el => el.getAnimations()[0].playState), 'paused');
    assert.equal(await scene(p).locator('.scene-stage').getAttribute('data-motion'), 'running');
    await choose(p, 'action-walk-1');
    assert.equal(await scene(p).locator('.scene-stage').getAttribute('data-motion'), 'paused');
    await act(detail(p), 'return-card').click();
    assert.equal(await scene(p).locator('.scene-stage').getAttribute('data-motion'), 'running');
    assert.equal(await p.evaluate(() => document.activeElement.dataset.cardId), 'action-walk-1');
    await act(scene(p), 'close-scene').click();
    assert.equal(await p.locator('#matrix').getAttribute('data-motion'), 'running');
    assert.equal(await p.evaluate(() => document.activeElement.dataset.pool), 'actions');
    o.result = 'Matrix pauses under sphere; sphere pauses under detail; focus returns to the same card and pool.';
  });
  await check('A02-directory-depth-and-return', async (p, o) => {
    await start(p, 'still=1'); await p.locator('.matrix-grid [data-pool="learning"]').click();
    const order = await scene(p).locator('[data-order]').getAttribute('data-order');
    await choose(p, 'books'); assert.equal(await p.locator('.scene-panel').count(), 2);
    assert.equal(await p.locator('.scene-layer').first().getAttribute('inert'), '');
    await act(scene(p), 'close-scene').click();
    assert.equal(await scene(p).locator('[data-order]').getAttribute('data-order'), order);
    assert.equal(await p.evaluate(() => document.activeElement.dataset.cardId), 'books');
    o.result = 'Returning to the parent preserves its card order and focus.';
  });
  await check('A03-edit-only-in-memory', async (p, o) => {
    await openActions(p, 'view=workshop&display=list&still=1'); await choose(p, 'action-walk-1');
    await detail(p).getByLabel('行动名称', {exact: true}).fill('午后散步 · 样稿修改');
    await detail(p).getByRole('button', {name: '保留样稿修改', exact: true}).click();
    assert.match(await detail(p).innerText(), /仅在当前页面有效/);
    await p.keyboard.press('Escape'); await choose(p, 'action-walk-1');
    assert.equal(await detail(p).getByLabel('行动名称', {exact: true}).inputValue(), '午后散步 · 样稿修改');
    await p.reload(); await p.locator('.matrix-grid [data-pool="actions"]').click(); await choose(p, 'action-walk-1');
    assert.equal(await detail(p).getByLabel('行动名称', {exact: true}).inputValue(), '出去走一走');
    o.result = 'Editing survives reopening, and refresh restores the synthetic source.';
  });
  await check('A04-two-clicks-same-card-and-no-leak', async (p, o) => {
    await openActions(p);
    const before = await scene(p).locator('[data-order]').getAttribute('data-order');
    assert.doesNotMatch(await p.locator('body').evaluate(el => el.innerHTML), /出去走一走|阅读《\{书名\}》/);
    const selectedId = await scene(p).locator('.orbit-card').evaluateAll(cards => cards.sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex))[0].dataset.cardId);
    const card = scene(p).locator(`[data-card-id="${selectedId}"]`);
    const point = await card.boundingBox();
    // A real pointer click on a stationary card (manual static path).
    await p.mouse.click(point.x + point.width / 2, point.y + point.height / 2);
    assert.equal(await scene(p).getAttribute('data-phase'), 'front');
    assert.equal(await act(scene(p), 'reveal').getAttribute('data-card-id'), selectedId);
    assert.equal(await detail(p).count(), 0);
    assert.doesNotMatch(await p.locator('body').evaluate(el => el.innerHTML), /出去走一走|阅读《\{书名\}》/);
    await p.screenshot({path: path.join(out, 'drawing-front.png')});
    await scene(p).locator('[data-action="pick"][data-card-id="action-reading-0"]').evaluate(el => el.click());
    assert.equal(await act(scene(p), 'reveal').getAttribute('data-card-id'), selectedId);
    await flip(p);
    assert.equal(await detail(p).getAttribute('data-card-id'), selectedId);
    assert.ok((await detail(p).locator('h3').innerText()).length > 0);
    assert.equal(await scene(p).locator('[data-order]').getAttribute('data-order'), before);
    o.id = selectedId;
  });
  await check('A05-immediate-random-stable-and-manual-slot', async (p, o) => {
    await openActions(p, 'view=drawing&display=list&still=1'); await choose(p, 'action-reading-0'); await flip(p);
    const choice = p.locator('#book-choice');
    assert.equal(await choice.inputValue(), '');
    assert.equal(await choice.locator('option').nth(0).getAttribute('disabled'), '');
    assert.equal(await choice.locator('option').nth(1).getAttribute('value'), 'random');
    assert.equal(await act(detail(p), 'accept').isDisabled(), true);
    await choice.selectOption('random'); const selected = await choice.inputValue();
    assert.match(selected, /^book-/); assert.equal(await act(detail(p), 'accept').isEnabled(), true);
    const title = await detail(p).locator('h3').innerText();
    await act(detail(p), 'slot-sphere').click(); await act(scene(p), 'close-scene').click();
    assert.equal(await choice.inputValue(), selected); assert.equal(await detail(p).locator('h3').innerText(), title);
    await act(detail(p), 'return-card').click(); await choose(p, 'action-reading-0'); await flip(p);
    assert.equal(await choice.inputValue(), selected);
    await choice.selectOption('book-2'); assert.equal(await detail(p).locator('h3').innerText(), '阅读《设计心理学》');
    o.immediateSelection = selected; o.result = 'Selection survives rerender, cancelled nested selection and reopening the same card.';
  });
  await check('A06-optional-nested-sphere-return', async (p, o) => {
    await openActions(p, 'view=drawing&display=list&still=1'); await choose(p, 'action-reading-0'); await flip(p);
    await p.locator('#book-choice').selectOption('book-0'); await act(detail(p), 'slot-sphere').click();
    assert.equal(await p.locator('.scene-panel').count(), 2);
    assert.doesNotMatch(await scene(p).evaluate(el => el.innerHTML), /深度工作|设计心理学/);
    await choose(p, 'book-2'); await flip(p); await act(detail(p), 'use-book').click();
    assert.equal(await p.locator('.scene-panel').count(), 1);
    assert.equal(await p.locator('#book-choice').inputValue(), 'book-2');
    assert.equal(await detail(p).locator('h3').innerText(), '阅读《设计心理学》');
    assert.equal(await p.evaluate(() => document.activeElement.dataset.action), 'slot-sphere');
    await p.screenshot({path: path.join(out, 'reading-composition.png')});
    o.result = 'Optional book sphere returns the chosen term into the same action draft.';
  });
  await check('A07-cancel-does-not-create-hand', async p => {
    await openActions(p, 'view=drawing&display=list&still=1'); await choose(p, 'action-reading-0'); await flip(p);
    await p.locator('#book-choice').selectOption('random');
    await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
    assert.match(await p.locator('#hand-title').innerText(), /00/); assert.equal(await p.locator('.hand-copy').count(), 0);
  });
  await check('A08-repeat-accept-distinct-copies', async (p, o) => {
    await openActions(p, 'view=drawing&display=list&still=1'); await choose(p, 'action-walk-1'); await flip(p);
    assert.equal(await p.locator('#book-choice').count(), 0); assert.equal(await act(detail(p), 'accept').isEnabled(), true);
    await act(detail(p), 'accept').click(); await act(detail(p), 'accept').click(); await act(detail(p), 'view-hand').click();
    assert.match(await p.locator('.hand-stack summary').innerText(), /×2/);
    await p.locator('.hand-stack summary').click();
    const ids = await p.locator('.hand-copy').evaluateAll(els => els.map(el => el.dataset.instanceId));
    assert.equal(new Set(ids).size, 2);
    assert.equal(await p.locator('.hand-copy').count(), 2);
    assert.match(await p.locator('.hand-copy').first().innerText(), /来源 2026-10-04/);
    await p.screenshot({path: path.join(out, 'hand-stack.png')}); o.ids = ids;
  });
  await check('A09-book-fields-and-empty-pool', async p => {
    await start(p, 'still=1&display=list'); await p.locator('.matrix-grid [data-pool="books"]').click(); await choose(p, 'book-0');
    assert.equal(await detail(p).getByLabel('书名', {exact: true}).inputValue(), '深度工作');
    assert.equal(await detail(p).getByLabel('作者', {exact: true}).inputValue(), '卡尔·纽波特');
    assert.equal(await detail(p).locator('[name="minutes"]').count(), 0);
    await act(scene(p), 'close-all').evaluate(el => el.click()); // Under detail: close-all must not bypass the active layer.
    assert.equal(await p.locator('.scene-panel').count(), 1);
    await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
    await p.locator('.matrix-grid [data-pool="empty"]').click();
    assert.equal(await scene(p).locator('[data-action="pick"]').count(), 0);
    assert.match(await scene(p).innerText(), /空池不选卡/);
  });
  await check('A10-mode-switch-and-new-entry-shuffle', async (p, o) => {
    await openActions(p, 'view=workshop&still=1');
    const editOrder = await scene(p).locator('[data-order]').getAttribute('data-order');
    assert.match(await scene(p).innerText(), /出去走一走/);
    await scene(p).locator('[data-mode="draw"]').click();
    assert.equal(await scene(p).locator('.card-face').count(), 0);
    assert.doesNotMatch(await scene(p).evaluate(el => el.innerHTML), /出去走一走/);
    const order = await scene(p).locator('[data-order]').getAttribute('data-order');
    assert.deepEqual(new Set(order.split(',')), new Set(editOrder.split(',')));
    await act(scene(p), 'close-scene').click(); await p.locator('.matrix-grid [data-pool="actions"]').click();
    const reentered = await scene(p).locator('[data-order]').getAttribute('data-order');
    // Record actual permutation; statistical equality is possible and is not a correctness failure.
    o.editOrder = editOrder; o.switchedOrder = order; o.reenteredOrder = reentered;
  });
  await check('A11-keyboard-trap-and-return', async p => {
    await openActions(p, 'view=drawing&display=list&still=1'); await choose(p, 'action-walk-1');
    assert.equal(await p.evaluate(() => document.activeElement.dataset.action), 'reveal');
    await p.keyboard.press('Enter');
    await act(detail(p), 'accept').focus(); await p.keyboard.press('Tab');
    assert.equal(await detail(p).evaluate(el => el.contains(document.activeElement)), true);
    await act(detail(p), 'return-card').focus(); await p.keyboard.press('Shift+Tab');
    assert.equal(await detail(p).evaluate(el => el.contains(document.activeElement)), true);
    await p.keyboard.press('Escape'); assert.equal(await p.evaluate(() => document.activeElement.dataset.cardId), 'action-walk-1');
    await p.keyboard.press('Escape'); assert.equal(await p.evaluate(() => document.activeElement.dataset.pool), 'actions');
  });
  for (const width of [720, 390, 320]) {
    await check('A12-responsive-' + width, async (p, o) => {
      await start(p, 'view=drawing&still=1');
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await p.locator('.matrix-grid [data-pool="actions"]').click();
      assert.equal(await scene(p).locator('.card-list').count(), width <= 650 ? 1 : 0);
      await choose(p, 'action-reading-0'); await flip(p); await p.locator('#book-choice').selectOption('book-2');
      const box = await detail(p).boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width);
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await act(detail(p), 'accept').scrollIntoViewIfNeeded(); await act(detail(p), 'accept').click();
      assert.match(await detail(p).innerText(), /增加了 1 份/);
      o.layout = {width, listByDefault: width <= 650, dialogWidth: box.width};
      await p.screenshot({path: path.join(out, `reading-${width}.png`)});
      if (width <= 650) {
        await act(detail(p), 'return-card').click(); await act(scene(p), 'toggle-display').click();
        assert.equal(await scene(p).locator('.sphere-surface').count(), 1);
        assert.equal(await scene(p).locator('.scene-stage').getAttribute('data-motion'), 'paused');
        const fits = await scene(p).locator('.orbit-card').evaluateAll(cards => cards.every(card => {
          const box = card.getBoundingClientRect(), stage = card.closest('.scene-stage').getBoundingClientRect();
          return box.x >= stage.x && box.x + box.width <= stage.x + stage.width && box.y >= stage.y && box.y + box.height <= stage.y + stage.height;
        }));
        assert.equal(fits, true); o.layout.optionalSphere = 'static; all ten sample cards fit the viewport';
      }
    }, {viewport: {width, height: 844}});
  }
  await check('A13-system-reduced-motion', async p => {
    await start(p, 'view=drawing'); assert.equal(await p.locator('#matrix').getAttribute('data-motion'), 'paused');
    await p.locator('.matrix-grid [data-pool="actions"]').click(); assert.equal(await scene(p).locator('.card-list').count(), 1);
    await act(scene(p), 'toggle-display').click(); assert.equal(await scene(p).locator('.sphere-surface').count(), 1);
    const before = await scene(p).locator('.orbit-card').first().getAttribute('style');
    await p.waitForTimeout(200); assert.equal(await scene(p).locator('.orbit-card').first().getAttribute('style'), before);
    assert.equal(await act(scene(p), 'toggle-still').isDisabled(), true);
  }, {reduced: true});
  await check('A14-today-and-subordinate-archive-entry', async p => {
    await start(p, 'view=today'); await p.getByRole('button', {name: '去抽卡 ↗', exact: true}).click();
    assert.equal(await p.locator('.page-heading h1').innerText(), '抽卡手牌');
    await act(p, 'archive').click(); assert.match(await p.getByRole('dialog', {name: '副本归档样例'}).innerText(), /已有完成事实与批注继续保留/);
    await p.keyboard.press('Escape'); assert.equal(await p.evaluate(() => document.activeElement.dataset.action), 'archive');
  });
  for (const count of [10, 100]) {
    await check('A15-density-' + count, async (p, o) => {
      await start(p, `count=${count}&view=drawing`);
      const started = await p.evaluate(() => performance.now());
      await p.locator('.matrix-grid [data-pool="actions"]').click(); await scene(p).locator('.orbit-card').last().waitFor();
      o.openMilliseconds = Math.round(await p.evaluate(start => performance.now() - start, started));
      assert.equal(await scene(p).locator('.orbit-card').count(), count);
      const samples = await p.evaluate(() => new Promise(resolve => {
        const stamps = []; const collect = now => {stamps.push(now); if (stamps.length < 61) requestAnimationFrame(collect); else resolve(stamps.slice(1).map((value, i) => value - stamps[i]));}; requestAnimationFrame(collect);
      }));
      samples.sort((a, b) => a - b); o.frameMedianMilliseconds = +samples[Math.floor(samples.length / 2)].toFixed(2); o.frameP95Milliseconds = +samples[Math.floor(samples.length * .95)].toFixed(2);
      o.estimatedMedianFPS = +(1000 / o.frameMedianMilliseconds).toFixed(1);
      await p.screenshot({path: path.join(out, `density-${count}-sphere.png`)});
      await act(scene(p), 'toggle-display').click(); assert.equal(await scene(p).locator('.pick-item').count(), count);
      const last = await scene(p).locator('.pick-item').last().getAttribute('data-card-id'); await choose(p, last); await flip(p);
      assert.equal(await detail(p).getAttribute('data-card-id'), last);
      o.result = 'All sample cards are reachable via the static list. Measurements are local evidence, not a production capacity promise.';
    });
  }
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  const report = {task: 'A0', role: 'author', syntheticOnly: true, productionPersistence: false, clientDate: '2026-10-04', at: new Date().toISOString(), browser: browserVersion, node: process.version, platform: process.platform, viewport: '1280x960; 720/390/320x844', performanceNote: 'Headless requestAnimationFrame intervals are local scheduling measurements, not display FPS or a capacity guarantee.', passed: results.filter(r => r.status === 'passed').length, failed: results.filter(r => r.status === 'failed').length, results};
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({passed: report.passed, failed: report.failed, evidence: out}));
  if (report.failed) process.exitCode = 1;
}
