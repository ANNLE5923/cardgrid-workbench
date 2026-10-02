// 2D isolated mount harness. Real WorkspaceClient + real IDB; renders the production pages inside an .app shell.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createWorkspaceStore } from '../../src/store.ts';
import { createWorkspaceClient } from '../../src/workspace-client.ts';
import { ActionLibrary } from '../../src/action-library.tsx';
import { ActionHand } from '../../src/action-hand.tsx';
import * as fx from '../fixtures/action/independent.ts';
import type { DataV2, EnvelopeV4 } from '../../src/action-contract.ts';
import '../../src/style.css';
import '../../src/action.css';

const dbName = 'cardgrid-2d';
const store = createWorkspaceStore({ name: dbName });
const client = createWorkspaceClient({ store, now: () => fx.AT });
const value = <T,>(r: { ok: true; value: T } | { ok: false; message: string }): T => {
  if (!r.ok) throw Error(r.message);
  return r.value;
};

const appEl = document.createElement('div');
appEl.className = 'app paper comfortable';
appEl.style.minHeight = '100vh';
document.body.appendChild(appEl);
const shell = document.createElement('main');
shell.className = 'action-shell';
appEl.appendChild(shell);
const root = createRoot(shell);

const h2d = {
  fx,
  client,
  value,
  dbName,
  async seed(data: DataV2 = fx.hand()) {
    await store.atomic(() => ({ write: fx.envelope(data) as EnvelopeV4, result: null }));
  },
  async raw() {
    return await store.read();
  },
  async data(): Promise<DataV2> {
    const envelope = (await store.read()) as EnvelopeV4;
    return envelope.data as DataV2;
  },
  // Simulate another writer bumping the revision while a form is open (token goes stale).
  async bump(revision = 11) {
    const current = (await store.read()) as EnvelopeV4;
    const next: EnvelopeV4 = { ...current, revision };
    await store.atomic(() => ({ write: next, result: null }));
  },
  render(which: 'library' | 'hand') {
    root.render(which === 'library' ? <ActionLibrary client={client} /> : <ActionHand client={client} />);
  },
};

globalThis.h2d = h2d;
