// Test-only entry for the journal autosave state machine. Injects a controllable save()
// so failure-keeps-draft, retry and trailing-save can be driven deterministically.
import React from 'react';
import {createRoot} from 'react-dom/client';
import {useJournalAutosave} from '../../src/journal/use-journal-autosave.ts';

export async function mountJournalHarness() {
  const node = document.createElement('div'); document.body.append(node);
  const root = createRoot(node);
  const probe: any = {calls: [] as string[], failNext: false, hangNext: false, release: null};

  function Harness() {
    const save = React.useCallback(async (text: string) => {
      probe.calls.push(text);
      if (probe.hangNext) {
        probe.hangNext = false;
        await new Promise<void>(resolve => { probe.release = () => resolve(); });
      }
      if (probe.failNext) { probe.failNext = false; return false; }
      return true;
    }, []);
    const a = useJournalAutosave({initialText: '', entryKey: 'harness', save, debounceMs: 100});
    probe.autosave = a;
    return <section>
      <h2>日记自动保存 harness</h2>
      <textarea data-testid="text" value={a.text} onChange={e => a.setText(e.target.value)} aria-label="harness text" />
      <output data-testid="status">{a.status}</output>
    </section>;
  }

  root.render(<Harness />);
  (window as any).__j = probe;
}
