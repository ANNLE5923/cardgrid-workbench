import test from 'node:test';
import assert from 'node:assert/strict';
import {harness, ok} from '../workspace/v3-fixtures.ts';

const ZONE = 'UTC';
const TODAY = '2026-10-04';
const saveEntry = (h: ReturnType<typeof harness>, date: string, text: string, zone = ZONE) =>
  h.submit('SaveJournalEntry', {date, zone, text});

test('J1 fresh workspace boots on v4 with an empty journal', async () => {
  const h = harness({version: 4});
  const snap = ok(await h.client.load());
  assert.equal(snap.data?.version, 4);
  assert.deepEqual(snap.data?.journalEntries, []);
});

test('J1 blank or whitespace text never creates an entry', async () => {
  const h = harness({version: 4});
  for (const text of ['', '   ', '\n\t ']) ok(await saveEntry(h, TODAY, text));
  const snap = ok(await h.client.load());
  assert.equal(snap.data?.journalEntries.length, 0);
});

test('J1 first text creates v1; further edits update the same entry', async () => {
  const h = harness({version: 4});
  ok(await saveEntry(h, TODAY, '早上写的'));
  let data = ok(await h.client.load()).data!;
  assert.equal(data.journalEntries.length, 1);
  assert.equal(data.journalEntries[0].version, 1);
  assert.equal(data.journalEntries[0].text, '早上写的');
  ok(await saveEntry(h, TODAY, '晚上补两句'));
  data = ok(await h.client.load()).data!;
  assert.equal(data.journalEntries.length, 1);
  assert.equal(data.journalEntries[0].version, 2);
  assert.equal(data.journalEntries[0].text, '晚上补两句');
});

test('J1 clearing text keeps the record (no delete), only blanks it', async () => {
  const h = harness({version: 4});
  ok(await saveEntry(h, TODAY, '有点内容'));
  ok(await saveEntry(h, TODAY, ''));
  const entries = ok(await h.client.load()).data!.journalEntries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, '');
  assert.equal(entries[0].version, 2);
});

test('J1 future dates are rejected at the command layer without writing', async () => {
  const h = harness({version: 4});
  const before = h.evidence();
  assert.equal((await saveEntry(h, '2026-10-05', '提前写明天') as any).code, 'FUTURE_DATE');
  assert.deepEqual(h.evidence(), before);
});

test('J1 readJournal prefers exact zone and falls back to newest same-date entry', async () => {
  const h = harness({version: 4});
  ok(await h.submit('SaveJournalEntry', {date: TODAY, zone: 'America/New_York', text: '纽约篇'}));
  h.setNow('2026-10-04T10:00:00Z');
  ok(await h.submit('SaveJournalEntry', {date: TODAY, zone: 'Asia/Tokyo', text: '东京篇'}));

  const exact = ok(await h.client.readJournal({date: TODAY, zone: 'Asia/Tokyo'}));
  assert.equal(exact.entry?.text, '东京篇');
  assert.equal(exact.fallbackZone, null);

  const fallback = ok(await h.client.readJournal({date: TODAY, zone: 'Europe/London'}));
  assert.equal(fallback.entry?.text, '东京篇');
  assert.equal(fallback.fallbackZone, 'Asia/Tokyo');
});

test('J1 neighbors jump only to days with non-blank text', async () => {
  const h = harness({version: 4});
  ok(await saveEntry(h, '2026-10-01', '一号'));
  ok(await saveEntry(h, '2026-10-02', '   ')); // blank → no record, skipped
  ok(await saveEntry(h, '2026-10-03', '三号'));
  const from2 = ok(await h.client.readJournalNeighbors({date: '2026-10-02'}));
  assert.equal(from2.prev, '2026-10-01');
  assert.equal(from2.next, '2026-10-03');
});

test('J1 month dots list distinct non-blank dates in that month only', async () => {
  const h = harness({version: 4});
  ok(await saveEntry(h, '2026-09-30', '九月底'));
  ok(await saveEntry(h, '2026-10-02', '二号'));
  ok(await saveEntry(h, '2026-10-02', '二号改写')); // same day → deduped
  ok(await saveEntry(h, '2026-10-03', '三号'));
  const month = ok(await h.client.readJournalMonth({year: 2026, month: 10}));
  assert.deepEqual(month.dates.sort(), ['2026-10-02', '2026-10-03']);
});

test('J1 v3 workspace upgrades to v4 end-to-end and keeps existing data', async () => {
  const h = harness(); // v3 baseline
  await h.setup();
  const before = ok(await h.client.load()).data!;
  assert.equal(before.version, 3);
  if (before.version !== 3) throw new Error('expected v3');

  const preview = ok(await h.client.previewMigration({token: await h.token(), choices: {zone: null}}));
  assert.deepEqual(preview.upgrade, {from: 3, to: 4});
  assert.equal(preview.targetSummary.journalEntries, 0);

  const prepared = ok(await h.client.prepareBackup());
  const backup = {token: prepared.token, dataFingerprint: prepared.dataFingerprint, fileSavedConfirmed: true as const};
  const command = await h.command('CommitMigration', {previewId: preview.previewId, backup, discardDraftsConfirmed: true});
  ok(await h.client.submit(command));

  const after = ok(await h.client.load()).data!;
  assert.equal(after.version, 4);
  if (after.version !== 4) throw new Error('expected v4');
  assert.deepEqual(after.journalEntries, []);
  assert.equal(after.actionCards.length, before.actionCards.length);
  assert.equal(after.bookEntries.length, before.bookEntries.length);
  assert.equal(after.pools.length, before.pools.length);
});
