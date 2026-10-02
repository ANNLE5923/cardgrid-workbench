import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, Definition, Id, Instance, SubmitResult } from './action-contract.ts';
import type { WorkspaceClient } from './workspace-client.ts';
import type { WorkspaceSnapshot } from './action-commands.ts';
import { ActionCard } from './components/action-card.tsx';
import { DayBoard } from './components/day-board.tsx';
import './action.css';

type View = 'draw' | 'hand' | 'day';
type Notice = { kind: 'ok' | 'err'; text: string };
type Offer = Definition | null | undefined; // undefined = not drawn yet, null = no eligible definition

export function ActionHand({ client }: { client: WorkspaceClient }) {
  const [snap, setSnap] = useState<WorkspaceSnapshot | null>(null);
  const [view, setView] = useState<View>('draw');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [categoryId, setCategoryId] = useState<Id | ''>('');
  const [minimum, setMinimum] = useState(false);
  const [offer, setOffer] = useState<Offer>(undefined);

  const reload = useCallback(async () => {
    const r = await client.load();
    if (r.ok) setSnap(r.value); else setNotice({ kind: 'err', text: r.message });
  }, [client]);
  useEffect(() => {
    void reload();
    const off = client.subscribe(() => { void reload(); });
    return () => off();
  }, [client, reload]);

  const data = snap?.data ?? null;
  const readOnly = snap?.mode === 'legacy-readonly';
  const categories = data?.settings.categories ?? [];
  const instances = data?.planner.instances ?? [];
  const handOrder = data?.planner.handOrder ?? [];
  const hand: Instance[] = handOrder
    .map(id => instances.find(i => i.id === id))
    .filter((i): i is Instance => Boolean(i));
  const withdrawn = instances.filter(i => i.state === 'withdrawn');

  async function run(type: Command['type'], payload: unknown): Promise<boolean> {
    if (lock.current || !snap) return false;
    lock.current = true; setBusy(true);
    try {
      const command = { commandId: crypto.randomUUID(), expected: snap.token, type, payload } as Command;
      const r: SubmitResult = await client.submit(command);
      if (!r.ok) {
        setNotice({ kind: 'err', text: r.message });
        if (r.code === 'REVISION_CONFLICT' || r.code === 'WORKSPACE_REPLACED') await reload();
        return false;
      }
      await reload(); setNotice({ kind: 'ok', text: '已保存到本机' }); return true;
    } finally { lock.current = false; setBusy(false); }
  }

  async function draw() {
    if (!snap) return;
    const r = await client.suggest({ token: snap.token, categoryId: categoryId || undefined, minimum });
    if (!r.ok) setNotice({ kind: 'err', text: r.message });
    else { setOffer(r.value.definition); setNotice(null); }
  }
  async function accept() {
    if (!offer || busy) return;
    if (await run('AcceptOffer', { definition: { id: offer.id, version: offer.version }, targetDate: null })) {
      setOffer(undefined); setView('hand');
    }
  }
  function move(index: number, delta: number) {
    const ids = [...handOrder];
    const [id] = ids.splice(index, 1);
    ids.splice(index + delta, 0, id);
    void run('ReorderHand', { instanceIds: ids });
  }
  function withdraw(i: Instance) {
    void run('WithdrawInstance', { instance: { id: i.id, version: i.version } });
  }
  function returnToHand(i: Instance) {
    void run('ReturnWithdrawnToHand', { instance: { id: i.id, version: i.version } });
  }

  return (
    <div className="action-shell">
      <div className="action-workbar">
        <div>
          <h1>抽卡与手牌</h1>
          <p className="sub">抽取只给建议，不占时间、不生成事实；接受后行动进入手牌，由你安排。</p>
        </div>
        <div className="action-viewtabs" role="tablist" aria-label="抽卡手牌视图">
          <button type="button" role="tab" aria-pressed={view === 'draw'} onClick={() => setView('draw')}>抽取建议</button>
          <button type="button" role="tab" aria-pressed={view === 'hand'} onClick={() => setView('hand')}>手牌（{hand.length}）</button>
          <button type="button" role="tab" aria-pressed={view === 'day'} onClick={() => setView('day')}>当日</button>
        </div>
      </div>
      {notice ? <div className="message action-notice" role="status"><span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}>×</button></div> : null}
      {readOnly ? <div className="message action-notice"><span>旧工作区只读：请先升级后再抽取或管理手牌。</span></div> : null}

      {view === 'draw' && data ? (
        <section className="panel draw-stage">
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
        </section>
      ) : null}

      {view === 'hand' && data ? (
        <div className="hand-groups">
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
        </div>
      ) : null}
      {view === 'day' ? <DayBoard client={client} onChanged={() => void reload()} /> : null}
    </div>
  );
}
