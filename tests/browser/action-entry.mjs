// Exercises the production bundle in fresh browser contexts. No real browser profile is opened.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(os.tmpdir(), `cardgrid-action-entry-${Date.now()}`), outDir = path.join(output, 'build');
await fs.mkdir(output, { recursive: true });
await build({ root, configLoader: 'native', build: { outDir, emptyOutDir: false }, logLevel: 'error' });
const server = await preview({ root, configLoader: 'native', build: { outDir }, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const { chromium } = await import(process.env.CARDGRID_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CARDGRID_CHROME_PATH ? { executablePath: process.env.CARDGRID_CHROME_PATH } : {}) });
const results = [];
async function raw(page) { return page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open('cardgrid-workspace', 3); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const value = await new Promise((resolve, reject) => { const tx = db.transaction(['workspace','recovery'], 'readonly'), current = tx.objectStore('workspace').get('current'), recovery = tx.objectStore('recovery').getAll(); tx.oncomplete = () => resolve({ current: current.result ?? null, recovery: recovery.result }); tx.onabort = () => reject(tx.error); }); db.close(); return value;
}); }
async function waitUI(page) { await page.getByRole('button', { name: '重新载入', exact: true }).waitFor(); }
async function test(name, fn) {
  const context = await browser.newContext({ timezoneId: 'Asia/Shanghai', serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = []; context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try { const detail = await fn(context); assert.deepEqual(errors, []); results.push({ name, status: 'pass', detail }); console.log('PASS', name); }
  catch (error) { results.push({ name, status: 'fail', error: error.stack, pageErrors: errors }); console.error('FAIL', name, error); }
  finally { await context.close(); }
}
try {
  await test('production-open-date-navigation-explicit-prepare-and-capture', async context => {
    const page = await context.newPage(); await page.goto(origin); await waitUI(page);
    assert.equal((await raw(page)).current, null);
    await page.getByRole('button', { name: '查看后一天' }).click(); await page.getByRole('button', { name: '查看前一天' }).click();
    await page.getByRole('button', { name: 'Schedule', exact: false }).first().click();
    assert.equal((await raw(page)).current, null);
    assert.equal(await page.getByRole('group', { name: '旧版页面只读' }).locator('button:enabled').count(), 0);
    await page.getByRole('button', { name: '准备这一天', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已保存到本机' }).waitFor();
    const prepared = await raw(page); assert.equal(prepared.current.data.planner.days.length, 1); assert.equal(prepared.current.data.planner.instances.length, 0);
    await page.getByRole('button', { name: '查看后一天' }).click(); await page.reload(); await waitUI(page); assert.deepEqual(await raw(page), prepared);
    await page.getByLabel('记录到收件箱', { exact: true }).fill('合成捕获'); await page.getByRole('button', { name: '保存记录', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已保存到本机' }).waitFor();
    const captured = await raw(page); assert.equal(captured.current.data.planner.captures.length, 1); assert.equal(captured.current.data.planner.instances.length, 0);
    await page.screenshot({ path: path.join(output, 'current-today.png'), fullPage: true }); return { readonlyNavigation: true, explicitPreparation: true, captureOnly: true };
  });
  await test('production-download-clear-restore-and-epoch-clears-other-window-draft', async context => {
    const page = await context.newPage(); await page.goto(origin); await waitUI(page);
    await page.getByLabel('记录到收件箱', { exact: true }).fill('恢复后仍在'); await page.getByRole('button', { name: '保存记录', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已保存到本机' }).waitFor(); const source = (await raw(page)).current.data;
    const other = await context.newPage(); await other.goto(origin); await waitUI(other);
    await other.getByRole('button', { name: '配置工坊', exact: false }).first().click(); await other.getByRole('button', { name: '文字配置 JSON', exact: true }).click(); await other.getByLabel('JSON配置').fill('未保存旧草稿');
    await page.getByRole('button', { name: '数据与备份', exact: false }).first().click();
    const downloadEvent = page.waitForEvent('download'); await page.getByRole('button', { name: '下载完整备份', exact: true }).click(); const download = await downloadEvent;
    const savedPath = path.join(output, 'restore-source.json'); await download.saveAs(savedPath); const backup = JSON.parse(await fs.readFile(savedPath, 'utf8')); assert.deepEqual(backup.data, source);
    await page.getByLabel('清空确认文字').fill('清空'); await page.getByLabel('确认放弃未提交草稿并执行以上操作').check(); assert.equal(await page.getByRole('button', { name: '清空工作台', exact: true }).isDisabled(), true);
    await page.getByLabel('我已保存这份完整备份').check(); await page.getByRole('button', { name: '清空工作台', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已保存到本机' }).waitFor();
    const empty = await raw(page); assert.equal(empty.current.data.planner.captures.length, 0); assert.deepEqual(empty.recovery, []);
    await other.getByRole('status').filter({ hasText: '工作区已被替换' }).waitFor(); assert.ok((await other.getByLabel('JSON配置').inputValue()).includes('"definitions": []'));
    await page.getByLabel('导入文件选择').setInputFiles(savedPath); await page.getByRole('heading', { name: '恢复预览', exact: true }).waitFor();
    const secondDownload = page.waitForEvent('download'); await page.getByRole('button', { name: '下载完整备份', exact: true }).click(); await secondDownload;
    await page.getByLabel('我已保存这份完整备份').check(); await page.getByLabel('确认放弃未提交草稿并执行以上操作').check(); await page.getByRole('button', { name: '执行已预览操作', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '已保存到本机' }).waitFor(); assert.deepEqual((await raw(page)).current.data, source); assert.deepEqual((await raw(page)).recovery, []);
    await page.reload(); await waitUI(page); assert.deepEqual((await raw(page)).current.data, source); return { downloadMatches: true, explicitConfirmation: true, exactRestore: true, epochDraftReset: true };
  });
  await test('production-legacy-is-readonly-without-bootstrap-and-unknown-data-survives', async context => {
    const page = await context.newPage(); await page.goto(origin + '/favicon.svg');
    const old = { schemaVersion: 1, revision: 7, config: { preferences: { theme: 'paper', density: 'comfortable', startHour: 8, endHour: 23, defaultMinutes: 15 }, categories: [], cards: [], schedules: [] } };
    await page.evaluate(async old => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('cardgrid-workspace', 1); r.onupgradeneeded = () => r.result.createObjectStore('workspace'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      await new Promise((resolve, reject) => { const tx = db.transaction('workspace', 'readwrite'); tx.objectStore('workspace').put(old, 'current'); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    }, old);
    await page.goto(origin); await waitUI(page); await page.getByText('旧工作区只读', { exact: true }).waitFor(); assert.equal(await page.getByRole('button', { name: '准备这一天', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '查看后一天' }).click(); await page.reload(); await waitUI(page); assert.deepEqual((await raw(page)).current, old); assert.deepEqual((await raw(page)).recovery, []);
    await page.getByRole('button', { name: '数据与备份', exact: false }).first().click(); await page.getByRole('button', { name: '预览升级', exact: true }).click(); await page.getByRole('heading', { name: '迁移预览', exact: true }).waitFor(); assert.deepEqual((await raw(page)).current, old);
    await page.screenshot({ path: path.join(output, 'legacy-migration-preview.png'), fullPage: true });
    await page.evaluate(async () => { const db = await new Promise(resolve => { const r = indexedDB.open('cardgrid-workspace', 3); r.onsuccess = () => resolve(r.result); }); await new Promise(resolve => { const tx = db.transaction('workspace', 'readwrite'); tx.objectStore('workspace').put({ schemaVersion: 999, untouched: 'unknown-format' }, 'current'); tx.oncomplete = resolve; }); db.close(); });
    await page.reload(); await page.getByRole('heading', { name: '本地数据暂时无法打开', exact: true }).waitFor(); assert.deepEqual((await raw(page)).current, { schemaVersion: 999, untouched: 'unknown-format' });
    return { sourcePreserved: true, previewOnly: true, unknownFormatNotOverwritten: true };
  });
} finally {
  await browser.close(); await new Promise(resolve => server.httpServer.close(resolve));
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2)); console.log('Evidence:', output);
}
if (results.some(r => r.status !== 'pass')) process.exitCode = 1;
