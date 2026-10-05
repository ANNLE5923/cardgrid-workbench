// A4 stage-4 UI check against a running Vite dev server (CARDGRID_DEV_ORIGIN, default :5180).
// Seeds a cross-kind pool hierarchy into the DEFAULT db inside a fresh context, then drives the real App.
// Personal browser profile and real user data are never touched.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'vite';

const server = process.env.CARDGRID_DEV_ORIGIN ? null : await createServer({root:fileURLToPath(new URL('../../',import.meta.url)),configFile:false,
  server:{host:'127.0.0.1',port:0},logLevel:'error'});
await server?.listen();
const origin = process.env.CARDGRID_DEV_ORIGIN || `http://127.0.0.1:${server.httpServer.address().port}`;
const output = process.env.CARDGRID_WS_OUTPUT || 'test-results/ws-hierarchy-2026-10-04';
await fs.mkdir(output, {recursive: true});
const {chromium} = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');

let browser;
let page;
try {
  browser = await chromium.launch({headless: true,
    ...(process.env.CARDGRID_CHROME_PATH ? {executablePath: process.env.CARDGRID_CHROME_PATH} : {})});
  const context = await browser.newContext({serviceWorkers: 'block'});
  page = await context.newPage();
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));

  // 1) Boot the App once (empty db; load never writes), then seed via a second client on the DEFAULT db.
  await page.goto(origin + '/', {waitUntil: 'networkidle'});
  await page.evaluate(async () => {
    const S = await import('/src/workspace/store.ts'), W = await import('/src/workspace/client.ts');
    const store = S.createWorkspaceStore();
    const client = W.createWorkspaceClient({store, now: () => '2026-10-04T04:00:00Z', random: () => 0});
    const ok = r => { if (!r.ok) throw new Error(JSON.stringify(r)); return r.value; };
    const token = async () => (await ok(await client.load())).token;
    const submit = async (type, payload) =>
      ok(await client.submit({commandId: crypto.randomUUID(), expected: await token(), type, payload}));
    const book = (id, title) =>
      ({id, version: 1, kind: 'book', title, author: null, status: 'active', source: {kind: 'manual'}});
    const pool = (id, name, poolKind, parentPoolId, memberIds = []) =>
      ({id, version: 1, name, poolKind, parentPoolId, memberIds, source: {kind: 'manual'}});
    await submit('SaveBookEntry', {bookEntry: book('b1', '百年孤独'), expectedVersion: null});
    await submit('SaveBookEntry', {bookEntry: book('b2', '三体'), expectedVersion: null});
    await submit('SavePool', {pool: pool('p-life', '生活总池', 'action', null), expectedVersion: null});
    await submit('SavePool', {pool: pool('p-standalone', '杂书', 'book', null), expectedVersion: null});
    await submit('SavePool', {pool: pool('p-books', '书目', 'book', 'p-life'), expectedVersion: null});
    await submit('SavePool', {pool: pool('p-novels', '长篇小说', 'book', 'p-books', ['b1', 'b2']), expectedVersion: null});
    await submit('SavePool', {pool: pool('p-sport', '运动', 'action', 'p-life'), expectedVersion: null});
    store.close();
  });

  // 2) Reload so the App reads the v3 data, then open the workshop tab.
  await page.reload({waitUntil: 'networkidle'});
  await page.getByRole('button', {name: /制卡工坊/}).first().click();
  await page.getByRole('tab', {name: '卡池', exact: true}).click();
  const parentSelect = page.locator('select[aria-label="父池"]');

  // Root layer: two real roots.
  assert.match(await page.getByRole('button', {name: /生活总池/}).innerText(), /行动池/);
  assert.match(await page.getByRole('button', {name: /杂书/}).innerText(), /书目池/);
  await page.screenshot({path: path.join(output, '01-root.png'), fullPage: true});

  // Drill into the ACTION root: the BOOK pool "书目" is a cross-kind child and must show.
  await page.getByRole('button', {name: /生活总池/}).click();
  const booksRow = page.locator('.action-list-row', {hasText: '书目'});
  assert.match((await booksRow.innerText()).replace(/\s+/g,' '), /书目 书目池 · 成员 0 · 子池 1/);
  assert.match((await page.locator('.action-list-row', {hasText: '运动'}).innerText()).replace(/\s+/g,' '), /运动 行动池/);
  assert.equal(await page.getByRole('button', {name: '返回上层'}).count(), 1);
  await page.screenshot({path: path.join(output, '02-life.png'), fullPage: true});

  // Drill into the book pool, then the novels pool (members = 2, cross-kind breadcrumb intact).
  await booksRow.getByRole('button', {name: /^书目/}).click();
  const novelsRow = page.locator('.action-list-row', {hasText: '长篇小说'});
  assert.match(await novelsRow.innerText(), /成员 2/);
  await page.screenshot({path: path.join(output, '03-books.png'), fullPage: true});

  await novelsRow.getByRole('button', {name: /长篇小说/}).click();
  assert.equal(await page.getByText('这一层还没有池').count(), 1);
  await page.screenshot({path: path.join(output, '04-novels.png'), fullPage: true});

  // Breadcrumb back to the root layer.
  await page.getByRole('button', {name: '全部顶层'}).click();
  assert.equal(await page.getByRole('button', {name: /杂书/}).count(), 1);
  await page.screenshot({path: path.join(output, '05-back-root.png'), fullPage: true});

  // Edit a cross-kind child: form loads with parent = the action root.
  await page.getByRole('button', {name: /生活总池/}).click();
  await booksRow.getByRole('button', {name: '编辑'}).click();
  assert.equal(await parentSelect.inputValue(), 'p-life');
  await page.screenshot({path: path.join(output, '06-edit.png'), fullPage: true});

  // "+子池" starts a new pool pre-parented to the current (book) pool.
  await booksRow.getByRole('button', {name: '＋子池'}).click();
  assert.equal(await parentSelect.inputValue(), 'p-books');
  await page.screenshot({path: path.join(output, '07-newchild.png'), fullPage: true});

  assert.deepEqual(pageErrors, []);
  console.log('PASS workshop hierarchy navigation; screenshots in', output);
} catch (error) {
  console.error('FAIL', error);
  if (page) await page.screenshot({path: path.join(output, 'failure.png'), fullPage: true}).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  await server?.close();
}
