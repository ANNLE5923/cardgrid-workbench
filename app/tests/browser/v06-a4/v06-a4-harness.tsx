// A4 browser harness: pick a decision, then drive the real DecisionMatrixV06
// against the in-memory host (structurally serving DecisionSessionPort). The
// decision list is read live from the host and the host is exposed on window,
// so the walkthrough can prepare extra candidates/decisions (test fixture).
// Shows the current hand count. Synthetic seed, no personal IndexedDB.
import {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createInMemoryCatalogEditor} from '../../../src/workshop/catalog-editor.ts';
import type {CatalogV06, DecisionCard} from '../../../src/workspace/v06.ts';
import type {Id} from '../../../src/workspace/index.ts';
import {catalog} from '../../support/v06/fixtures.ts';
import {DecisionMatrixV06} from '../../../src/decision/ui/DecisionMatrixV06.tsx';
import type {DecisionSessionPort} from '../../../src/decision/ui/decision-session.ts';

const seed: CatalogV06 = {
  ...catalog,
  decks: [
    ...catalog.decks,
    {id: 'action-deck', version: 1, name: '行动原卡', deckKind: 'action',
      parentDeckId: null, memberIds: ['read', 'meal', 'train'], source: {kind: 'manual'}},
  ],
};

function Harness() {
  const [host] = useState(() => createInMemoryCatalogEditor(seed));
  const [decisions, setDecisions] = useState<readonly DecisionCard[]>([]);
  const [decId, setDecId] = useState<Id | ''>('');
  const [handCount, setHandCount] = useState(0);

  const refreshDecisions = async () => {
    const r = await host.readCatalog();
    if (r.ok) setDecisions(r.value.data.decisionCards);
  };
  const refreshHand = async () => {
    const r = await host.readHand();
    if (r.ok) setHandCount(r.value.data.length);
  };
  useEffect(() => {
    (window as unknown as {__host: typeof host}).__host = host;
    refreshDecisions();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const decision = decisions.find(d => d.id === decId);

  return (
    <div className="a4h">
      <div className="a4h-picker" style={{background: '#fffefa', border: '1px solid #dfe4da',
        borderRadius: 14, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10}}>
        <h1 style={{margin: 0, fontSize: 18, color: '#2c4239'}}>A4 决策矩阵走查（内存）</h1>
        <div className="a4h-row" style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
          <select aria-label="选择决策" value={decId}
            onChange={e => {setDecId(e.target.value as Id | ''); setHandCount(0);}}>
            <option value="">选择一个决策…</option>
            {decisions.map(d => (
              <option key={d.id} value={d.id}>{d.question}（{d.id}）</option>
            ))}
          </select>
          <button type="button" onClick={refreshDecisions}>刷新决策列表</button>
        </div>
        <span className="a4h-hand" style={{fontSize: 13, color: '#758279'}}>
          本次手牌：{handCount} 张</span>
      </div>

      {decision ? (
        <DecisionMatrixV06
          port={host as unknown as DecisionSessionPort}
          decision={decision}
          onAccepted={async () => refreshHand()}
          onExit={() => {setDecId(''); refreshHand();}} />
      ) : null}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
