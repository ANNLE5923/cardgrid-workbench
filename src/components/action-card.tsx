import type { ReactNode } from 'react';

export type ActionBadge = Readonly<{ id: string; label: string; tone?: 'default' | 'off' | 'on' }>;

/** Reusable presentational card for definitions and hand instances. Color drives the left edge and swatch. */
export function ActionCard(props: Readonly<{
  color?: string;
  title: string;
  meta?: string;
  badges?: readonly ActionBadge[];
  selected?: boolean;
  onOpen?: () => void;
  openLabel?: string;
  children?: ReactNode;
  footer?: ReactNode;
}>) {
  const { color = 'var(--accent)', title, meta, badges, selected, onOpen, openLabel, children, footer } = props;
  const head = (
    <>
      <span className="act-swatch" style={{ background: color }} />
      <span className="act-titles">
        <strong>{title}</strong>
        {meta ? <small>{meta}</small> : null}
      </span>
    </>
  );
  return (
    <article className={`act-card${selected ? ' selected' : ''}`} style={{ borderLeftColor: color }}>
      <div className="act-card-top">
        {onOpen ? (
          <button type="button" className="act-card-head" onClick={onOpen} aria-label={openLabel ?? `打开 ${title}`}>
            {head}
          </button>
        ) : (
          <div className="act-card-head static">{head}</div>
        )}
        {badges?.length ? (
          <div className="act-badges">
            {badges.map(b => <span key={b.id} className={`act-badge ${b.tone === undefined ? '' : b.tone}`}>{b.label}</span>)}
          </div>
        ) : null}
      </div>
      {children ? <div className="act-body">{children}</div> : null}
      {footer ? <div className="act-footer">{footer}</div> : null}
    </article>
  );
}
