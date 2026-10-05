// 2F main-path browser test: two definitions -> draw/accept -> place -> overlap acknowledgement
// -> retract -> confirm actual -> read-only fact + annotation -> persists across reload.
// All through the production entry and the single Host; no second state store.
import {createServer} from 'vite';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const evidenceDir = join(tmpdir(), `cardgrid-2f-${Date.now()}`);
const resultsPath = join(evidenceDir, 'results.json');

const playwright = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE ?? 'playwright');
const chromePath = process.env.CARDGRID_CHROME_PATH;
const results = [];
function record(name, status, detail) { results.push({name, status, ...(detail ? {detail} : {})}); console.log(`${status === 'pass' ? 'PASS' : 'FAIL'} ${name}`); }
async function check(name, fn) { try { record(name, 'pass', await fn()); } catch (error) { results.push({name, status: 'fail', error: error?.stack ?? String(error)}); console.log(`FAIL ${name}`, error?.message ?? error); } }
const btn = (page, name) => page.getByRole('button', {name, exact: true});
const rowByName = (page, name) => page.locator('.dayboard-row', {hasText: name});
// DayBoard always renders four sections in this fixed order.
const HAND = 0, PLANS = 1, FIXED = 2, FACTS = 3;
const boardSection = (page, i) => page.locator('.dayboard > section').nth(i);

async function serve() {
  const server = await createServer({root: repo, configFile: join(repo, 'vite.config.ts'), logLevel: 'error',
    server: {host: '127.0.0.1', port: 0, strictPort: false}});
  await server.listen();
  return {server, url: `http://127.0.0.1:${server.httpServer.address().port}/`};
}
async function browser() {
  const browser = await playwright.chromium.launch({headless: true, executablePath: chromePath});
  const context = await browser.newContext({viewport: {width: 1280, height: 900}});
  const page = await context.newPage();
  page.on('pageerror', error => console.log('pageerror:', error.message));
  return {browser, context, page};
}

const {server, url} = await serve();
const context = await browser();
try {
  await check('2F-1 create-two-definitions', async () => {
    const page = context.page;
    await page.goto(url); await page.waitForLoadState('networkidle');
    await page.locator('nav').getByText('行动定义').click();
    for (const title of ['任务甲', '任务乙']) {
      await btn(page, '＋ 新建定义').click();
      await page.getByLabel('定义名称').fill(title);
      await btn(page, '保存定义').click();
      await page.getByText('已保存到本机').waitFor();
    }
    assert.equal(await page.locator('.act-card').count(), 2);
    return {definitions: 2};
  });

  await check('2F-2 draw-and-accept-two', async () => {
    const page = context.page;
    await page.locator('nav').getByText('抽卡手牌').click();
    const titles = new Set();
    for (let i = 0; i < 2; i++) {
      let title = '';
      for (let attempt = 0; attempt < 40; attempt++) {
        await page.getByRole('tab', {name: '抽取建议'}).click();
        await page.getByRole('button', {name: /^(抽一张建议|重新抽取)$/}).click();
        await page.locator('.draw-card').waitFor();
        title = (await page.locator('.draw-card strong').innerText()).trim();
        if (!titles.has(title)) break;
      }
      assert.ok(!titles.has(title), `抽不到新定义，仍为 ${title}`);
      titles.add(title);
      await btn(page, '接受，加入手牌').click();
      await page.getByRole('tab', {name: `手牌（${i + 1}）`}).waitFor();
    }
    return {hand: 2, titles: [...titles]};
  });

  await check('2F-3 place-jia-valid', async () => {
    const page = context.page;
    await page.getByRole('button', {name: '当日'}).click();
    await page.getByLabel('时区').fill('Asia/Tokyo');
    await boardSection(page, HAND).locator('.dayboard-row').first().waitFor();
    await rowByName(page, '任务甲').getByRole('button', {name: '打出'}).click();
    await page.getByRole('dialog').waitFor();
    await page.getByText('这个时间没有冲突').waitFor();
    await btn(page, '确认排期').click();
    await page.getByRole('dialog').waitFor({state: 'hidden'});
    await boardSection(page, PLANS).locator('.dayboard-row').waitFor();
    assert.equal(await boardSection(page, PLANS).locator('.dayboard-row').count(), 1);
    return {plans: 1, hand: 1};
  });

  await check('2F-4 place-yi-overlap-requires-ack', async () => {
    const page = context.page;
    await page.getByLabel('默认落点').fill('09:10');
    await rowByName(page, '任务乙').getByRole('button', {name: '打出'}).click();
    await page.getByRole('dialog').waitFor();
    await page.locator('.flow-candidate.conflict').waitFor();
    await page.locator('.flow-blockers').getByText('任务甲').waitFor();
    // Committing before acknowledging must be refused.
    await btn(page, '确认排期').click();
    await page.getByText('请先勾选确认本次重叠').waitFor();
    await page.locator('.flow-ack input').check();
    await btn(page, '确认排期').click();
    await page.getByRole('dialog').waitFor({state: 'hidden'});
    await boardSection(page, PLANS).locator('.dayboard-row').nth(1).waitFor();
    assert.equal(await boardSection(page, PLANS).locator('.dayboard-row').count(), 2);
    assert.equal(await boardSection(page, HAND).locator('.dayboard-row').count(), 0);
    return {plans: 2, hand: 0, overlapAcknowledged: true};
  });

  await check('2F-5 retract-jia-to-hand', async () => {
    const page = context.page;
    await rowByName(page, '任务甲').getByRole('button', {name: '撤回手牌'}).click();
    await boardSection(page, HAND).locator('.dayboard-row').waitFor();
    assert.equal(await boardSection(page, HAND).locator('.dayboard-row').count(), 1);
    assert.equal(await boardSection(page, PLANS).locator('.dayboard-row').count(), 1);
    return {hand: 1, plans: 1};
  });

  await check('2F-6 confirm-actual-for-yi', async () => {
    const page = context.page;
    await boardSection(page, PLANS).locator('.dayboard-row', {hasText: '任务乙'})
      .getByRole('button', {name: '确认实际'}).click();
    const dlg = page.getByRole('dialog', {name: '确认实际发生'});
    await dlg.waitFor();
    await dlg.getByRole('button', {name: '确认实际', exact: true}).click();
    await page.getByRole('dialog').waitFor({state: 'hidden'});
    await boardSection(page, FACTS).locator('.fact-item').waitFor();
    assert.equal(await boardSection(page, FACTS).locator('.fact-item').count(), 1);
    return {facts: 1};
  });

  await check('2F-7 fact-read-only-and-annotate', async () => {
    const page = context.page;
    const fact = boardSection(page, FACTS).locator('.fact-item');
    // The only action control on a locked fact is append-annotation; no edit/retract/delete.
    assert.equal(await fact.getByRole('button').count(), 1);
    await fact.getByRole('textbox').fill('实际只做了 20 分钟');
    await fact.getByRole('button', {name: '添加批注'}).click();
    await page.getByText('实际只做了 20 分钟').waitFor();
    assert.equal(await fact.locator('.fact-annotations li').count(), 1);
    return {factReadOnly: true, annotationAppended: true};
  });

  await check('2F-8 fact-persists-after-reload', async () => {
    const page = context.page;
    await page.reload({waitUntil: 'networkidle'});
    await page.locator('nav').getByText('抽卡手牌').click();
    await page.getByRole('button', {name: '当日'}).click();
    await boardSection(page, FACTS).locator('.fact-item').waitFor();
    await page.getByText('实际只做了 20 分钟').waitFor();
    assert.equal(await boardSection(page, FACTS).locator('.fact-item').getByRole('button').count(), 1);
    return {persisted: true};
  });
} finally {
  await context.browser.close();
  await server.close();
  await mkdir(evidenceDir, {recursive: true});
  await writeFile(resultsPath, JSON.stringify(results, null, 2));
  const failed = results.filter(r => r.status === 'fail').length;
  console.log(`Evidence: ${evidenceDir}`);
  console.log(`2F main path: ${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
