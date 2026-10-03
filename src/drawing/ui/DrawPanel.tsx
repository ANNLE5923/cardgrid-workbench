import type {Definition,Id,Settings} from '../../workspace/index.ts';
import {ActionCard} from '../../shared/ui/index.ts';
type Props={categories:Settings['categories'];categoryId:Id|'';minimum:boolean;offer:Definition|null|undefined;busy:boolean;readOnly:boolean;
 setCategoryId:(value:Id|'')=>void;setMinimum:(value:boolean)=>void;setOffer:(value:Definition|null|undefined)=>void;draw:()=>Promise<void>;accept:()=>Promise<void>;};
export function DrawPanel({categories,categoryId,minimum,offer,busy,readOnly,setCategoryId,setMinimum,setOffer,draw,accept}:Props){
 return (<section className="panel draw-stage">
          <div className="draw-filters">
            <label style={{ flexDirection: 'column', gap: 8, fontSize: 12, color: 'var(--muted)' }}>分类筛选
              <select aria-label="分类筛选" value={categoryId} disabled={busy} onChange={e => { setCategoryId(e.target.value as Id | ''); setOffer(undefined); }}>
                <option value="">全部分类</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--ink)' }}>
              <input type="checkbox" checked={minimum} disabled={busy} onChange={e => { setMinimum(e.target.checked); setOffer(undefined); }} />只抽最低限度
            </label>
          </div>

          <div className="draw-actions">
            <button type="button" className="primary" disabled={busy || readOnly} onClick={() => void draw()}>{offer === undefined ? '抽一张建议' : '重新抽取'}</button>
          </div>

          {offer === undefined ? (
            <p className="draw-empty">点击抽取，系统会从启用的定义中随机建议一张；这一步不会创建任何行动。</p>
          ) : offer === null ? (
            <p className="draw-empty" role="status">当前没有符合条件的定义可抽取。可以调整筛选，或到“行动定义”里新建、启用定义。</p>
          ) : (
            <div className="draw-card">
              <ActionCard color={offer.content.color} title={offer.content.title}
                meta={`${offer.content.presetMinutes === null ? '无预设时长' : offer.content.presetMinutes + ' 分钟'}${offer.content.categoryLabel ? ' · ' + offer.content.categoryLabel : ''}`}
                badges={offer.content.minimum ? [{ id: 'min', label: '最低限度' }] : []}>
                {offer.content.criteria ? <p>{offer.content.criteria}</p> : <p className="muted">未填写完成标准。</p>}
              </ActionCard>
              <div className="draw-actions" style={{ marginTop: 14 }}>
                <button type="button" className="primary" disabled={busy || readOnly} onClick={() => void accept()}>接受，加入手牌</button>
                <button type="button" disabled={busy} onClick={() => void draw()}>重抽</button>
              </div>
            </div>
          )}
        </section>);
}
