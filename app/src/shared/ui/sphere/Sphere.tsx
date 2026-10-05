import {spherePoints} from './card-layout.ts';
import {useEffect, useRef, useState, type ReactNode, type PointerEvent} from 'react';
import {useFlowFocus} from '../use-flow-focus.ts';
import './sphere.css';

export type SphereCardFace = 'front' | 'back';
export type SphereCard = Readonly<{
  id: string;
  face: SphereCardFace;
  /** Only rendered once the card is showing its front (edit mode, or after reveal). */
  frontData?: Readonly<{title: string; subtitle?: string}>;
}>;
export type SphereMode = 'edit' | 'draw';
export type SphereMotion = 'idle' | 'shuffling' | 'presented' | 'revealed' | 'paused';

export type SphereProps = Readonly<{
  cards: readonly SphereCard[];
  mode: SphereMode;
  motionState: SphereMotion;
  presentedId: string | null;
  revealedId: string | null;
  radius?: number;
  onSelectCard: (id: string) => void;
  onReveal: (id: string) => void;
  onClose: () => void;
  onReturn?: () => void;
  detail?: ReactNode;
  returnFocus?: HTMLElement | null;
}>;

/**
 * Neutral 3D sphere (C0.8). Presents cards and reports clicks; it never reads the workspace,
 * decides randomness, saves, or consumes copies. Card fronts (and their text) are not put in the
 * DOM while a card still shows its back, so content cannot be read ahead via DOM/aria/title.
 */
export function Sphere(props: SphereProps) {
  const {cards, mode, motionState, presentedId, revealedId, onSelectCard, onReveal, onClose} = props;
  const radius = props.radius ?? 220;
  const points = spherePoints(cards.length, radius);
  const locked = motionState === 'presented' || motionState === 'revealed';
  const focusRef = useFlowFocus(onClose, props.returnFocus), chosenRef = useRef<HTMLButtonElement>(null);
  const [list, setList] = useState(() => cards.length > 100 || typeof window !== 'undefined'
    && window.matchMedia('(prefers-reduced-motion: reduce), (max-width: 560px)').matches);
  const [paused, setPaused] = useState(false), [turn, setTurn] = useState({x: 0, y: 0});
  const drag = useRef<{id: number; x: number; y: number; turn: typeof turn} | null>(null);
  useEffect(() => {if (locked) chosenRef.current?.focus();}, [locked, presentedId]);

  const handleClick = (card: SphereCard) => {
    if (motionState === 'shuffling' || motionState === 'idle') onSelectCard(card.id);
    else if (motionState === 'presented' && card.id === presentedId) onReveal(card.id);
    // While revealed/paused, or when a non-presented card is clicked during lock: ignore (no id swap).
  };

  const chosen = cards.find(card => card.id === (revealedId ?? presentedId));
  const face = (card: SphereCard, index: number, front = false) => {
    const showFront = mode === 'edit' || card.id === revealedId;
    return <button ref={front ? chosenRef : undefined} type="button" className="sphere-card"
      disabled={locked && !front} data-card-id={card.id}
      aria-label={showFront && card.frontData ? card.frontData.title : `卡 ${index + 1}（未翻开）`}
      onClick={() => handleClick(card)}>
      <span className="sphere-card-inner" style={{transform: showFront ? 'rotateY(0deg)' : 'rotateY(180deg)'}}>
        <span className={`sphere-face sphere-face-front${showFront ? '' : ' is-covered'}`}>
          {showFront && card.frontData ? <><strong>{card.frontData.title}</strong>
            {card.frontData.subtitle ? <small>{card.frontData.subtitle}</small> : null}</>
            : <span className="card-back-mark" aria-hidden="true">◇</span>}
        </span>
        <span className="sphere-face sphere-face-back" aria-hidden="true"><span className="card-back-mark">◇</span></span>
      </span>
    </button>;
  };
  function pointerDown(e: PointerEvent<HTMLDivElement>) {
    if (locked || list || e.button !== 0 || (e.target as Element).closest('button')) return;
    drag.current = {id: e.pointerId, x: e.clientX, y: e.clientY, turn};
    e.currentTarget.setPointerCapture(e.pointerId); setPaused(true);
  }

  return (
    <div ref={focusRef} tabIndex={-1} className="sphere-overlay" role="dialog" aria-modal="true" aria-label="卡球面">
      <div className="sphere-toolbar">
        <span className="muted">{mode === 'edit' ? '编辑 · 卡面慢转' : '抽取 · 卡背快转'}</span>
        <button type="button" aria-pressed={list} onClick={() => setList(!list)}>{list ? '切到球面' : '静止列表'}</button>
        {!list && <button type="button" disabled={locked} aria-pressed={paused} onClick={() => setPaused(!paused)}>{paused ? '继续转动' : '暂停转动'}</button>}
        {locked && props.onReturn && <button type="button" onClick={props.onReturn}>卡片归位</button>}
        <button type="button" onClick={onClose}>关闭归位</button>
      </div>
      {!list && <div className="sphere-turn-controls">
        <button type="button" disabled={locked} onClick={() => {setPaused(true); setTurn(t => ({...t, y: t.y - 30}));}}>向左转</button>
        <button type="button" disabled={locked} onClick={() => {setPaused(true); setTurn(t => ({...t, y: t.y + 30}));}}>向右转</button>
      </div>}
      <div className={`sphere-stage${list ? ' is-list' : ''}`} onPointerDown={pointerDown}
        onPointerMove={e => {const d = drag.current; if (d?.id === e.pointerId) setTurn({x: d.turn.x - (e.clientY - d.y) / 3, y: d.turn.y + (e.clientX - d.x) / 3});}}
        onPointerUp={() => {drag.current = null;}} onPointerCancel={() => {drag.current = null;}}>
        <div className="sphere-turn" style={list ? undefined : {transform: `rotateX(${turn.x}deg) rotateY(${turn.y}deg)`}}>
        <div className={`sphere-world spin-${mode} motion-${motionState}${paused ? ' user-paused' : ''}${list ? ' sphere-list' : ''}`}>
          {cards.map((card, i) => {
            const pt = points[i];
            if (locked && card.id === chosen?.id) return <div key={card.id} className="sphere-card-placeholder"/>;
            const place = `rotateY(${pt.azimuth}deg) rotateX(${pt.elevation}deg)`;
            return (
              <div key={card.id} className={`sphere-card-wrap${locked ? ' is-dimmed' : ''}`}
                style={list ? undefined : {transform: `${place} translateZ(${radius}px)`}}>
                {face(card, i)}
              </div>
            );
          })}
        </div>
        </div>
        {locked && chosen && <div className="sphere-presented sphere-card-wrap is-chosen">{face(chosen, cards.indexOf(chosen), true)}</div>}
      </div>
      {props.detail && <div className="sphere-detail">{props.detail}</div>}
      <p className="sphere-hint muted">{locked ? mode === 'edit' ? '当前卡片在前方，编辑完成后可归位。' : revealedId ? '已翻开，继续操作或关闭归位。' : '再次点击这张卡翻开；锁定中不能另抽。' : '点一张卡让它停到前方。'}</p>
    </div>
  );
}
