import { createRoot } from 'react-dom/client';
import { V06App } from '../../src/app/index.ts';
import { installB4 } from './v06-b4-harness.ts';

// 仅用于 v0.6.4 收尾面板的带数据浏览器验收（合成 IDB，不接触真实数据）。
const cg = installB4('cardgrid-dayclose-synthetic-only');
const params = new URLSearchParams(location.search);
const forcedAt = params.get('at');
if (forcedAt) cg.setNow(forcedAt);

if (cg.ok(await cg.host.load()).mode === 'uninitialized') {
  await cg.setup();
  const d = await cg.data();
  cg.ok(
    await cg.host.submit({
      commandId: crypto.randomUUID(),
      type: 'SaveSettings',
      expected: await cg.token(),
      payload: { settings: { ...d.settings, zone: 'Asia/Shanghai' } },
    }),
  );
  // 一张合成行动卡（随后在 GUI 排到 09:00）+ 一张答案卡。
  const s = await cg.synthesis();
  cg.ok(await cg.host.submit(s.command));
  await cg.answer();
  // 再取一张普通行动素材，始终留在手牌，用于验收“收回手牌”。
  await cg.submit('TakeActionMaterial', { action: cg.ref(cg.catalog.actionCards[0]) });
}

Object.assign(window, { cg });
createRoot(document.getElementById('root')!).render(
  <V06App host={cg.host} initialDate="2026-10-06" />,
);
