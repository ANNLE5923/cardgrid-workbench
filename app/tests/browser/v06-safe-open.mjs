// v0.6.5 P0-A Data v5 只读安全打开面 · 带数据浏览器全链路验收。
//   1. 合法 v5 正常进入 Today；
//   2. 直接改坏 IDB workspace/current 后重开 → 进入只读安全面（失败原因/集合/恢复点）；
//   3. 打开安全面零写入；安全面内没有任何编辑/出牌/确认入口；
//   4. 可导出当前原文、可导出 previous 恢复点原文；
//   5. 未修复时点重试仍停留安全面；用 previous 修复 current 后重试 → 回到 Today。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output =
  process.env.CARDGRID_SAFEOPEN_OUTPUT || path.join(root, 'test-results/v065-safeopen');
await fs.mkdir(output, { recursive: true });
const { chromium } = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');

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
      name: 'v065-safeopen',
      configureServer(v) {
        v.middlewares.use((req, res, next) => {
          if ((req.url ?? '').split('?')[0] === '/__v06safeopen') {
            res.setHeader('Content-Type', 'text/html');
            res.end(
              '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/browser/v06-safe-open-harness.tsx"></script>',
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
const safe = (p) => p.locator('.safe-recovery');
const safeHeading = (p) => p.getByRole('heading', { name: '安全打开（只读）' });
const api = (p) => p.evaluateHandle(() => window.__safeopen);

async function waitApi(page) {
  await page.waitForFunction(() => !!window.__safeopen, null, { timeout: 15000 });
}
async function call(page, fnName, ...args) {
  return page.evaluate(
    async ({ fnName, args }) => {
      const h = window.__safeopen;
      return h[fnName](...args);
    },
    { fnName, args },
  );
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
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(origin + '/__v06safeopen');
  await waitApi(page);

  // 1. 造一份合法 v5 并挂载：正常进入 Today，不出现安全面。
  await call(page, 'install');
  await call(page, 'mount');
  await page.locator('.dial-svg').waitFor();
  assert.equal(await safeHeading(page).count(), 0, '健康数据不显示安全面');
  results.push({ name: 'S1-healthy-v5-opens-today', status: 'pass' });

  // 2. 改坏当前信封，重开页面并重新挂载 → 只读安全面。
  await call(page, 'unmount');
  await call(page, 'corrupt', 'unknown');
  await page.reload({ waitUntil: 'load' });
  await waitApi(page);
  const beforeOpen = await call(page, 'evidence');
  await call(page, 'mount');
  await safeHeading(page).waitFor();
  await safe(page).getByText('校验失败原因').waitFor();
  const bodyText = await safe(page).innerText();
  assert.match(bodyText, /行动卡/, '安全面应列出可识别集合（行动卡）');
  assert.match(bodyText, /上一份自动留存/, '安全面应列出 previous 恢复点');
  results.push({ name: 'S2-corrupt-v5-shows-readonly-safe-open', status: 'pass' });

  // 3. 打开安全面零写入：revision / dataFormat / 恢复点键保持不变。
  const afterOpen = await call(page, 'evidence');
  assert.deepEqual(afterOpen, beforeOpen, '安全面读取不得写入或改动任何数据');
  results.push({ name: 'S3-safe-open-zero-write', status: 'pass' });

  // 安全面内不得出现任何编辑/出牌/确认类按钮。
  const buttonNames = await safe(page).locator('button').allInnerTexts();
  assert.ok(buttonNames.length > 0, '安全面应有操作按钮');
  const forbidden = buttonNames.filter((n) =>
    /打出|接受|抽卡|收尾|确认发生|补做|保存|恢复工作区/.test(n),
  );
  assert.deepEqual(forbidden, [], '安全面不得出现写操作按钮');
  results.push({ name: 'S4-no-edit-controls-on-safe-face', status: 'pass' });

  await page.screenshot({ path: path.join(output, 'safe-face.png'), fullPage: true });

  // 4a. 导出当前原始数据。
  {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      safe(page).getByRole('button', { name: '导出当前原始数据' }).click(),
    ]);
    assert.match(download.suggestedFilename(), /诊断原文/);
    results.push({ name: 'S5a-export-current-raw', status: 'pass' });
  }

  // 4b. 展开 previous 恢复点并导出其原文。
  const pointDetails = safe(page).locator('details', { hasText: '上一份自动留存' });
  await pointDetails.locator('summary').click();
  {
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      pointDetails.getByRole('button', { name: '导出该恢复点原文' }).click(),
    ]);
    assert.match(download.suggestedFilename(), /恢复点/);
    results.push({ name: 'S5b-export-recovery-point', status: 'pass' });
  }

  // 5a. 未修复时点重试：仍停留在安全面。
  await safe(page).getByRole('button', { name: '重试正常打开' }).click();
  await page.waitForTimeout(400);
  assert.equal(await safeHeading(page).count(), 1, '数据仍损坏时重试后应停留安全面');
  results.push({ name: 'S6-retry-still-corrupt-stays-safe', status: 'pass' });

  // 5b. 用 previous 修复 current（模拟外部恢复），再重试 → 回到 Today。
  await call(page, 'repair');
  await safe(page).getByRole('button', { name: '重试正常打开' }).click();
  await page.locator('.dial-svg').waitFor();
  assert.equal(await safeHeading(page).count(), 0, '修复并重试后应回到正常工作台');
  await page.screenshot({ path: path.join(output, 'recovered-today.png'), fullPage: true });
  results.push({ name: 'S7-repair-then-retry-returns-today', status: 'pass' });

  assert.deepEqual(errors, []);
  console.log('ALL PASS');
} catch (e) {
  console.error('FAIL', e);
  results.push({ name: 'error', status: 'fail', error: String(e && e.stack) });
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
  await fs.writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        scope: 'v0.6.5 P0-A Data v5 read-only safe open (corrupt current / export / retry)',
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
