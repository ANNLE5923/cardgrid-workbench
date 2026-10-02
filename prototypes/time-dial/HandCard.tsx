import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import type { CardView } from '../../docs/产品设计/1C-prototype-contract.ts';

export function HandCard({ card, number, angle, selected, dragging, previewing, position, onPointerDown, onView }: {
  card: CardView; number: number; angle: number; selected: boolean; dragging: boolean; previewing: boolean;
  position: { x: number; y: number } | null;
  onPointerDown: (event: PointerEvent<HTMLDivElement>, card: CardView) => void;
  onView: (card: CardView) => void;
}) {
  const style = { '--fan-angle': `${angle}deg`, ...(position ? { left: position.x, top: position.y, bottom: 'auto' } : {}) } as CSSProperties;
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onView(card); }
  }
  return <div role="button" tabIndex={0} aria-label={`查看或拖动 ${card.title}`}
    className={`hand-card ${selected ? 'selected' : ''} ${dragging ? 'dragging' : ''} ${previewing ? 'previewing' : ''}`}
    style={style} onPointerDown={event => onPointerDown(event, card)} onClick={() => onView(card)} onKeyDown={keyDown}>
    <span className="card-edge"/><small>{String(number).padStart(2, '0')} · {card.presetMinutes} 分钟</small>
    <strong>{card.title}</strong><span className="hand-card-criteria">{card.criteria}</span>
  </div>;
}
