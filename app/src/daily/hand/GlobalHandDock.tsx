import { useEffect, useId, useRef, useState } from 'react';
import type { HandDockItem, HandDockView } from './unified.ts';
import { handUnavailableText } from './unified.ts';
import './global-hand-dock.css';

const kinds = ['action', 'answer', 'composite', 'entry'] as const;
const labels = { action: '行动牌', answer: '答案牌', composite: '成品牌', entry: '资源素材' };
/** One app-level projection. No storage, draft cards, random draws or hidden commands. */
export function GlobalHandDock({
  view,
  isToday,
  onPlay,
  onRefresh,
  busy = false,
  error = '',
  loading = false,
}: Readonly<{
  view: HandDockView | null;
  isToday: boolean;
  onPlay?: (item: HandDockItem, view: HandDockView) => void;
  busy?: boolean;
  error?: string;
  loading?: boolean;
  onRefresh?: () => void;
}>) {
  const [open, setOpen] = useState(false),
    [previewKey, setPreviewKey] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLElement>(null),
    detail = useRef<HTMLElement>(null);
  const panelId = useId(),
    previewButton = useRef<HTMLButtonElement | null>(null),
    epoch = useRef(view?.token.epoch);
  const items = view?.items ?? [],
    preview = items.find((i) => i.key === previewKey);
  const close = () => {
    setOpen(false);
    setPreviewKey(null);
    button.current?.focus();
  };
  const closeDetail = () => {
    setPreviewKey(null);
    (previewButton.current?.isConnected ? previewButton.current : panel.current)?.focus();
  };
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  useEffect(() => {
    if (previewKey) detail.current?.focus();
  }, [previewKey]);
  useEffect(() => {
    if (epoch.current !== view?.token.epoch) {
      epoch.current = view?.token.epoch;
      setPreviewKey(null);
      if (open) panel.current?.focus();
    } else if (previewKey && !preview) {
      setPreviewKey(null);
      if (open) panel.current?.focus();
    }
  }, [view, previewKey, preview, open]);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        previewKey ? closeDetail() : close();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, previewKey]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="cg-hand-dock"
        aria-label={`手牌 ${items.length} 张，${open ? '收起' : '展开'}`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
      >
        手牌 <b>{items.length}</b>
      </button>
      {open && (
        <section
          id={panelId}
          ref={panel}
          tabIndex={-1}
          className="cg-hand-panel"
          role="dialog"
          aria-label="本次手牌"
        >
          <div className="cg-hand-head">
            <strong>本次手牌 · {items.length} 张</strong>
            <button type="button" aria-label="关闭手牌" onClick={close}>
              ×
            </button>
          </div>
          <p>{isToday ? 'Today · 选择一份手牌安排' : '非 Today · 仅预览'}</p>
          {loading && <p role="status">正在更新手牌…</p>}
          {error && (
            <p role="alert">
              {error}
              {onRefresh && (
                <button type="button" disabled={loading || busy} onClick={onRefresh}>
                  重新读取手牌
                </button>
              )}
            </p>
          )}
          {!items.length && (
            <p className="emptyline">手牌为空。拿牌、接受答案或合成后会在这里出现。</p>
          )}
          {kinds.map((kind) => {
            const cards = items.filter((i) => i.kind === kind);
            return (
              cards.length > 0 && (
                <section key={kind} aria-label={labels[kind]}>
                  <h2>
                    {labels[kind]}（{cards.length}）
                  </h2>
                  <ul>
                    {cards.map((item) => (
                      <li key={item.key} data-hand-id={item.id} data-hand-key={item.key}>
                        <strong>{item.title}</strong>
                        <small>{item.source}</small>
                        <small>
                          本次 {item.id} · v{item.version}
                        </small>
                        {item.unavailableReason && (
                          <p>{handUnavailableText(item.unavailableReason)}</p>
                        )}
                        <div>
                          <button
                            type="button"
                            onClick={(e) => {
                              previewButton.current = e.currentTarget;
                              setPreviewKey(item.key);
                            }}
                          >
                            预览
                          </button>
                          {isToday && onPlay && (
                            <button
                              type="button"
                              disabled={busy || loading || !!error || !item.usableInToday}
                              onClick={() => {
                                if (view && !busy && !loading && !error && item.usableInToday)
                                  onPlay(item, view);
                              }}
                            >
                              打出
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            );
          })}
          {preview && (
            <section
              ref={detail}
              tabIndex={-1}
              className="cg-hand-detail"
              role="dialog"
              aria-label="手牌详情"
            >
              <div className="cg-hand-head">
                <h2>{preview.title}</h2>
                <button type="button" aria-label="关闭详情" onClick={closeDetail}>
                  ×
                </button>
              </div>
              <p>
                {labels[preview.kind]} · {preview.source}
              </p>
              <pre>{preview.detail}</pre>
            </section>
          )}
        </section>
      )}
    </>
  );
}
