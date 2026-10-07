// A0 工坊矩阵样稿：矩阵展示行动牌堆、决策牌堆与独立收纳牌堆（P04/P10/P11）。
// 可查看牌堆成员、从行动原卡“直接拿牌”、从独立清单打开网址；所有写操作仅通过回调交给样稿宿主。
import { useState } from 'react';
import { ActionCard } from '../../../shared/ui/index.ts';
import { SAMPLE_DECKS, deckKindLabel, type SampleDeck, type SampleEntry } from './sample-data.ts';
import './workshop-sample.css';

export type WorkshopMatrixSampleProps = Readonly<{
  decks?: readonly SampleDeck[];
  onTakeAction?: (entry: SampleEntry) => void;
  onOpenUrl?: (url: string, title: string) => void;
}>;

export function WorkshopMatrixSample(props: WorkshopMatrixSampleProps) {
  const { decks = SAMPLE_DECKS, onTakeAction, onOpenUrl } = props;
  const [openDeck, setOpenDeck] = useState<SampleDeck | null>(null);

  return (
    <div className="ws6">
      <div className="ws6-legend" role="note">
        <span>
          <i className="ws6-key ws6-key-origin" /> 原卡：工坊长期保留，修改不影响已生成的本次牌
        </span>
        <span>
          <i className="ws6-key ws6-key-current" /> 本次牌：拿牌后进入右下角手牌，带“本次”角标
        </span>
        <span>每个牌堆最多 100 个直接成员</span>
      </div>

      <div className="ws6-grid">
        {decks.map((deck) => {
          const preview = deck.members.slice(0, 3);
          return (
            <ActionCard
              key={deck.id}
              color={deck.color ?? 'var(--accent)'}
              title={deck.name}
              meta={`${deck.members.length} 个成员`}
              badges={[
                { id: 'kind', label: deckKindLabel(deck), tone: deck.unbound ? 'on' : undefined },
              ]}
              footer={
                <>
                  <button type="button" className="act-mini" onClick={() => setOpenDeck(deck)}>
                    查看成员{deck.kind === 'action' ? '／拿牌' : ''}
                  </button>
                  {deck.kind === 'action' ? (
                    <button
                      type="button"
                      className="act-mini primary"
                      onClick={() => onTakeAction?.(deck.members[0])}
                    >
                      直接拿牌：{deck.members[0].name}
                    </button>
                  ) : null}
                </>
              }
            >
              <div className="ws6-binding">
                {deck.unbound ? (
                  <span className="ws6-unbound">未绑定 · 纯清单</span>
                ) : deck.binding ? (
                  <span>候选来源：{deck.binding}</span>
                ) : (
                  <span className="ws6-muted">长期收纳</span>
                )}
              </div>
              <ul className="ws6-preview">
                {preview.map((m) => (
                  <li key={m.id}>{m.name}</li>
                ))}
                {deck.members.length > preview.length ? (
                  <li className="ws6-muted">＋{deck.members.length - preview.length} 条…</li>
                ) : null}
              </ul>
            </ActionCard>
          );
        })}
      </div>

      {openDeck ? (
        <div
          className="ws6-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label={`${openDeck.name} 成员`}
        >
          <div className="ws6-modal panel">
            <div className="ws6-modal-head">
              <div>
                <h2>{openDeck.name}</h2>
                <small>
                  {deckKindLabel(openDeck)} · {openDeck.members.length} 个成员
                </small>
              </div>
              <button type="button" aria-label="关闭" onClick={() => setOpenDeck(null)}>
                ×
              </button>
            </div>
            {openDeck.unbound ? (
              <p className="ws6-unbound-line" role="note">
                此清单未绑定任何行动或决策，可单纯作为清单保存。
              </p>
            ) : null}
            <ul className="ws6-members">
              {openDeck.members.map((m) => (
                <li key={m.id} className="ws6-member">
                  <div className="ws6-member-info">
                    <strong>{m.name}</strong>
                    {m.detail ? <small>{m.detail}</small> : null}
                  </div>
                  <div className="ws6-member-actions">
                    {openDeck.kind === 'action' ? (
                      <button
                        type="button"
                        className="act-mini primary"
                        onClick={() => onTakeAction?.(m)}
                      >
                        直接拿牌
                      </button>
                    ) : null}
                    {m.url ? (
                      <button
                        type="button"
                        className="act-mini"
                        onClick={() => onOpenUrl?.(m.url!, m.name)}
                      >
                        打开网址
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
