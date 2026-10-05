// 2D independent page checks. Fresh contexts, dedicated IDB, real WorkspaceClient rendering production pages.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = process.env.CARDGRID_2D_OUTPUT || path.join(os.tmpdir(), `cardgrid-2d-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const { chromium } = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
  optimizeDeps: { noDiscovery: true, entries: [], include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@js-temporal/polyfill', 'jsbi'] },
  plugins: [{ name: '2d-isolated-page', configureServer(vite) { vite.middlewares.use((req, res, next) => {
    if (req.url === '/__2d') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>2D isolated page regression</title>'); } else next();
  }); } }] });
let browser;
const results = [];
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.CARDGRID_CHROME_PATH ? { executablePath: process.env.CARDGRID_CHROME_PATH } : {}) });

  async function mount(context) {
    const page = await context.newPage();
    await page.goto(origin + '/__2d');
    await page.evaluate(async () => { await import('/tests/browser/2d-harness.tsx'); });
    return page;
  }
  async function check(name, run) {
    const context = await browser.newContext({ timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
    try { const detail = await run(context); results.push({ name, status: 'pass', detail }); console.log('PASS', name); }
    catch (error) { results.push({ name, status: 'fail', error: error.stack }); console.error('FAIL', name, error); }
    finally { await context.close(); }
  }
  const btn = (page, name) => page.getByRole('button', { name, exact: true });

  // Seed helpers run in the page where fx/h2d live.
  const seedDefinition = () => `
    const data = h2d.fx.blank();
    const content = h2d.fx.content(30); content.title = '可抽取';
    data.planner.definitions = [{ id: 'd1', version: 1, enabled: true, parentDefinitionId: null, source: { kind: 'manual' }, content }];
    await h2d.seed(data);
  `;
  const seedHand = (count) => `
    const data = h2d.fx.blank();
    const inst = (id, title) => { const c = h2d.fx.content(30); c.title = title;
      return { id, version: 1, definition: null, creationSnapshot: c, currentContent: c, source: { kind: 'manual' },
        createdAt: h2d.fx.AT, targetDate: null, state: 'open', occurrenceId: null, makeupOf: null }; };
    const ids = ${JSON.stringify(['a', 'b', 'c'].slice(0, count))};
    const titles = ${JSON.stringify(['甲', '乙', '丙'].slice(0, count))};
    data.planner.instances = ids.map((id, i) => inst(id, titles[i]));
    data.planner.handOrder = [...ids];
    await h2d.seed(data);
  `;

  await check('2D-1 create-definition-persists', async context => {
    const page = await mount(context);
    await page.evaluate(async () => { await h2d.seed(h2d.fx.blank()); h2d.render('library'); });
    await btn(page, '＋ 新建定义').click();
    await page.getByLabel('定义名称').fill('晨间阅读');
    await btn(page, '保存定义').click();
    await page.getByText('已保存到本机').waitFor();
    const data = await page.evaluate(() => h2d.data());
    assert.equal(data.planner.definitions.length, 1);
    assert.equal(data.planner.definitions[0].content.title, '晨间阅读');
    assert.equal(data.planner.definitions[0].version, 1);
    assert.equal(data.planner.definitions[0].enabled, true);
    return { definitionCreated: true };
  });

  await check('2D-2 edit-definition-keeps-id-bumps-version', async context => {
    const page = await mount(context);
    await page.evaluate(async (s) => { await new (Object.getPrototypeOf(async function(){}).constructor)(s)(); h2d.render('library'); }, seedDefinition());
    await btn(page, '编辑').click();
    await page.getByLabel('定义名称').fill('改名');
    await btn(page, '保存定义').click();
    await page.getByText('已保存到本机').waitFor();
    const data = await page.evaluate(() => h2d.data());
    assert.equal(data.planner.definitions.length, 1);
    assert.equal(data.planner.definitions[0].id, 'd1');
    assert.equal(data.planner.definitions[0].version, 2);
    assert.equal(data.planner.definitions[0].content.title, '改名');
    return { definitionEdited: true };
  });

  await check('2D-3 archived-definition-excluded-from-draw', async context => {
    const page = await mount(context);
    await page.evaluate(async (s) => { await new (Object.getPrototypeOf(async function(){}).constructor)(s)(); h2d.render('library'); }, seedDefinition());
    await btn(page, '停用归档').click();
    await page.getByText('已保存到本机').waitFor();
    let data = await page.evaluate(() => h2d.data());
    assert.equal(data.planner.definitions[0].enabled, false);
    await page.evaluate(() => h2d.render('hand'));
    await btn(page, '抽一张建议').click();
    await page.getByText('当前没有符合条件的定义可抽取').waitFor();
    return { disabledExcluded: true };
  });

  await check('2D-4 draw-accept-creates-hand-instance-no-time', async context => {
    const page = await mount(context);
    await page.evaluate(async (s) => { await new (Object.getPrototypeOf(async function(){}).constructor)(s)(); h2d.render('hand'); }, seedDefinition());
    await btn(page, '抽一张建议').click();
    await page.getByText('可抽取').waitFor();
    await btn(page, '接受，加入手牌').click();
    await page.getByText('持有手牌（1）').waitFor();
    const data = await page.evaluate(() => h2d.data());
    assert.equal(data.planner.instances.length, 1);
    assert.deepEqual(data.planner.handOrder, [data.planner.instances[0].id]);
    assert.equal(data.planner.plans.length, 0);
    assert.equal(data.planner.facts.length, 0);
    assert.equal(data.planner.instances[0].state, 'open');
    assert.deepEqual(data.planner.instances[0].definition, { id: 'd1', version: 1 });
    return { acceptedIntoHand: true };
  });

  await check('2D-5 empty-candidate-is-explained', async context => {
    const page = await mount(context);
    await page.evaluate(async () => { await h2d.seed(h2d.fx.blank()); h2d.render('hand'); });
    await btn(page, '抽一张建议').click();
    await page.getByText('当前没有符合条件的定义可抽取').waitFor();
    return { emptyExplained: true };
  });

  await check('2D-6 reorder-preserves-identity', async context => {
    const page = await mount(context);
    await page.evaluate(async (s) => { await new (Object.getPrototypeOf(async function(){}).constructor)(s)(); h2d.render('hand'); }, seedHand(3));
    await page.getByRole('tab').nth(1).click();
    await page.getByRole('button', { name: '下移' }).first().click();
    await page.getByText('已保存到本机').waitFor();
    const data = await page.evaluate(() => h2d.data());
    assert.deepEqual(data.planner.handOrder, ['b', 'a', 'c']);
    assert.deepEqual(data.planner.instances.map(i => i.id).sort(), ['a', 'b', 'c']);
    return { reordered: data.planner.handOrder.join(',') };
  });

  await check('2D-7 withdraw-and-return', async context => {
    const page = await mount(context);
    await page.evaluate(async (s) => { await new (Object.getPrototypeOf(async function(){}).constructor)(s)(); h2d.render('hand'); }, seedHand(1));
    await page.getByRole('tab').nth(1).click();
    await btn(page, '撤出').click();
    await page.getByText('已撤出（1）').waitFor();
    let data = await page.evaluate(() => h2d.data());
    assert.deepEqual(data.planner.handOrder, []);
    assert.equal(data.planner.instances[0].state, 'withdrawn');
    await btn(page, '放回手牌').click();
    await page.getByText('持有手牌（1）').waitFor();
    data = await page.evaluate(() => h2d.data());
    assert.deepEqual(data.planner.handOrder, ['a']);
    assert.equal(data.planner.instances[0].state, 'open');
    return { withdrawnAndReturned: true };
  });

  await check('2D-8 external-revision-keeps-input-then-resave', async context => {
    const page = await mount(context);
    await page.evaluate(async () => { await h2d.seed(h2d.fx.blank()); h2d.render('library'); });
    await btn(page, '＋ 新建定义').click();
    await page.getByLabel('定义名称').fill('未保存');
    // Another writer bumps revision; the page auto-reloads its token while the form input must stay.
    await page.evaluate(() => h2d.bump(11));
    await page.waitForTimeout(700);
    let value = await page.getByLabel('定义名称').inputValue();
    assert.equal(value, '未保存');
    let data = await page.evaluate(() => h2d.data());
    assert.equal(data.planner.definitions.length, 0);
    await btn(page, '保存定义').click();
    await page.getByText('已保存到本机').waitFor();
    data = await page.evaluate(() => h2d.data());
    assert.equal(data.planner.definitions.length, 1);
    assert.equal(data.planner.definitions[0].content.title, '未保存');
    return { inputRetainedAndResaved: true };
  });

  await check('2D-9 state-survives-page-reload', async context => {
    const page = await mount(context);
    await page.evaluate(async (s) => { await new (Object.getPrototypeOf(async function(){}).constructor)(s)(); h2d.render('hand'); }, seedDefinition());
    await btn(page, '抽一张建议').click();
    await page.getByText('可抽取').waitFor();
    await btn(page, '接受，加入手牌').click();
    await page.getByText('持有手牌（1）').waitFor();
    await page.reload();
    await page.evaluate(async () => { await import('/tests/browser/2d-harness.tsx'); h2d.render('hand'); });
    await page.getByRole('tab').nth(1).click();
    await page.getByText('持有手牌（1）').waitFor();
    const data = await page.evaluate(() => h2d.data());
    assert.equal(data.planner.instances.length, 1);
    assert.equal(data.planner.handOrder.length, 1);
    return { persistedAcrossReload: true };
  });

  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => r.status === 'fail');
  console.log(`Evidence: ${output}`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
