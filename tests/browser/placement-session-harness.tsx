// Test-only entry. Real Host/store in an isolated synthetic IndexedDB database.
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { createWorkspaceStore } from '../../src/store.ts';
import { createWorkspaceClient } from '../../src/workspace-client.ts';
import { usePlacementSession } from '../../src/components/time-dial/use-placement-session.ts';
import { HandFan } from '../../src/components/hand/HandFan.tsx';
import { hand, fixed, envelope, AT } from '../fixtures/action/independent.ts';

export async function mountHarness(kind = 'hand') {
  const store = createWorkspaceStore({ name: 'g3-hook-' + crypto.randomUUID() });
  const data = kind === 'fixed' ? fixed() : hand();
  await store.atomic(() => ({ write: envelope(data), result: null }));
  const host = createWorkspaceClient({ store, now: () => AT });
  const probe: any = { calls: [], commands: [], cancels: [], active: 0, maximum: 0, delay: null,
    releaseDelay: null, failBefore: false, loseAfter: false, state: null, outcome: null };
  async function hold(type: string) {
    if (probe.delay !== type) return;
    probe.delay = null;
    await new Promise<void>(resolve => { probe.releaseDelay = () => { probe.releaseDelay = null; resolve(); }; });
  }
  const client = { ...host,
    async previewPlacement(query: any) {
      probe.calls.push(structuredClone(query)); probe.active++; probe.maximum = Math.max(probe.maximum, probe.active);
      try { const result = await host.previewPlacement(query); await hold('preview'); return result; }
      finally { probe.active--; }
    },
    async unlockFixed(query: any) { const result = await host.unlockFixed(query); if (result.ok) probe.lastUnlock = result.value; await hold('unlock'); return result; },
    cancelPreview(id: string) { probe.cancels.push(id); host.cancelPreview(id); },
    async submit(command: any) {
      probe.commands.push(structuredClone(command));
      if (probe.failBefore) { probe.failBefore = false; return { ok: false as const, code: 'STORAGE_FAILED' as const, retry: 'same-command' as const, message: 'G3 synthetic failure' }; }
      const result = await host.submit(command);
      if (probe.loseAfter && result.ok) { probe.loseAfter = false; return { ok: false as const, code: 'STORAGE_FAILED' as const, retry: 'same-command' as const, message: 'G3 synthetic lost response' }; }
      return result;
    },
  };
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  function Harness() {
    const session = usePlacementSession(client);
    probe.state = session.state; probe.session = session;
    probe.start = async (minute = 540) => {
      let subject: any = { kind: 'hand', instanceId: 'i', version: 7 };
      if (kind === 'fixed') {
        const load = await host.load();
        if (!load.ok) throw Error(load.message);
        const unlock = await host.unlockFixed({ token: load.value.token, commitmentId: 'x', version: 3 });
        if (!unlock.ok) throw Error(unlock.message);
        subject = { kind: 'fixed', commitmentId: 'x', version: 3, unlockId: unlock.value };
      }
      return session.start({ subject, date: '2026-09-28', zone: 'Asia/Shanghai', focusMinute: minute });
    };
    probe.commit = async (ack = false) => { probe.outcome = await session.commit(ack); return probe.outcome; };
    useEffect(() => () => { host.close(); }, []);
    return <section><h2 tabIndex={-1}>测试手牌</h2>
      <output data-testid="state">{JSON.stringify(session.state)}</output>
      <HandFan hand={[]} date="2026-09-28" zone="Asia/Shanghai" session={session} getFocus={() => 540}
        getDialRect={() => null} onView={() => {}} onPlace={() => {}} onRecordActual={() => {}}
        onInteractionStart={() => {}} onCancel={session.release} onCommitted={() => {}} />
    </section>;
  }
  probe.read = () => store.read();
  probe.tryLastUnlock = async () => {
    const load = await host.load();
    if (!load.ok) return load;
    return host.previewPlacement({ token: load.value.token,
      subject: { kind: 'fixed', commitmentId: 'x', version: 3, unlockId: probe.lastUnlock },
      date: '2026-09-28', zone: 'Asia/Shanghai', focusMinuteOfDay: 660 });
  };
  probe.close = () => root.unmount();
  (window as any).__g3 = probe;
  root.render(<Harness />);
}
