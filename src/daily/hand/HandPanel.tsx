import type {Instance} from '../../workspace/index.ts';
import {ActionCard} from '../../shared/ui/index.ts';
type Props={hand:Instance[];withdrawn:Instance[];busy:boolean;readOnly:boolean;move:(index:number,delta:number)=>void;withdraw:(instance:Instance)=>void;returnToHand:(instance:Instance)=>void;};
export function HandPanel({hand,withdrawn,busy,readOnly,move,withdraw,returnToHand}:Props){
 return (<div className="hand-groups">
          <section>
            <div className="sectiontitle"><h2>持有手牌（{hand.length}）</h2></div>
            {hand.length ? (
              <div className="hand-grid">
                {hand.map((i, index) => (
                  <ActionCard key={i.id} color={i.currentContent.color} title={i.currentContent.title}
                    meta={`${i.currentContent.presetMinutes === null ? '无预设时长' : i.currentContent.presetMinutes + ' 分钟'} · v${i.version}`}
                    badges={i.targetDate ? [{ id: 'date', label: '目标 ' + i.targetDate }] : []}>
                    {i.currentContent.criteria ? <p>{i.currentContent.criteria}</p> : null}
                    <div className="hand-row-actions" style={{ marginTop: 10 }}>
                      <button type="button" className="act-mini" disabled={busy || index === 0} onClick={() => move(index, -1)} aria-label="上移">↑</button>
                      <button type="button" className="act-mini" disabled={busy || index === hand.length - 1} onClick={() => move(index, 1)} aria-label="下移">↓</button>
                      <button type="button" className="act-mini" disabled={busy || readOnly} onClick={() => withdraw(i)}>撤出</button>
                    </div>
                  </ActionCard>
                ))}
              </div>
            ) : <p className="emptyline">手牌为空。到“抽取建议”接受一张，行动会出现在这里。</p>}
          </section>

          <section>
            <div className="sectiontitle"><h2>已撤出（{withdrawn.length}）</h2></div>
            {withdrawn.length ? (
              <div className="hand-grid">
                {withdrawn.map(i => (
                  <ActionCard key={i.id} color={i.currentContent.color} title={i.currentContent.title} meta={`v${i.version}`}
                    badges={[{ id: 'wd', label: '已撤出', tone: 'off' }]}>
                    <div className="hand-row-actions" style={{ marginTop: 10 }}>
                      <button type="button" className="act-mini" disabled={busy || readOnly} onClick={() => returnToHand(i)}>放回手牌</button>
                    </div>
                  </ActionCard>
                ))}
              </div>
            ) : <p className="emptyline">没有已撤出的行动。</p>}
          </section>
        </div>);
}
