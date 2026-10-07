// A2 browser harness: mounts the real v0.6 workshop editor against an in-memory
// catalog host. Synthetic seed only; nothing touches personal IndexedDB.
import {createRoot} from 'react-dom/client';
import {createInMemoryCatalogEditor} from '../../../src/workshop/catalog-editor.ts';
import type {CatalogV06} from '../../../src/workspace/v06.ts';
import {catalog} from '../../support/v06/fixtures.ts';
import {WorkshopEditorV06} from '../../../src/workshop/ui/v06/WorkshopEditorV06.tsx';

// The shared fixture has no action-kind deck; add one so the direct material
// take entry point and action deck management are reachable in the walkthrough.
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
createRoot(document.getElementById('root')!).render(<WorkshopEditorV06 host={host} />);
