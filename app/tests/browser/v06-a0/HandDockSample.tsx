// A0 全局手牌浮窗样稿（P01，合同 5.1）：固定右下角，随页面存在，跨场景同一份手牌。
// 非 Today 仅预览；Today 才出现“打出”。纯展示组件，状态由 harness 持有；不直接写任何存储。
import {useEffect, useRef, useState} from 'react';
import './hand-dock-sample.css';

export type DockCardKind = 'action' | 'answer' | 'product';

export type DockCard = Readonly<{
  instanceId: string;
  kind: DockCardKind;
  name: string;
  source: string;
  detail?: string;
}>;

const KIND_LABEL: Record<DockCardKind, string> = {
  action: '行动牌', answer: '答案牌', product: '成品牌',
};
const GROUPS: readonly DockCardKind[] = ['action', 'answer', 'product'];

export type HandDockSampleProps = Readonly<{
  cards: readonly DockCard[];
  isToday: boolean;
  onTodayModeChange?: (value: boolean) => void;
  onPlay?: (card: DockCard) => void;
}>;

export function HandDockSample(props: HandDockSampleProps) {
  const {cards, isToday, onTodayModeChange, onPlay} = props;
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<DockCard | null>(null);
  const dockButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        dockButtonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const close = () => {
    setOpen(false);
    dockButtonRef.current?.focus();
  };

  return (
    <>
      <button type="button" className="hd6-dock" ref={dockButtonRef}
        aria-expanded={open} aria-label={`手牌 ${cards.length} 张，展开`}
        onClick={() => setOpen(v => !v)}>
        <span className="hd6-dock-icon">手牌</span>
        <span className="hd6-dock-count">{cards.length}</span>
      </button>

      {open ? (
        <div className="hd6-panel" ref={panelRef} role="dialog" aria-label="本次手牌" tabIndex={-1}>
          <div className="hd6-panel-head">
            <strong>本次手牌 · {cards.length} 张</strong>
            <button type="button" aria-label="关闭手牌" onClick={close}>×</button>
          </div>
          <div className="hd6-mode">
            <label>
              <input type="checkbox" checked={isToday}
                onChange={e => onTodayModeChange?.(e.target.checked)} />
              模拟当前在 Today 页面
            </label>
            {!isToday
              ? <span className="hd6-preview-only">非 Today · 仅预览，不能打出</span>
              : <span className="hd6-can-play">Today · 可打出（样稿模拟）</span>}
          </div>
          <div className="hd6-groups">
            {GROUPS.map(kind => {
              const groupCards = cards.filter(c => c.kind === kind);
              return (
                <section key={kind} className="hd6-group">
                  <h2>{KIND_LABEL[kind]}（{groupCards.length}）</h2>
                  {groupCards.length === 0
                    ? <p className="hd6-empty">暂无</p>
                    : <ul>
                        {groupCards.map(c => (
                          <li key={c.instanceId} className="hd6-card">
                            <span className="hd6-current-badge">本次</span>
                            <div className="hd6-card-info">
                              <strong>{c.name}</strong>
                              <small>{c.source}</small>
                            </div>
                            <div className="hd6-card-actions">
                              <button type="button" className="act-mini"
                                onClick={() => setPreview(c)}>预览</button>
                              {isToday
                                ? <button type="button" className="act-mini primary"
                                    onClick={() => onPlay?.(c)}>打出</button>
                                : null}
                            </div>
                          </li>
                        ))}
                      </ul>}
                </section>
              );
            })}
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="hd6-modal-backdrop" role="dialog" aria-modal="true" aria-label="手牌详情">
          <div className="hd6-modal panel">
            <div className="hd6-modal-head">
              <h2>{preview.name}</h2>
              <button type="button" aria-label="关闭详情" onClick={() => setPreview(null)}>×</button>
            </div>
            <p className="hd6-modal-row"><span>类型</span><b>{KIND_LABEL[preview.kind]}</b></p>
            <p className="hd6-modal-row"><span>来源</span><b>{preview.source}</b></p>
            {preview.detail
              ? <p className="hd6-modal-row"><span>说明</span><b>{preview.detail}</b></p> : null}
            <div className="hd6-modal-actions">
              <button type="button" onClick={() => setPreview(null)}>关闭</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
