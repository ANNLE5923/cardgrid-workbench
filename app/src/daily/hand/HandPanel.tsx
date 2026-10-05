import type {Instance, WorkspaceData} from '../../workspace/index.ts';
import {ActionCard} from '../../shared/ui/index.ts';
import {groupHand} from './stacking.ts';
type Props={hand:Instance[];withdrawn:Instance[];data:WorkspaceData;busy:boolean;readOnly:boolean;move:(index:number,delta:number)=>void;withdraw:(instance:Instance)=>void;returnToHand:(instance:Instance)=>void;};
export function HandPanel({hand,withdrawn,data,busy,readOnly,move,withdraw,returnToHand}:Props){
 const groups = groupHand(hand, data);
 const row = (i:Instance) => {const index = hand.findIndex(h => h.id === i.id); return <div key={i.id} className="hand-stack-member" data-instance-id={i.id}>
   <p>{i.daily ? `来源 ${i.daily.sourceDate}` : '独立行动'} · {i.targetDate ? `目标 ${i.targetDate}` : '尚未安排日期'} · v{i.version}</p>
   {i.daily?.slotSelections.map(s => <p key={s.slotId}>已选词条：{s.entrySnapshot.title}{s.entrySnapshot.author ? ` · ${s.entrySnapshot.author}` : ''}</p>)}
   <div className="hand-row-actions">
     <button type="button" className="act-mini" disabled={busy || index === 0} onClick={() => move(index,-1)} aria-label="上移">↑</button>
     <button type="button" className="act-mini" disabled={busy || index === hand.length-1} onClick={() => move(index,1)} aria-label="下移">↓</button>
     <button type="button" className="act-mini" disabled={busy || readOnly} onClick={() => withdraw(i)}>撤出</button>
   </div>
 </div>;};
 return (<div className="hand-groups">
          <section>
            <div className="sectiontitle"><h2>持有手牌（{hand.length}）</h2></div>
            {hand.length ? (
              <div className="hand-grid">
                {groups.map(group => {const i=group.members[0];return (
                  <ActionCard key={group.key} color={i.currentContent.color} title={i.currentContent.title}
                    meta={`${i.currentContent.presetMinutes === null ? '无预设时长' : i.currentContent.presetMinutes + ' 分钟'} · v${i.version}`}
                    badges={[...(group.members.length>1?[{id:'stack',label:`×${group.members.length}`}]:[]),...(i.targetDate ? [{ id: 'date', label: '目标 ' + i.targetDate }] : [])]}>
                    {i.currentContent.criteria ? <p>{i.currentContent.criteria}</p> : null}
                    {group.members.length>1 ? <details><summary>展开 {group.members.length} 份独立手牌</summary>{group.members.map(row)}</details> : row(i)}
                  </ActionCard>
                );})}
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
