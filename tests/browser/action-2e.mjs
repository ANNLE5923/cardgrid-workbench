// 2E real-entry integration: serve the production index.html/main.tsx and exercise the newly
// mounted navigation entries (定义 / 抽卡手牌) through the single Host, plus a legacy-tab smoke.
import {createServer} from 'vite';
import assert from 'node:assert/strict';
import {mkdir, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const evidenceDir = join(tmpdir(), `cardgrid-2e-${Date.now()}`);
const resultsPath = join(evidenceDir, 'results.json');

const playwright = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE ?? 'playwright');
const chromePath = process.env.CARDGRID_CHROME_PATH;
const results = [];

function record(name, status, detail) { results.push({name, status, ...(detail ? {detail} : {})}); console.log(`${status === 'pass' ? 'PASS' : 'FAIL'} ${name}`); }
async function check(name, fn) { try { record(name, 'pass', await fn()); } catch (error) { results.push({name, status: 'fail', error: error?.stack ?? String(error)}); console.log(`FAIL ${name}`, error?.message ?? error); } }
const btn = (page, name) => page.getByRole('button', {name, exact: true});

async function serve() {
  const server = await createServer({
    root: repo,
    configFile: join(repo, 'scripts', 'vite.config.ts'),
    logLevel: 'error',
    server: {host: '127.0.0.1', port: 0, strictPort: false},
  });
  await server.listen();
  const address = server.httpServer.address();
  return {server, url: `http://127.0.0.1:${address.port}/`};
}

async function browser() {
  const browser = await playwright.chromium.launch({headless: true, executablePath: chromePath});
  const context = await browser.newContext({viewport: {width: 1280, height: 860}});
  const page = await context.newPage();
  page.on('pageerror', error => console.log('pageerror:', error.message));
  return {browser, context, page};
}

async function mount(context, url) {
  const {page} = context;
  await page.goto(url);
  await page.waitForLoadState('networkidle');
  await page.locator('nav').getByText('Today').waitFor();
  return page;
}

const {server, url} = await serve();
const context = await browser();
try {
  await check('2E-1 definitions-nav-creates-definition', async () => {
    const page = await mount(context, url);
    await page.locator('nav').getByText('行动定义').click();
    await page.locator('main h1').filter({hasText: '行动定义'}).waitFor();
    await btn(page, '＋ 新建定义').click();
    await page.getByLabel('定义名称').fill('集成定义');
    await btn(page, '保存定义').click();
    await page.getByText('已保存到本机').waitFor();
    const count = await page.locator('.act-card').count();
    assert.ok(count >= 1);
    return {mountedDefinitions: count};
  });

  await check('2E-2 hand-nav-draw-accept', async () => {
    const page = context.page;
    await page.locator('nav').getByText('抽卡手牌').click();
    await page.locator('main h1').filter({hasText: '抽卡与手牌'}).waitFor();
    await btn(page, '抽一张建议').click();
    await btn(page, '接受，加入手牌').waitFor();
    await btn(page, '接受，加入手牌').click();
    await page.getByText('持有手牌（1）').waitFor();
    return {acceptedThroughRealEntry: true};
  });

  await check('2E-3 legacy-tabs-still-render', async () => {
    const page = context.page;
    await page.locator('nav').getByText('Today').click();
    await page.getByText('TODAY · P1A').waitFor();
    await page.locator('nav').getByText('Schedule').click();
    await page.getByText('SCHEDULE · P1A').waitFor();
    return {legacyIntact: true};
  });

  await check('2E-4 prepare-day-after-cross-entry-save', async () => {
    const page = context.page;
    await page.locator('nav').getByText('Schedule').click();
    await page.getByText('SCHEDULE · P1A').waitFor();
    await btn(page, '准备这一天').click();
    await page.getByText('已保存到本机').waitFor();
    const conflict = await page.getByText('另一窗口已更新').count();
    assert.equal(conflict, 0);
    return {prepareDayAcceptedAfterSync: true};
  });

  await check('2E-5 settings-merge-keeps-both-windows-edits', async () => {
    const page = context.page;
    // Page A edits only the zone and leaves the draft open.
    await page.locator('nav').getByText('配置工坊').click();
    await page.getByText('工作台偏好').waitFor();
    await page.getByLabel('记录时区').fill('Asia/Shanghai');
    // Page B: second tab sharing storage, edits only the theme and saves.
    const pageB = await context.context.newPage();
    await pageB.goto(url);
    await pageB.locator('nav').getByText('配置工坊').click();
    await pageB.getByText('工作台偏好').waitFor();
    await pageB.getByLabel('主题').selectOption('night');
    await pageB.getByRole('button', {name: '保存偏好'}).click();
    await pageB.getByText('已保存到本机').waitFor();
    // Page A gets the external change, keeps its zone draft, then saves; both edits must survive.
    await page.getByText('另一窗口已保存').waitFor();
    await page.getByRole('button', {name: '保存偏好'}).click();
    await page.getByText('已保存到本机').waitFor();
    assert.equal(await page.getByLabel('主题').inputValue(), 'night');
    assert.equal(await page.getByLabel('记录时区').inputValue(), 'Asia/Shanghai');
    await pageB.close();
    return {mergedKeptBoth: true};
  });
} finally {
  await context.browser.close();
  await server.close();
  await mkdir(evidenceDir, {recursive: true});
  await writeFile(resultsPath, JSON.stringify(results, null, 2));
  const failed = results.filter(r => r.status === 'fail').length;
  console.log(`Evidence: ${evidenceDir}`);
  console.log(`2E integration: ${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
