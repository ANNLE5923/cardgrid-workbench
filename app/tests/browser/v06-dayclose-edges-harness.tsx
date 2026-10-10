// Test-only edge-scenario harness for the v0.6 "结束今天" panel (NOT part of the product bundle).
// Scenarios are selected with ?scenario=makeup|material and the clock is forced via ?at=<iso>.
// Each scenario uses its own synthetic IndexedDB so setups never cross-contaminate.
//
//   /__v06daycloseedges?scenario=makeup&at=2026-10-06T14:00:00Z
//
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installB4 } from './v06-b4-harness.ts';
import { V06App } from '../../src/app/index.ts';
import { content } from '../fixtures/action/seed.ts';
import { actionCard, bookEntry, pool, rule } from '../modules/workshop/a1-fixtures.ts';

const params = new URLSearchParams(location.search);
const scenario = params.get('scenario') ?? 'makeup';
const forcedAt =
  params.get('at') ?? (scenario === 'material' ? '2026-10-12T16:25:00Z' : '2026-10-06T14:00:00Z'); // 材料：上海 10-13 00:25
const ZONE = 'Asia/Shanghai';
const INITIAL_DATE = scenario === 'material' ? '2026-10-13' : '2026-10-06';
const dbName = `cardgrid-dayclose-${scenario}`;

const cg = installB4(dbName);
// 素材场景：生成来源日副本要求规则/原卡的版本历史早于来源日边界。setup 在 10-06 早晨建规则，
// 来源日取 10-06，其边界为 10-07 00:00，规则历史（10-06 早晨）落在边界之前。
const setupAt = scenario === 'material' ? '2026-10-06T00:12:00Z' : forcedAt;
cg.setNow(setupAt);

// today/planner commands are submitted WITHOUT contractVersion (same as the real panel).
const plain = async (type: any, payload: any) =>
  cg.ok(
    await cg.host.submit({
      commandId: crypto.randomUUID(),
      expected: await cg.token(),
      type,
      payload,
    }),
  );

// Seed a routine that was generated yesterday but never done. There is no command that flips an
// occurrence to 'missed' — time passage leaves it as a past `generated`, which is exactly the real
// "昨天漏做" shape the close panel must surface as forward-makeup.
async function seedRoutineYesterday() {
  cg.setNow('2026-10-05T00:12:00Z'); // 上海 10-05 08:12
  await plain('SaveDefinition', {
    id: 'def-routine',
    expectedVersion: null,
    content: { ...content(15), title: '晨读例行' },
    enabled: true,
    parentDefinitionId: null,
  });
  await plain('SaveRule', {
    rule: {
      id: 'r-daily',
      version: 1,
      name: '每日晨读',
      definitionId: 'def-routine',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      startDate: '2026-10-04',
      zone: ZONE,
      status: 'active',
      source: { kind: 'manual' },
    },
    expectedVersion: null,
  });
  await plain('PrepareDay', { date: '2026-10-05', zone: ZONE, templateId: null });
  cg.setNow(forcedAt);
}

// Seed a daily copy material (sourceDate 10-06, expires at 10-13 00:00 Shanghai) placed on a plan
// 10-12 23:50 → 10-13 00:20. At review time (10-13 00:25) the material has expired at midnight.
async function seedExpiringMaterial() {
  // 在来源日（10-06）当天真实生成当日副本（过去日期不能回填）。
  cg.setNow('2026-10-06T00:12:00Z'); // 上海 10-06 08:12
  cg.ok(
    await cg.host.submit({
      commandId: crypto.randomUUID(),
      expected: await cg.token(),
      type: 'GenerateDailyCopies',
      payload: { target: 'current' },
    }),
  );
  // Place at 23:50 Shanghai on 10-12 while the 10-06 copy (expires 10-13 00:00) is still unexpired.
  cg.setNow('2026-10-12T15:50:00Z');
  const copy = (await cg.data()).dailyCopies.find((c: any) => c.sourceDate === '2026-10-06');
  if (!copy) throw new Error('no daily copy for 10-06');
  const take = cg.ok(
    await cg.host.submit({
      contractVersion: 'v06-b7-1',
      commandId: crypto.randomUUID(),
      expected: await cg.token(),
      type: 'TakeDailyMaterial',
      payload: { copy: { id: copy.id, version: copy.version } },
    }),
  );
  const mat = (await cg.data()).handCards.find(
    (c: any) => c.kind === 'action' && c.actionInstanceId === take.resultRefs?.[0]?.id,
  );
  if (!mat) throw new Error('no material hand card after take');
  // Place the material across midnight via the real placement pipeline.
  const instId = mat.actionInstanceId;
  const inst = (await cg.data()).planner.instances.find((i: any) => i.id === instId);
  const preview = cg.ok(
    await cg.host.previewPlacement({
      token: await cg.token(),
      subject: { kind: 'hand', instanceId: instId, version: inst.version },
      date: '2026-10-12',
      zone: ZONE,
      focusMinuteOfDay: 1430, // 23:50 上海；时长取实例 preset，候选可自然跨午夜
    }),
  );
  const candidate =
    preview.candidates.find((c: any) => c.state === 'valid') ?? preview.candidates[0];
  await plain('CommitPlacement', {
    previewId: preview.previewId,
    candidateId: candidate.id,
    acknowledgedOverlap: null,
  });
  cg.setNow(forcedAt);
}

const mode = cg.ok(await cg.host.load()).mode;
// 素材场景需要一张“无必填槽位”的每日素材（阅读卡带必填书名，无法直接打出），因此在迁移前
// 用 legacy 建一张无槽位行动卡 + 一条专属生成规则，再走与标准 setup 相同的迁移与目录灌入。
async function setupMaterial() {
  const oldSubmit = async (type: any, payload: any) =>
    cg.ok(
      await cg.legacy.submit({
        type,
        payload,
        expected: cg.ok(await cg.legacy.load()).token,
        commandId: crypto.randomUUID(),
      }),
    );
  await oldSubmit('SaveBookEntry', { bookEntry: bookEntry(), expectedVersion: null });
  await oldSubmit('SavePool', { pool: pool({ id: 'old-books' }), expectedVersion: null });
  await oldSubmit('SaveActionCard', {
    actionCard: actionCard({
      id: 'daily-walk',
      content: { ...content(15), title: '夜间散步' },
      slots: [],
    }),
    expectedVersion: null,
  });
  await oldSubmit('SaveGenerationRule', {
    generationRule: rule({
      id: 'daily-walk-rule',
      name: '每日散步',
      actionCardId: 'daily-walk',
      startDate: '2026-10-06',
    }),
    expectedVersion: null,
  });
  await oldSubmit('SaveJournalEntry', {
    date: '2026-10-05',
    zone: 'Asia/Shanghai',
    text: '素材场景留白\n',
  });
  await cg.migrate();
  for (const [type, key, payloadKey] of [
    ['SaveActionCardV5', 'actionCards', 'actionCard'],
    ['SaveCatalogEntry', 'catalogEntries', 'entry'],
    ['SaveDeck', 'decks', 'deck'],
    ['SaveDecisionCard', 'decisionCards', 'decision'],
  ] as const)
    for (const item of cg.catalog[key])
      await cg.submit(type, { [payloadKey]: item, expectedVersion: null });
}
if (mode === 'uninitialized') {
  if (scenario === 'material') await setupMaterial();
  else await cg.setup();
  const d0 = await cg.data();
  cg.ok(
    await cg.host.submit({
      commandId: crypto.randomUUID(),
      type: 'SaveSettings',
      expected: await cg.token(),
      payload: { settings: { ...d0.settings, zone: ZONE } },
    }),
  );
  if (scenario === 'makeup') await seedRoutineYesterday();
  else if (scenario === 'material') await seedExpiringMaterial();
}

(window as any).__edges = {
  cg,
  plain,
  readDay: async (date: string) => cg.ok(await cg.host.readDay({ date, zone: ZONE })),
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <V06App host={cg.host} initialDate={INITIAL_DATE} />
  </StrictMode>,
);
