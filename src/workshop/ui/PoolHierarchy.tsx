import type {Id, Pool} from '../../workspace/index.ts';
import {childrenOf, pathTo, rootPools} from '../hierarchy.ts';
import {Matrix} from '../../shared/ui/index.ts';

type Props = Readonly<{
  pools: readonly Pool[];
  currentId: Id | null;
  onNavigate: (parentId: Id | null) => void;
  onOpenPool: (pool: Pool) => void;
  onNewHere: (parentId: Id | null) => void;
  paused?: boolean;
  onContents?: (pool: Pool) => void;
  contentDisabled?: boolean;
}>;

/** File-manager style pool navigation: breadcrumb + current layer + drill in / up. */
export function PoolHierarchy({pools, currentId, onNavigate, onOpenPool, onNewHere, paused, onContents, contentDisabled}: Props) {
  const byId = new Map(pools.map(p => [p.id, p]));
  const layer = currentId === null ? rootPools(pools) : childrenOf(pools, currentId);
  const crumbs = currentId === null ? [] : pathTo(pools, currentId);
  const current = currentId ? byId.get(currentId) : null;
  const upTo = currentId === null ? null : (current?.parentPoolId ?? null);

  return (
    <>
      <div className="sectiontitle">
        <h2>卡池层级（{pools.length}）</h2>
        <button type="button" className="act-mini primary" onClick={() => onNewHere(currentId)}>＋ 在此新建</button>
      </div>

      <nav className="pool-crumbs" aria-label="卡池层级路径" style={{margin: '8px 0', display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center'}}>
        <button type="button" className="act-mini" onClick={() => onNavigate(null)}>全部顶层</button>
        {crumbs.map((id, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={id} style={{display: 'inline-flex', gap: 4, alignItems: 'center'}}>
              <span aria-hidden="true" className="muted">/</span>
              <button type="button" className="act-mini" aria-current={last ? 'page' : undefined}
                disabled={last} onClick={() => onNavigate(id)}>{byId.get(id)?.name ?? id}</button>
            </span>
          );
        })}
      </nav>

      <div className="action-list">
        {layer.length ? <Matrix mode="edit" paused={paused} cards={layer.map(p => ({id:p.id,face:'front',frontData:{title:p.name,
          subtitle:`${p.poolKind === 'book' ? '书目池' : '行动池'} · 成员 ${p.memberIds.length}${childrenOf(pools,p.id).length ? ` · 子池 ${childrenOf(pools,p.id).length}` : ''}`}}))}
          onEnter={onNavigate} actions={id => {const p=byId.get(id)!;return <span className="row-actions">
                <button type="button" className="act-mini" onClick={() => onOpenPool(p)}>编辑</button>
                <button type="button" className="act-mini" onClick={() => onNewHere(p.id)}>＋子池</button>
              </span>;}}/> : <p className="emptyline">这一层还没有池，点“在此新建”。</p>}
      </div>

      <div className="toolbar" style={{marginTop: 10}}>
        {currentId !== null ? <button type="button" onClick={() => onNavigate(upTo)}>返回上层</button> : null}
        {current && onContents && <button type="button" className="primary" disabled={contentDisabled || !current.memberIds.length} onClick={() => onContents(current)}>展开当前牌堆（{current.memberIds.length}）</button>}
      </div>
    </>
  );
}
