import {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import type {WorkspaceDrawSession} from '../workspace-session.ts';
import {Sphere} from '../../shared/ui/index.ts';
import {SlotPicker} from './SlotPicker.tsx';
import {isV3Capable} from '../../workspace/contracts-v4.ts';
import './production-draw.css';

export function ProductionDrawPanel({drawing, onData, onHand, onToday}: {drawing: WorkspaceDrawSession; onData: () => void; onHand: () => void; onToday?: () => void}) {
  const state = useSyncExternalStore(drawing.subscribe, drawing.getSnapshot);
  const [sphereOpen, setSphereOpen] = useState(false);
  const sphereTrigger = useRef<HTMLElement | null>(null);
  const [supplementRule, setSupplementRule] = useState(''), [supplementDate, setSupplementDate] = useState('');
  const phase = state.session.phase;
  useEffect(()=>{if(!state.session.deck.length)setSphereOpen(false);},[state.session.deck.length]);
  const selected = phase.kind === 'combo' ? phase.copy : phase.kind === 'presented' || phase.kind === 'revealed'
    ? state.session.deck.find(c => c.id === phase.copyId) : null;
  const disabled = state.busy || state.canRetry || state.status === 'unsupported';
  return <section className="panel production-draw" aria-label="每日库存抽卡" onKeyDown={e => {
    if (e.key === 'Escape' && !(e.target as Element).closest('.sphere-overlay')) {e.preventDefault(); drawing.cancel();}
  }}>
    <div className="production-draw-head"><div><h2>每日库存抽卡</h2><p>选定副本、翻开、填槽后接受。来源日期保留，接受后再安排时间。</p></div>
      <button type="button" disabled={state.busy || state.canRetry} onClick={() => void drawing.coordinate()}>更新今日库存</button></div>
    {state.message && <p role={state.status === 'error' || state.status === 'invalidated' || state.status === 'retry' ? 'alert' : 'status'}>{state.message}</p>}
    {state.canRetry && <button type="button" className="primary" disabled={state.busy} onClick={() => void drawing.retry()}>重试本次保存</button>}
    {state.status === 'unsupported' ? <button type="button" onClick={onData}>去数据与备份</button> : <>
      <div className="production-draw-choice">
        <label>手选库存副本<select aria-label="手选库存副本" value={selected?.id ?? ''} disabled={disabled} onChange={e => drawing.choose(e.target.value)}>
          <option value="">请选择一份副本</option>
          {state.copies.map(copy => <option key={copy.id} value={copy.id}>{copy.sourceDate} · {copy.contentSnapshot.title}{state.todayIds.includes(copy.id) ? ' · 今日' : ' · 旧副本'}</option>)}
        </select></label>
        <button type="button" className="primary" disabled={disabled} onClick={async e => {sphereTrigger.current=e.currentTarget;if (await drawing.openSphere()) setSphereOpen(true);}}>球面抽卡</button>
        <button type="button" disabled={disabled} onClick={() => void drawing.drawToday()}>抽今天的一张</button>
      </div>
      {!state.todayIds.length && <p>今天暂无可抽取副本。可以明确手选保留期内的旧副本，或更新今日库存。</p>}
      {!state.copies.length && <p>库存为空。请在工坊建立行动原卡和生成规则，也可通过配置包导入。</p>}
      <details className="production-supplement"><summary>手动补生成漏日</summary><p>只补所选规则与日期；保留期外或缺少当日版本证据的日期会拒绝。</p>
        <label>生成规则<select aria-label="补生成规则" value={supplementRule} disabled={disabled} onChange={e=>setSupplementRule(e.target.value)}><option value="">请选择规则</option>
          {isV3Capable(state.snapshot?.data) && state.snapshot!.data.generationRules.map(rule=><option key={rule.id} value={rule.id}>{rule.name}</option>)}
        </select></label><label>来源日期<input type="date" aria-label="补生成来源日期" value={supplementDate} disabled={disabled} onChange={e=>setSupplementDate(e.target.value)}/></label>
        <button type="button" disabled={disabled || !supplementRule || !supplementDate} onClick={()=>void drawing.supplement(supplementRule,supplementDate)}>补生成这一天</button>
      </details>
      {phase.kind === 'presented' && selected && <div className="production-draw-card"><p>已选定来源日 {selected.sourceDate} 的副本。</p>
        <button type="button" disabled={disabled} onClick={drawing.reveal}>翻开查看</button></div>}
      {phase.kind === 'revealed' && selected && <div className="production-draw-card"><h3>{selected.contentSnapshot.title}</h3>
        <p>{selected.contentSnapshot.criteria || '未填写完成标准。'}</p><p>来源日期：{selected.sourceDate}</p>
        <button type="button" className="primary" disabled={disabled} onClick={() => void drawing.beginCombo()}>{selected.slotSpecSnapshot.length ? '填写槽位' : '准备接受'}</button></div>}
      {phase.kind === 'combo' && <div className="production-draw-card"><h3>组合行动</h3><p>来源日期：{phase.copy.sourceDate}</p>
        {phase.copy.slotSpecSnapshot.map(spec => <SlotPicker key={spec.id} {...{spec,state,drawing,disabled}}/>)}
        {!phase.copy.slotSpecSnapshot.length && <p>这张行动没有槽位，可直接接受。</p>}
        <p className="production-draw-result">组合文字：<strong>{state.preview?.composedText ?? '正在预览…'}</strong></p>
        <button type="button" className="primary" disabled={disabled || !state.preview?.ready} onClick={() => void drawing.accept()}>{state.status === 'submitting' ? '正在保存…' : '接受，加入手牌'}</button>
      </div>}
      {state.status === 'success' && <><button type="button" onClick={onHand}>查看手牌</button>{onToday && <button type="button" className="primary" onClick={onToday}>返回 Today 安排</button>}</>}
      {state.session.deck.length > 0 && <button type="button" disabled={state.status === 'submitting' || state.canRetry} onClick={drawing.cancel}>取消本次抽卡</button>}
      {sphereOpen && state.session.deck.length > 0 && phase.kind !== 'combo' && <div className="sphere-modal"><Sphere mode="draw" returnFocus={sphereTrigger.current}
        cards={state.session.deck.map(copy => ({id: copy.id, face: 'back', frontData: {title: copy.contentSnapshot.title, subtitle: `来源 ${copy.sourceDate}`}}))}
        motionState={phase.kind} presentedId={phase.kind === 'presented' || phase.kind === 'revealed' ? phase.copyId : null}
        revealedId={phase.kind === 'revealed' ? phase.copyId : null} onSelectCard={drawing.present}
        onReveal={() => drawing.reveal()} onClose={() => {drawing.cancel(); setSphereOpen(false);}}
        detail={phase.kind === 'revealed' && <button type="button" className="primary" onClick={async () => {await drawing.beginCombo(); setSphereOpen(false);}}>{selected?.slotSpecSnapshot.length ? '填写槽位' : '准备接受'}</button>}/></div>}
    </>}
  </section>;
}
