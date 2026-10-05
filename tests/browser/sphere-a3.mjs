// A3 browser verification of the neutral Matrix/Sphere (C0.8). Fresh contexts, synthetic cards only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {chromium} = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.CARDGRID_A3_OUTPUT || path.join(os.tmpdir(), `cardgrid-a3-${Date.now()}`);
await fs.mkdir(output, {recursive: true});

const server = await createServer({root, configFile: false, server: {host: '127.0.0.1', port: 0},
  optimizeDeps: {noDiscovery: true, entries: [],
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@js-temporal/polyfill', 'jsbi']},
  plugins: [{name: 'sphere-page', configureServer(vite) {
    vite.middlewares.use((req, res, next) => {
      if (req.url === '/__sphere') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><title>A3 sphere</title><script type="module" src="/tests/browser/sphere-harness.tsx"></script>');
      } else next();
    });
  }}], logLevel: 'error'});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const results = [];
let browser;

const TITLES = ['阅读', '散步', '写作', '运动', '冥想', '整理', '复习', '拉伸', '喝水', '计划', '清扫', '采购'];
const titleOf = k => `${TITLES[(k - 1) % TITLES.length]} ${k}`;
// Wait until the chosen card has finished moving to the stage center (transition settled).
const waitChosenCentered = page => page.waitForFunction(() => {
  const c = document.querySelector('.sphere-card-wrap.is-chosen .sphere-card');
  const s = document.querySelector('.sphere-stage');
  if (!c || !s) return false;
  const cc = c.getBoundingClientRect(), ss = s.getBoundingClientRect();
  return Math.abs((cc.left + cc.right) / 2 - (ss.left + ss.right) / 2) < 24;
}, null, {timeout: 2500});

try {
  browser = await chromium.launch({headless: true,
    ...(process.env.CARDGRID_CHROME_PATH ? {executablePath: process.env.CARDGRID_CHROME_PATH} : {})});

  async function test(name, options, fn) {
    const context = await browser.newContext({serviceWorkers: 'block', ...options});
    const page = await context.newPage();
    const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
    const started = Date.now();
    try {
      await page.goto(origin + '/__sphere', {waitUntil: 'networkidle'});
      await fn(page, pageErrors);
      assert.deepEqual(pageErrors, []);
      results.push({name, status: 'pass', durationMs: Date.now() - started}); console.log('PASS', name);
    } catch (error) {
      await page.screenshot({path: path.join(output, `failure-${name}.png`), fullPage: true}).catch(() => {});
      results.push({name, status: 'fail', error: error.message}); console.error('FAIL', name, error);
    } finally { await context.close(); }
  }

  await test('draw-matrix-keeps-card-backs-and-hides-front-text', {}, async page => {
    assert.equal(await page.locator('.matrix-back').count(), 12);
    // No front title may appear in the matrix DOM / aria.
    assert.equal(await page.getByText(titleOf(1), {exact: true}).count(), 0);
    const labels = await page.locator('.matrix-cell').evaluateAll(els => els.map(e => e.getAttribute('aria-label')));
    assert.ok(labels.every(l => /牌堆 .*（卡背）/.test(l)));
    await page.screenshot({path: path.join(output, 'matrix-draw.png'), fullPage: true});
  });

  await test('two-click-select-then-reveal-keeps-one-id-and-hides-text-until-reveal', {}, async page => {
    await page.locator('.matrix-cell').first().dispatchEvent('click');
    assert.equal(await page.locator('.sphere-world').count(), 1);
    // Before selection: front faces are empty in the DOM.
    assert.ok((await page.locator('.sphere-face-front').allInnerTexts()).every(t => !/阅读|散步|写作|运动|冥想|整理|复习|拉伸|喝水|计划|清扫|采购/.test(t)));

    const k = 4; // choose the 4th card regardless of where the spinning layout put it
    await page.locator('.sphere-card').nth(k - 1).dispatchEvent('click');
    await page.waitForSelector('.sphere-world.motion-presented');
    await waitChosenCentered(page); // chosen card settled at the front
    // Presented but not revealed: still no front text; the chosen card is up front.
    assert.ok((await page.locator('.sphere-face-front').allInnerTexts()).every(t => !/阅读|散步|写作|运动|冥想|整理|复习|拉伸|喝水|计划|清扫|采购/.test(t)));
    assert.equal(await page.locator('.sphere-card-wrap.is-chosen').count(), 1);
    await page.screenshot({path: path.join(output, 'presented.png'), fullPage: true});

    // Second click on the up-front card reveals it; the title must be the same card's.
    await page.locator('.sphere-card-wrap.is-chosen .sphere-card').click();
    await page.waitForSelector('.sphere-world.motion-revealed');
    await waitChosenCentered(page);
    await page.waitForTimeout(650); // wait for the 0.55s flip to finish before asserting/screenshot
    const chosenText = await page.locator('.sphere-card-wrap.is-chosen').innerText();
    assert.match(chosenText, new RegExp(titleOf(k).replace(' ', '\\s')));
    await page.screenshot({path: path.join(output, 'revealed.png'), fullPage: true});

    // Close returns to the matrix.
    await page.getByRole('button', {name: '关闭归位'}).click();
    assert.equal(await page.locator('.matrix-back').count(), 12);
  });

  await test('keyboard-two-step-enter-path-keeps-one-id', {}, async page => {
    await page.locator('.matrix-cell').first().dispatchEvent('click');
    const k = 7, card = page.locator('.sphere-card').nth(k - 1);
    await card.focus();
    await page.keyboard.press('Enter'); // first press -> presented
    await page.waitForSelector('.sphere-world.motion-presented');
    await page.keyboard.press('Enter'); // second press -> revealed
    await page.waitForSelector('.sphere-world.motion-revealed');
    assert.match(await page.locator('.sphere-card-wrap.is-chosen').innerText(),
      new RegExp(titleOf(k).replace(' ', '\\s')));
  });

  await test('edit-mode-shows-card-faces-in-matrix-and-sphere', {}, async page => {
    await page.getByRole('button', {name: /模式/}).click(); // draw -> edit
    assert.equal(await page.locator('.matrix-face').count(), 12);
    assert.match(await page.locator('.matrix-cell').first().innerText(), /阅读 1/);
    await page.locator('.matrix-cell').first().dispatchEvent('click');
    await page.waitForSelector('.sphere-world.motion-idle');
    // Edit sphere shows every face; the front text is legitimately in the DOM here.
    assert.ok((await page.locator('.sphere-face-front strong').count()) >= 1);
    await page.screenshot({path: path.join(output, 'sphere-edit.png'), fullPage: true});
  });

  await test('capacity-10-100-500-render-without-page-errors', {}, async (page, pageErrors) => {
    for (const n of [10, 100, 500]) {
      await page.getByRole('button', {name: `${n} 张`}).click();
      assert.equal(await page.locator('.matrix-cell').count(), n);
      await page.screenshot({path: path.join(output, `cap-${n}.png`), fullPage: true});
    }
    assert.deepEqual(pageErrors, []);
  });

  await test('reduced-motion-shows-static-matrix-and-sphere', {reducedMotion: 'reduce'}, async page => {
    await page.screenshot({path: path.join(output, 'matrix-reduced.png'), fullPage: true});
    await page.locator('.matrix-cell').first().dispatchEvent('click');
    await page.waitForSelector('.sphere-world');
    await page.screenshot({path: path.join(output, 'sphere-reduced.png'), fullPage: true});
  });
} finally {
  await browser?.close(); await server.close();
  await fs.writeFile(path.join(output, 'a3-results.json'), JSON.stringify({at: new Date().toISOString(), results}, null, 2));
  console.log('Evidence:', output);
}
if (results.length !== 6 || results.some(r => r.status !== 'pass')) process.exitCode = 1;
