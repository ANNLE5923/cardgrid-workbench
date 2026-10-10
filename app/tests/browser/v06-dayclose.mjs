// v0.6.4 Today 收尾面板 · 带数据浏览器全链路验收（合成 IDB，固定时钟）。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output =
  process.env.CARDGRID_DAYCLOSE_OUTPUT || path.join(root, 'test-results/v064-dayclose');
await fs.mkdir(output, { recursive: true });
const { chromium } = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');

const MORNING = '2026-10-06T00:12:00Z'; // 08:12 Asia/Shanghai
const EVENING = '2026-10-06T14:00:00Z'; // 22:00 Asia/Shanghai，09:00 的计划已结束

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
      name: 'dayclose',
      configureServer(v) {
        v.middlewares.use((req, res, next) => {
          if ((req.url ?? '').split('?')[0] === '/__v06dayclose') {
            res.setHeader('Content-Type', 'text/html');
            res.end(
              '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/browser/v06-dayclose-harness.tsx"></script>',
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
let browser;
let page;
const errors = [];
const data = (p) => p.evaluate(() => cg.data());
const activePlans = (d) => d.planner.plans.filter((x) => x.status === 'active');
const panel = (p) => p.getByRole('region', { name: '结束今天收尾面板' });
const entry = (p) => p.getByRole('button', { name: '结束今天 · 收尾检查', exact: true });
const dock = (p) => p.getByRole('dialog', { name: '本次手牌', exact: true });

async function placeComposite(p) {
  // Today 表盘极坐标卡片上的“打出”；固定 Dock 收起时其按钮不可见，role 只命中可见的一个。
  const play = p.getByRole('button', { name: '打出', exact: true }).first();
  await play.waitFor();
  await play.click();
  const dlg = p.getByRole('dialog', { name: '排期与重叠确认', exact: true });
  await dlg.waitFor();
  await dlg.getByRole('button', { name: '确认排期', exact: true }).click();
  await dlg.waitFor({ state: 'detached' });
  await p.getByText(/已排计划（1）/).waitFor();
}
async function openPanel(p) {
  await entry(p).click();
  await panel(p).waitFor();
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
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (e) => errors.push(e.message));

  // ---- 阶段一：早晨把合成行动排到 09:00（未来），另留一张行动卡在手牌 ----
  await page.clock.setFixedTime(new Date(MORNING));
  await page.goto(origin + '/__v06dayclose');
  await page.locator('.dial-svg').waitFor();
  await page.getByRole('button', { name: '打出', exact: true }).first().waitFor();
  await placeComposite(page);
  const morning = await data(page);
  assert.equal(activePlans(morning).length, 1, '早晨应有 1 条活动计划');
  assert.equal(morning.planner.facts.length, 0, '尚未确认事实');
  const planStart = activePlans(morning)[0].range.startAt;
  assert.ok(planStart.includes('T01:00'), `计划应在上海 09:00（UTC 01:00），实际 ${planStart}`);
  const plainCard = morning.handCards.find(
    (c) =>
      c.kind === 'action' &&
      c.state === 'available' &&
      c.consumedBy === null &&
      c.actionInstanceId &&
      c.contentSnapshot.title.includes('{对象}'),
  );
  assert.ok(plainCard, '应有一张留在手牌的普通行动卡');
  results.push({ name: 'morning-placement', status: 'pass' });

  // ---- 阶段二：推进到当晚 22:00，重载，09:00 计划成为“待核实” ----
  await page.clock.setFixedTime(new Date(EVENING));
  await page.goto(origin + '/__v06dayclose?at=' + encodeURIComponent(EVENING));
  await page.locator('.dial-svg').waitFor();
  await page.getByText(/已排计划（1）/).waitFor();
  await openPanel(page);
  await panel(page).getByText('还有 1 项安排过了时间、没确认').waitFor();
  await panel(page).getByText('还有 1 项待核实').waitFor();
  assert.equal((await data(page)).planner.facts.length, 0);
  await page.screenshot({ path: path.join(output, '1-blocked.png'), fullPage: true });
  results.push({ name: 'evening-shows-blocking-unverified', status: 'pass' });

  // ---- “确认 / 改期”只跳回表盘，零写入：计划仍在、面板关闭、重开仍阻塞 ----
  await panel(page).getByRole('button', { name: '确认 / 改期', exact: true }).first().click();
  await panel(page).waitFor({ state: 'detached' });
  assert.equal(activePlans(await data(page)).length, 1, '跳表盘不得撤回计划');
  await openPanel(page);
  await panel(page).getByText('还有 1 项待核实').waitFor();
  results.push({ name: 'confirm-reschedule-jump-is-zero-write', status: 'pass' });

  // ---- 撤回安排：直接 RetractPlan，阻塞解除，canClose 变真 ----
  await panel(page).getByRole('button', { name: '撤回安排', exact: true }).first().click();
  await panel(page).getByRole('button', { name: '完成今天回顾', exact: true }).waitFor();
  const afterRetract = await data(page);
  assert.equal(activePlans(afterRetract).length, 0, '撤回后无活动计划');
  assert.equal(afterRetract.planner.facts.length, 0, '撤回不得伪造事实');
  assert.ok(afterRetract.planner.plans.every((x) => x.status === 'retracted'));
  // 表盘必须随面板命令实时刷新（同标签页 App 代发也要同步），不能停留在旧计划。
  await page.getByRole('heading', { name: '已排计划（0）', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认实际', exact: true }).count(), 0);
  results.push({ name: 'retract-unblocks-without-fact', status: 'pass' });

  // ---- 收回仍留在手牌的普通行动卡：WithdrawInstance ----
  const handKey = 'material:' + plainCard.id;
  const handLi = panel(page).locator(`[data-hand-key="${handKey}"]`);
  await handLi.waitFor();
  await handLi.getByRole('button', { name: '收回手牌', exact: true }).click();
  await page.waitForFunction(async (id) => {
    const d = await cg.data();
    const inst = d.planner.instances.find((i) => i.id === id);
    return inst?.state === 'withdrawn';
  }, plainCard.actionInstanceId);
  await page.waitForFunction((key) => {
    const region = document.querySelector('[aria-label="结束今天收尾面板"]');
    return !!region && region.querySelectorAll(`[data-hand-key="${key}"]`).length === 0;
  }, handKey);
  assert.equal(
    await panel(page).locator(`[data-hand-key="${handKey}"]`).count(),
    0,
    '收回后该项离开手牌',
  );
  results.push({ name: 'withdraw-hand-instance', status: 'pass' });

  // ---- 完成回顾：轻反馈出现，可关闭 ----
  await panel(page).getByRole('button', { name: '完成今天回顾', exact: true }).click();
  await panel(page).getByText('今天到这里就闭环了').waitFor();
  await page.screenshot({ path: path.join(output, '2-done.png'), fullPage: true });
  await panel(page).getByRole('button', { name: '收起提示', exact: true }).click();
  assert.equal(await panel(page).getByText('今天到这里就闭环了').count(), 0);
  results.push({ name: 'finish-light-feedback', status: 'pass' });

  assert.deepEqual(errors, []);
  console.log('ALL PASS');
} catch (e) {
  console.error('FAIL', e);
  try {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    console.log('BODY:\n', (await page.locator('body').innerText()).slice(0, 4000));
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
        scope: 'v0.6.4 day-close panel data-bearing acceptance',
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
