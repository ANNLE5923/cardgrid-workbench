import React from 'react';
import {createRoot} from 'react-dom/client';
import {JournalWorkbench} from '../../src/journal/JournalWorkbench.tsx';
import {journalQueries} from '../../src/workspace/journal-queries.ts';

export function mountReview(options: any = {}) {
  const node = document.createElement('div');
  document.body.replaceChildren(node);
  const root = createRoot(node);
  let revision = 0, epoch = 'independent-synthetic';
  const listeners = new Set<() => void>();
  const probe: any = {calls: [], entries: structuredClone(options.entries ?? []), failNext: false, hangNext: false, release: null};
  const snapshot = () => ({token: {epoch, revision}, data: {version: 4, settings: {zone: options.zone ?? 'UTC'}, journalEntries: structuredClone(probe.entries)}});
  const queries = journalQueries(async () => snapshot() as any);
  const client: any = {
    ...queries,
    load: async () => ({ok: true, value: snapshot()}),
    subscribe(fn: () => void) {listeners.add(fn); return () => listeners.delete(fn);},
    async submit(command: any) {
      probe.calls.push({...structuredClone(command.payload), expectedEpoch:command.expected.epoch});
      if (probe.hangNext) {probe.hangNext = false; await new Promise<void>(resolve => {probe.release = resolve;});}
      if (probe.failNext) {probe.failNext = false; return {ok: false, message: 'synthetic save failure'};}
      const p = command.payload;
      const old = probe.entries.find((e: any) => e.date === p.date && e.zone === p.zone);
      if (old) Object.assign(old, {text: p.text, version: old.version + 1, updatedAt: '2026-10-05T01:00:00Z'});
      else if (p.text.trim()) probe.entries.push({id: `entry-${probe.entries.length}`, version: 1, ...p, createdAt: '2026-10-05T01:00:00Z', updatedAt: '2026-10-05T01:00:00Z'});
      revision++;
      listeners.forEach(fn => fn());
      return {ok: true};
    },
  };
  probe.unmount = () => root.unmount();
  probe.replace = () => {epoch = 'replacement-workspace'; revision = 0; probe.entries = [];};
  root.render(<JournalWorkbench client={client} readOnly={false}/>);
  (window as any).__review = probe;
}
