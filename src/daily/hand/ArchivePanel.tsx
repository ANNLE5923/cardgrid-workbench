import type {WorkspaceData} from '../../workspace/index.ts';

export function ArchivePanel({data}: {data: WorkspaceData}) {
  const logs = data.version === 3 ? data.archiveLogs : [];
  return <section className="panel" aria-label="每日副本归档日志"><h2>归档日志（{logs.length}）</h2>
    <p className="muted">到期副本已退出库存与手牌，未完成排期已撤销。实际事实与批注保留。</p>
    {!logs.length && <p>还没有到期归档记录。</p>}
    {[...logs].reverse().map(log => <details key={log.id} className="hand-archive"><summary>{log.contentSnapshot.title} · 来源 {log.sourceDate} · 接受 {log.acceptedInstanceIds.length} 份</summary>
      <p>归档于 {log.archivedAt} · 原卡 {log.actionCard.id} v{log.actionCard.version}</p>
      {log.disposition === 'none-accepted' && <p>未接受到手牌，到期归档。</p>}
      {log.acceptedInstanceIds.map(id => {
        const instance = data.planner.instances.find(i => i.id === id), facts = data.planner.facts.filter(f => f.instanceId === id);
        return <article key={id}><h3>{instance?.creationSnapshot.title ?? log.contentSnapshot.title}</h3><p>来源 {log.sourceDate} · 独立行动 {id}</p>
          {instance?.daily?.slotSelections.map(s => <p key={s.slotId}>词条：{s.entrySnapshot.title}{s.entrySnapshot.author ? ` · ${s.entrySnapshot.author}` : ''}</p>)}
          {!facts.length && <p>未确认实际，到期归档。</p>}
          {facts.map(fact => <div key={fact.id}><p>已确认实际：{fact.actualRange.localStart} — {fact.actualRange.localEnd} ({fact.actualRange.zone})</p>
            {data.planner.annotations.filter(a => a.factId === fact.id).map(a => <p key={a.id}>批注 · {a.createdAt}：{a.text}</p>)}</div>)}
          {data.planner.plans.filter(p => p.instanceId === id && p.status === 'retracted').map(p => <p key={p.id}>已撤销排期：{p.range.localStart} — {p.range.localEnd}</p>)}
        </article>;
      })}
    </details>)}
  </section>;
}
