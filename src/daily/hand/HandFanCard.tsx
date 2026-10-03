import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import type { CardView } from '../../workspace/index.ts';

/** One card in the fan. Drag is optional; every card exposes equivalent buttons. */
export function HandFanCard(props: Readonly<{
  card: CardView;
  index: number;
  angle: number;
  selected: boolean;
  dragging: boolean;
  previewing: boolean;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>, card: CardView) => void;
  onView: (card: CardView) => void;
  onPlace: (card: CardView) => void;
  onRecordActual: (card: CardView) => void;
  disabled?: boolean;
}>) {
  const { card, index, angle, selected, dragging, previewing, disabled } = props;
  const style = {
    '--fan-angle': `${angle}deg`,
    '--card-color': card.color,
  } as CSSProperties;

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Let focused child buttons handle their own Enter/Space; don't also trigger onView (F06).
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      props.onView(card);
    }
  }

  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={`${card.title}，${card.presetMinutes === null ? '无时长' : card.presetMinutes + ' 分钟'}`}
      className={`fan-card${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}${previewing ? ' previewing' : ''}`}
      style={style}
      onPointerDown={event => props.onPointerDown?.(event, card)}
      onClick={() => props.onView(card)}
      onKeyDown={keyDown}
    >
      <span className="card-edge" />
      <small>{String(index + 1).padStart(2, '0')} · {card.presetMinutes === null ? '无时长' : card.presetMinutes + ' 分钟'}</small>
      <strong>{card.title}</strong>
      <span className="fan-criteria">{card.criteria || '未填写完成标准。'}</span>
      <span className="fan-card-actions">
        <button type="button" disabled={disabled} onClick={e => { e.stopPropagation(); props.onPlace(card); }}>打出</button>
        <button type="button" disabled={disabled} onClick={e => { e.stopPropagation(); props.onRecordActual(card); }}>记录实际</button>
      </span>
    </div>
  );
}
