// A3 browser harness: mounts the real v0.6 workshop editor (with the synthesis
// bench) against an in-memory catalog host. The host is exposed on window so the
// walkthrough can stage answer materials (the accepted-answer UI ships in A4);
// this is test-fixture wiring only. Synthetic seed, no personal IndexedDB.
import {createRoot} from 'react-dom/client';
import {createInMemoryCatalogEditor} from '../../../src/workshop/catalog-editor.ts';
import type {CatalogV06} from '../../../src/workspace/v06.ts';
import {catalog} from '../../support/v06/fixtures.ts';
import {WorkshopEditorV06} from '../../../src/workshop/ui/v06/WorkshopEditorV06.tsx';

// Add an action-kind deck so direct material take is reachable (same as A2).
const seed: CatalogV06 = {
  ...catalog,
  decks: [
    ...catalog.decks,
    {
      id: 'action-deck', version: 1, name: '行动原卡', deckKind: 'action',
      parentDeckId: null, memberIds: ['read', 'meal', 'train'], source: {kind: 'manual'},
    },
  ],
};

const host = createInMemoryCatalogEditor(seed);
(window as unknown as {__host: typeof host}).__host = host;
createRoot(document.getElementById('root')!).render(<WorkshopEditorV06 host={host} />);
