import {DrawPanel, ProductionDrawPanel} from '../drawing/index.ts';
import type {WorkspaceDrawSession} from '../drawing/model.ts';
import {HandPanel, ArchivePanel} from '../daily/index.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, Definition, Id, Instance, SubmitResult } from '../workspace/index.ts';
import type { WorkspaceClient } from '../workspace/index.ts';
import type { WorkspaceSnapshot } from '../workspace/index.ts';
import {isV3Capable} from '../workspace/contracts-v4.ts';
import '../shared/ui/action.css';

type View = 'draw' | 'hand' | 'archive';
type Notice = { kind: 'ok' | 'err'; text: string };
type Offer = Definition | null | undefined; // undefined = not drawn yet, null = no eligible definition

export function ActionHand({ client, drawing, onData, onToday }: { client: WorkspaceClient; drawing: WorkspaceDrawSession; onData: () => void; onToday: () => void }) {
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
  const archived = new Set(isV3Capable(data) ? data.archiveLogs.flatMap(log => log.acceptedInstanceIds) : []);
  const withdrawn = instances.filter(i => i.state === 'withdrawn' && !archived.has(i.id));

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
        <div className="action-viewnav">
          <div className="action-viewtabs" role="tablist" aria-label="抽卡手牌视图">
            <button type="button" role="tab" aria-pressed={view === 'draw'} onClick={() => setView('draw')}>抽取建议</button>
            <button type="button" role="tab" aria-pressed={view === 'hand'} onClick={() => setView('hand')}>手牌（{hand.length}）</button>
            <button type="button" role="tab" aria-pressed={view === 'archive'} onClick={() => setView('archive')}>归档日志</button>
          </div>
          <button type="button" onClick={onToday}>当日</button>
        </div>
      </div>
      {notice ? <div className="message action-notice" role="status"><span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}>×</button></div> : null}
      {readOnly ? <div className="message action-notice"><span>旧工作区只读：请先升级后再抽取或管理手牌。</span></div> : null}

      {view === 'draw' && <ProductionDrawPanel drawing={drawing} onData={onData} onHand={() => setView('hand')} onToday={onToday}/>}
      {view === 'draw' && data && data.planner.definitions.length > 0 ? <details><summary>已有行动定义抽取</summary><DrawPanel {...{categories,categoryId,minimum,offer,busy,readOnly,setCategoryId,setMinimum,setOffer,draw,accept}}/></details> : null}
      {view === 'hand' && data ? <HandPanel {...{hand,withdrawn,data,busy,readOnly,move,withdraw,returnToHand}}/> : null}
      {view === 'archive' && data ? <ArchivePanel data={data}/> : null}
    </div>
  );
}
