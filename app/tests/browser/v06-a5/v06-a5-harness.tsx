// A5 browser harness: drive the real WorkshopEditorV06 (with its built-in
// SynthesisBenchV06) against the formal IndexedDB-backed host through the A5
// adapter. installB4 migrates to DataV5 and seeds the synthetic catalog; an
// action deck containing 'read' is added so the matrix can take an action, and
// one same-owner answer is pre-staged via the already-B5-proven accept flow.
// Host/editor are exposed on window for fault injection and assertions.
import {createRoot} from 'react-dom/client';
import {installB4} from '../v06-b4-harness.ts';
import {createFormalCatalogEditor} from '../../../src/workshop/formal-catalog-editor.ts';
import {WorkshopEditorV06} from '../../../src/workshop/ui/v06/WorkshopEditorV06.tsx';

const cg = installB4('cardgrid-a5-synthetic-only');
const initial = cg.ok(await cg.host.load());
if (initial.mode === 'uninitialized') {
  await cg.setup();
  // Action deck for the read action, so the matrix offers a direct take and the
  // synthesis bench has an action material with the same owner as the answer.
  await cg.submit('SaveDeck', {
    deck: {
      id: 'actions-read', version: 1, name: '行动·阅读', deckKind: 'action',
      parentDeckId: null, memberIds: ['read'], source: {kind: 'manual'},
    },
    expectedVersion: null,
  });
  // Pre-stage one answer (which-book -> book-a, owner read). Only on first
  // setup: reload must not accept a duplicate answer. Equivalent to the
  // B5-verified decision accept UI.
  await cg.answer();
}
const editor = createFormalCatalogEditor(cg.host);
Object.assign(window, {cg, editor});

function Harness() {
  return (
    <div className="app paper comfortable">
      <main className="a5h" style={{paddingTop: 16}}>
        <h1 style={{fontSize: 18, color: '#2c4239'}}>A5 正式接线走查（IndexedDB）</h1>
        <WorkshopEditorV06 host={editor} />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
