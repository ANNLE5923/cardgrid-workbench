// v0.6.4 Today 收尾面板 · 三类边缘场景浏览器验收（合成 IDB，固定时钟）。
//   A. 例行补做：昨天漏做的例行进入今天补录列表；补做新实例落今天、原 occurrence/事实保留、重复幂等。
//   B. 切日/过去日：切到过去日收尾入口与面板隐藏，浏览过去日零写入；切回今天入口恢复。
//   C. 跨日素材到期：23:50–00:20 计划、素材午夜到期，次日面板只读提醒、不阻塞、打开零写入。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output =
  process.env.CARDGRID_DAYCLOSE_OUTPUT || path.join(root, 'test-results/v064-dayclose-edges');
await fs.mkdir(output, { recursive: true });
const { chromium } = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');

const EVENING = '2026-10-06T14:00:00Z'; // 上海 22:00
const YESTERDAY = '2026-10-05';
const TODAY = '2026-10-06';

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: {
    noDiscovery: true,
    entries: [],
    include: [
      'react',
      'react-dom/client',
      'react/jsx-dev-runtime',
      '@js-temporal/polyfill',
      'jsbi',
    ],
  },
  plugins: [
    {
      name: 'dayclose-edges',
      configureServer(v) {
        v.middlewares.use((req, res, next) => {
          if ((req.url ?? '').split('?')[0] === '/__v06daycloseedges') {
            res.setHeader('Content-Type', 'text/html');
            res.end(
              '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/browser/v06-dayclose-edges-harness.tsx"></script>',
            );
          } else next();
        });
      },
    },
  ],
});
await server.listen();
const origin = server.resolvedUrls.local[0].replace(/\/$/, '');

const results = [];
const errors = [];
let browser;
const panel = (p) => p.getByRole('region', { name: '结束今天收尾面板' });
const entry = (p) => p.getByRole('button', { name: '结束今天 · 收尾检查', exact: true });
const data = (p) => p.evaluate(() => window.__edges.cg.data());
const getRev = async (p) => (await p.evaluate(() => window.__edges.cg.token())).revision;

async function newPage(context, scenario, at) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(`[${scenario}] ${e.message}`));
  await page.clock.setFixedTime(new Date(at));
  await page.goto(
    origin + '/__v06daycloseedges?scenario=' + scenario + '&at=' + encodeURIComponent(at),
  );
  await page.locator('.dial-svg').waitFor();
  return page;
}

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CARDGRID_CHROME_PATH
      ? { executablePath: process.env.CARDGRID_CHROME_PATH }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    timezoneId: 'Asia/Shanghai',
    serviceWorkers: 'block',
    reducedMotion: 'reduce',
  });

  // ============ A + B：例行补做 & 切日/过去日（同一数据集） ============
  let page = await newPage(context, 'makeup', EVENING);

  // 打开今天收尾面板：昨天漏做的例行出现在补录区。
  await entry(page).click();
  await panel(page).waitFor();
  const before = await data(page);
  const oldOcc = before.planner.occurrences.find((o) => o.date === YESTERDAY);
  assert.ok(oldOcc, '应有一条昨天的例行 occurrence');
  assert.equal(oldOcc.disposition, 'generated');
  const oldInstanceId = oldOcc.instanceId;
  const makeupBlock = panel(page).locator('[data-block="makeup"]');
  await makeupBlock.waitFor();
  const makeupLi = makeupBlock.locator(`[data-occurrence-id="${oldOcc.id}"]`);
  await makeupLi.waitFor();
  await makeupLi.getByText(`${YESTERDAY} 的例行安排`).waitFor();
  const makeupBtn = makeupLi.getByRole('button', { name: '补做到今天', exact: true });
  await makeupBtn.waitFor();
  assert.equal(before.planner.facts.length, 0, '补做前无事实');
  assert.equal(
    before.planner.instances.filter((i) => i.makeupOf?.id === oldOcc.id).length,
    0,
    '补做前无补录实例',
  );
  results.push({ name: 'A1-makeup-entry-lists-yesterday-routine', status: 'pass' });

  // 点击补做：新实例落今天、指向旧 occurrence；原 occurrence/实例保留、不造事实。
  const revBefore = await getRev(page);
  await makeupBtn.click();
  await page.waitForFunction((occId) => {
    const region = document.querySelector('[aria-label="结束今天收尾面板"]');
    return !!region && region.querySelectorAll(`[data-occurrence-id="${occId}"]`).length === 0;
  }, oldOcc.id);
  const after = await data(page);
  const makeups = after.planner.instances.filter((i) => i.makeupOf?.id === oldOcc.id);
  assert.equal(makeups.length, 1, '补做后恰好 1 个补录实例');
  assert.equal(makeups[0].targetDate, TODAY, '补录实例 targetDate=今天');
  assert.equal(makeups[0].state, 'open');
  assert.equal(makeups[0].occurrenceId, null, '补录实例不是新 occurrence 副本');
  // 原 occurrence / 原实例保留，事实仍为 0。
  assert.ok(
    after.planner.occurrences.some((o) => o.id === oldOcc.id && o.date === YESTERDAY),
    '原 occurrence 保留',
  );
  const oldInst = after.planner.instances.find((i) => i.id === oldInstanceId);
  assert.ok(oldInst && oldInst.state === 'open', '原实例保留且仍 open');
  assert.equal(after.planner.facts.length, 0, '补做不伪造事实');
  assert.ok((await getRev(page)) > revBefore, '补做产生一次真实写入');
  // 补录实例进入今天的表盘手牌（落在今天）。
  const todayHand = await page.evaluate((d0) => window.__edges.readDay(d0), TODAY);
  assert.ok(
    (todayHand.hand ?? []).some((h) => h.instanceId === makeups[0].id),
    '补录实例应进入今天手牌',
  );
  results.push({ name: 'A2-makeup-creates-today-instance-preserves-origin', status: 'pass' });

  // 幂等：再次对同一 occurrence 补做（直接发命令，模拟重复点击/重试），不产生第二个实例。
  const replay = await page.evaluate(
    async (arg) => {
      await window.__edges.plain('CreateMakeup', {
        occurrence: { kind: 'occurrence', id: arg.occId },
        targetDate: arg.today,
      });
      const d = await window.__edges.cg.data();
      return d.planner.instances.filter((i) => i.makeupOf?.id === arg.occId).length;
    },
    { occId: oldOcc.id, today: TODAY },
  );
  assert.equal(replay, 1, '重复补做幂等，不重复创建');
  results.push({ name: 'A3-makeup-idempotent-on-repeat', status: 'pass' });

  // ============ B：切到过去日，入口/面板隐藏且零写入；切回今天恢复 ============
  await page.getByRole('button', { name: '收起收尾面板', exact: true }).click();
  await panel(page).waitFor({ state: 'detached' });
  const dateInput = page.locator('input[aria-label="日期"]');
  const revAtPast = await getRev(page);
  await dateInput.fill(YESTERDAY);
  await page.waitForTimeout(300);
  assert.equal(await entry(page).count(), 0, '过去日不显示收尾入口');
  assert.equal(await panel(page).count(), 0, '过去日不显示收尾面板');
  const revAfterPast = await getRev(page);
  assert.equal(revAfterPast, revAtPast, '浏览过去日零写入');
  await page.screenshot({ path: path.join(output, 'B-pastday-hidden.png'), fullPage: true });
  results.push({ name: 'B1-pastday-hides-panel-zero-write', status: 'pass' });

  await dateInput.fill(TODAY);
  await page.waitForTimeout(300);
  await entry(page).waitFor();
  await entry(page).click();
  await panel(page).waitFor();
  // 已补做后补录区不再出现该例行（幂等结果在切日往返后保持）。
  assert.equal(
    await panel(page).locator(`[data-occurrence-id="${oldOcc.id}"]`).count(),
    0,
    '切回今天后已补做例行不再提示',
  );
  results.push({ name: 'B2-back-to-today-restores-entry', status: 'pass' });
  await page.screenshot({ path: path.join(output, 'A-makeup-done.png'), fullPage: true });
  await page.close();

  // ============ C：跨日素材到期（只读提醒、不阻塞、打开零写入） ============
  const MATERIAL_AT = '2026-10-12T16:25:00Z'; // 上海 10-13 00:25，计划 00:20 已结束、素材 00:00 已到期
  page = await newPage(context, 'material', MATERIAL_AT);
  const revC0 = await getRev(page);
  await entry(page).click();
  await panel(page).waitFor();
  const locked = panel(page).locator('[data-block="locked"] li');
  await locked.first().waitFor();
  assert.equal(await locked.count(), 1, '恰好 1 条只读锁定（跨日到期素材）');
  const panelText = await panel(page).innerText();
  assert.match(panelText, /绑定素材已到期/, '应显示“绑定素材已到期”只读提醒');
  assert.doesNotMatch(panelText, /历史日期只读|例行原日已锁定/, '不得误判为历史/例行锁定');
  // 只读锁定项没有任何可写按钮。
  assert.equal(
    await panel(page).locator('[data-block="locked"] button').count(),
    0,
    '锁定区无写操作按钮',
  );
  // 不阻塞：可直接完成回顾。
  await panel(page).getByRole('button', { name: '完成今天回顾', exact: true }).waitFor();
  // 打开面板零写入。
  assert.equal(await getRev(page), revC0, '打开到期面板零写入');
  await page.screenshot({ path: path.join(output, 'C-material-expired.png'), fullPage: true });
  results.push({
    name: 'C1-cross-midnight-material-readonly-nonblocking-zerowrite',
    status: 'pass',
  });
  await page.close();

  assert.deepEqual(errors, []);
  console.log('ALL PASS');
} catch (e) {
  console.error('FAIL', e);
  try {
    const pg = browser?._pages;
  } catch {}
  results.push({ name: 'error', status: 'fail', error: String(e && e.stack) });
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        scope: 'v0.6.4 day-close edge scenarios (makeup / past-day / material-expiry)',
        passed: results.filter((r) => r.status === 'pass').length,
        failed: results.filter((r) => r.status !== 'pass').length,
        pageErrors: errors,
        results,
      },
      null,
      2,
    ),
  );
}
