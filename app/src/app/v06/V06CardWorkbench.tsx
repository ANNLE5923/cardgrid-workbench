/** B5 integration surface for A5/B6. Uses the formal core and A4 UI; the full
 * application cutover remains with B6/B7 so existing Today keeps its contract. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createV06DecisionSession, type V06Host } from '../../workspace/index.ts';
import type { CatalogV06, HandCard } from '../../workspace/v06.ts';
import { createV06ActionSession } from '../../drawing/model.ts';
import { V06ActionDrawPanel } from '../../drawing/index.ts';
import { DecisionMatrixV06 } from '../../decision/ui/index.ts';
import { V06HandDock } from '../../daily/index.ts';
import '../style.css';
import './v06-card-workbench.css';

export function V06CardWorkbench({
  host,
  showDock = true,
  active = true,
}: Readonly<{ host: V06Host; showDock?: boolean; active?: boolean }>) {
  const decisionSession = useMemo(() => createV06DecisionSession(host), [host]),
    drawing = useMemo(() => createV06ActionSession(host), [host]);
  const [catalog, setCatalog] = useState<CatalogV06 | null>(null),
    [cards, setCards] = useState<readonly HandCard[]>([]),
    [decisionId, setDecisionId] = useState(''),
    [page, setPage] = useState<'action' | 'decision'>('action'),
    [message, setMessage] = useState('');
  const refreshSequence = useRef(0);
  const refresh = async () => {
    const sequence = ++refreshSequence.current;
    const s = await host.loadV5();
    if (sequence !== refreshSequence.current) return;
    if (!s.ok) {
      setCards([]);
      setMessage(s.message);
      setCatalog(null);
      return;
    }
    const [c, h] = await Promise.all([
      host.readCatalog({ token: s.value.token }),
      host.readMaterials({ token: s.value.token }),
    ]);
    if (sequence !== refreshSequence.current) return;
    if (c.ok) setCatalog(c.value.data);
    else setMessage(c.message);
    if (h.ok) setCards(h.value.data);
    else setMessage(h.message);
  };
  useEffect(() => {
    void refresh();
    void drawing.start();
    const off = host.subscribe(() => void refresh());
    return () => {
      ++refreshSequence.current;
      off();
      decisionSession.close();
      drawing.close();
    };
  }, [host, drawing, decisionSession]);
  const decision = catalog?.decisionCards.find((d) => d.id === decisionId);
  if (!active) return null;
  return (
    <div className="app paper comfortable">
      <main className="v06-card-workbench">
        <h1>通用卡牌</h1>
        <nav aria-label="卡牌视图">
          <button
            type="button"
            aria-current={page === 'action' ? 'page' : undefined}
            onClick={() => setPage('action')}
          >
            行动抽卡
          </button>
          <button
            type="button"
            aria-current={page === 'decision' ? 'page' : undefined}
            onClick={() => setPage('decision')}
          >
            决策答案
          </button>
        </nav>
        {message && <p role="alert">{message}</p>}
        <p role="status">已保存本次牌：{cards.filter((c) => c.state === 'available').length} 张</p>
        {page === 'action' && (
          <V06ActionDrawPanel drawing={drawing} onAccepted={() => void refresh()} />
        )}
        {page === 'decision' && (
          <>
            <label>
              选择问题
              <select
                aria-label="选择问题"
                value={decisionId}
                onChange={(e) => setDecisionId(e.target.value)}
              >
                <option value="">选择一个问题</option>
                {catalog?.decisionCards
                  .filter((d) => d.status === 'active')
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.question}
                    </option>
                  ))}
              </select>
            </label>
            {decision && (
              <DecisionMatrixV06
                port={decisionSession}
                decision={decision}
                onAccepted={() => void refresh()}
                onExit={() => setDecisionId('')}
              />
            )}
          </>
        )}
        <section aria-label="已保存素材">
          <h2>本次素材</h2>
          {cards
            .filter((c) => c.state === 'available')
            .map((c) => (
              <p key={c.id} data-material-id={c.id}>
                {c.kind === 'answer'
                  ? c.answer.entry.title
                  : c.kind === 'entry'
                    ? c.entrySnapshot.title
                    : c.contentSnapshot.title}
              </p>
            ))}
        </section>
      </main>
      {showDock && <V06HandDock host={host} />}
    </div>
  );
}
