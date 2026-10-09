import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BroadcastChannel } from 'node:worker_threads';
import { createWorkspaceStore, type WorkspaceSlotChange } from '../../../src/workspace/store.ts';

function notifications(t: TestContext) {
  const name = 'store-notifications-' + randomUUID();
  const store = createWorkspaceStore({ name });
  const sender = new BroadcastChannel(name + ':v4');
  t.after(() => {
    sender.close();
    store.close();
  });
  const receive = (payload: unknown) =>
    new Promise<{ external: boolean; changes: readonly WorkspaceSlotChange[] | undefined }>(
      (resolve) => {
        const off = store.subscribe((external, changes) => {
          off();
          resolve({ external, changes });
        });
        sender.postMessage(payload);
      },
    );
  return { store, receive };
}

test(
  'store notifications preserve known slots and allow consumers to skip unrelated writes',
  { timeout: 5000 },
  async (t) => {
    const { store, receive } = notifications(t);
    let refreshes = 0;
    store.subscribe((_external, changes) => {
      if (!changes || changes.includes('workspace')) refreshes++;
    });
    for (const changes of [
      ['archive'],
      ['maintenance'],
      ['text-output'],
      ['workspace'],
      ['workspace', 'archive'],
    ] satisfies WorkspaceSlotChange[][]) {
      assert.deepEqual(await receive(['changed', changes]), { external: true, changes });
    }
    assert.equal(refreshes, 2);
  },
);

test(
  'store notifications fall back to full refresh for legacy, malformed and unknown-slot messages',
  { timeout: 5000 },
  async (t) => {
    const { store, receive } = notifications(t);
    let refreshes = 0;
    store.subscribe((_external, changes) => {
      if (!changes || changes.includes('workspace')) refreshes++;
    });
    const payloads: unknown[] = [
      'changed',
      null,
      { changed: true },
      [],
      ['changed'],
      ['changed', 'workspace'],
      ['changed', []],
      ['changed', [123]],
      ['changed', ['newer-slot']],
      ['changed', ['archive', 'newer-slot']],
      ['changed', new Array(2)],
      ['changed', ['archive'], 'unexpected extra field'],
    ];
    for (const payload of payloads) {
      assert.deepEqual(
        await receive(payload),
        { external: true, changes: undefined },
        JSON.stringify(payload),
      );
    }
    assert.equal(
      refreshes,
      payloads.length,
      'An undecodable notification must not be filtered out',
    );
  },
);
