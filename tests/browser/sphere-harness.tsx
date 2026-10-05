// A3 neutral-visual harness. No workspace / IDB: feeds synthetic cards to Matrix/Sphere and drives
// matrix -> sphere -> two-click reveal, mode switch, and 10/100/500 capacities. Used by the browser check.
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Sphere} from '../../src/shared/ui/sphere/Sphere.tsx';
import {Matrix} from '../../src/shared/ui/sphere/Matrix.tsx';
import type {SphereCard, SphereMode, SphereMotion} from '../../src/shared/ui/sphere/Sphere.tsx';
import '../../src/app/style.css';

const TITLES = ['阅读', '散步', '写作', '运动', '冥想', '整理', '复习', '拉伸', '喝水', '计划', '清扫', '采购'];
function makeCards(n: number): SphereCard[] {
  return Array.from({length: n}, (_, i) => ({
    id: `c-${i + 1}`, face: 'back',
    // frontData is passed even in draw mode; the neutral components must keep it out of the DOM
    // until reveal, which is exactly what the browser check verifies.
    frontData: {title: `${TITLES[i % TITLES.length]} ${i + 1}`, subtitle: '来源日 D'},
  }));
}

function Harness() {
  const [cards, setCards] = useState<readonly SphereCard[]>(() => makeCards(12));
  const [view, setView] = useState<'matrix' | 'sphere'>('matrix');
  const [mode, setMode] = useState<SphereMode>('draw');
  const [motion, setMotion] = useState<SphereMotion>('shuffling');
  const [presentedId, setPresentedId] = useState<string | null>(null);
  const [revealedId, setRevealedId] = useState<string | null>(null);

  const startMotion = (m: SphereMode): SphereMotion => (m === 'edit' ? 'idle' : 'shuffling');
  const load = (n: number) => {
    setCards(makeCards(n)); setView('matrix');
    setPresentedId(null); setRevealedId(null); setMotion(startMotion(mode));
  };
  const enter = () => {
    setView('sphere'); setPresentedId(null); setRevealedId(null); setMotion(startMotion(mode));
  };
  const select = (id: string) => { setPresentedId(id); setMotion('presented'); };
  const reveal = (id: string) => { setRevealedId(id); setMotion('revealed'); };
  const close = () => {
    setView('matrix'); setPresentedId(null); setRevealedId(null); setMotion(startMotion(mode));
  };
  const toggleMode = () => {
    const m: SphereMode = mode === 'draw' ? 'edit' : 'draw';
    setMode(m); setView('matrix'); setPresentedId(null); setRevealedId(null); setMotion(startMotion(m));
  };

  return (
    <div className="app paper comfortable" style={{minHeight: '100vh'}}>
      <main className="action-shell">
        <div className="toolbar" style={{flexWrap: 'wrap'}}>
          <button type="button" onClick={toggleMode}>模式：{mode === 'draw' ? '抽取（卡背）' : '编辑（卡面）'}</button>
          {[10, 100, 500].map(n =>
            <button key={n} type="button" onClick={() => load(n)}>{n} 张</button>)}
          {view === 'sphere' ? <button type="button" onClick={() => setView('matrix')}>返回矩阵</button> : null}
        </div>
        {view === 'matrix'
          ? <Matrix cards={cards} mode={mode} onEnter={enter} />
          : <Sphere cards={cards} mode={mode} motionState={motion}
              presentedId={presentedId} revealedId={revealedId}
              onSelectCard={select} onReveal={reveal} onClose={close} />}
      </main>
    </div>
  );
}

const el = document.createElement('div');
document.body.appendChild(el);
createRoot(el).render(<Harness />);
