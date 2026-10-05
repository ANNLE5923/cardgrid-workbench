import {gridDims, wavePhase} from './card-layout.ts';
import type {SphereCard, SphereMode} from './Sphere.tsx';
import type {ReactNode} from 'react';
import './sphere.css';

export type MatrixProps = Readonly<{
  cards: readonly SphereCard[];
  mode: SphereMode;
  /** Click a pile/card to enter its sphere. */
  onEnter: (id: string) => void;
  paused?: boolean;
  actions?: (id: string) => ReactNode;
}>;

/**
 * Neutral wave matrix (C0.8 companion to Sphere): even rows/columns with a phase-offset ripple.
 * Draw mode shows uniform card backs and never renders front text; edit mode shows card faces.
 */
export function Matrix({cards, mode, onEnter, paused, actions}: MatrixProps) {
  const {cols} = gridDims(cards.length);
  const showFront = mode === 'edit';
  return (
    <div className={`matrix-board${paused ? ' is-paused' : ''}`}>
      <div className="matrix-grid" style={{gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0,1fr))`}}>
        {cards.map((card, i) => (
          <div key={card.id} className="matrix-pile action-list-row"><button type="button" className="matrix-cell row-open"
            aria-label={showFront && card.frontData ? card.frontData.title : `牌堆 ${i + 1}（卡背）`}
            onClick={() => onEnter(card.id)}>
            <span className="matrix-card-visual" style={{animationDelay: `${-wavePhase(i, Math.max(1, cols)) * 0.75}s`}}>
            {showFront && card.frontData ? (
              <span className="matrix-face"><strong>{card.frontData.title}</strong>
                {card.frontData.subtitle ? <small>{card.frontData.subtitle}</small> : null}</span>
            ) : <span className="matrix-back" aria-hidden="true"><span className="card-back-mark">◇</span></span>}
            </span></button>{actions?.(card.id)}</div>
        ))}
      </div>
    </div>
  );
}
