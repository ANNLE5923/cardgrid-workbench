import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActualDraft, ActualPreview, CardView, Command, EntityRef, FactView, Id, LocalInput, PlacementPreview, PlacementSubject, Range, Token, VersionRef } from '../action-contract.ts';
import type { WorkspaceClient } from '../workspace-client.ts';
import { displayInstant, localMinuteIsFuture, nextDate } from '../action-time.ts';
import { usePlacementSession } from './time-dial/use-placement-session.ts';
import { useFlowFocus } from './use-flow-focus.ts';

const pad = (n: number) => String(n).padStart(2, '0');
function toTime(m: number) { return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
function fromTime(v: string) { const [h, m] = v.split(':').map(Number); return h * 60 + m; }
function fmt(range: Range, zone: string) { return `${displayInstant(range.startAt, zone).time}—${displayInstant(range.endAt, zone).time}`; }
async function freshToken(client: WorkspaceClient): Promise<Token | string> {
  const load = await client.load();
  return load.ok ? load.value.token : load.message;
}

/* 1. 排期与重叠确认：按钮入口复用与拖拽相同的会话控制器。 */
export function PlacementDialog(props: Readonly<{
  client: WorkspaceClient; subject: PlacementSubject; date: string; zone: string;
  initialFocusMinuteOfDay: number;
  onCommitted?: (outcome: { token: Token; resultRefs: readonly EntityRef[]; replayed: boolean }) => void;
  onClose: () => void;
}>) {
  const { client, subject, zone, onCommitted, onClose } = props;
  const rawMinute = Math.max(0, Math.min(1440, Math.round(props.initialFocusMinuteOfDay / 5) * 5));
  const date = rawMinute === 1440 ? nextDate(props.date) : props.date;
  const [focus, setFocus] = useState(rawMinute === 1440 ? 0 : rawMinute);
  const session = usePlacementSession(client);
  const { preview, chosen, busy, error } = session.state;
  const [ackFor, setAckFor] = useState<Id | null>(null);
  const close = () => { session.release(); onClose(); };
  const focusRef = useFlowFocus(() => { if (session.state.status !== 'committing') close(); });
  useEffect(() => {
    void session.start({ subject, date, zone, focusMinute: rawMinute === 1440 ? 0 : rawMinute });
    return () => session.release();
  }, []);
  useEffect(() => { setAckFor(null); }, [preview?.previewId, chosen]);
  async function commit() {
    const outcome = await session.commit(ackFor === chosen);
    if (outcome) onCommitted?.(outcome);
  }
  return (
    <div ref={focusRef} tabIndex={-1} className="flow-overlay" role="dialog" aria-modal="true" aria-label="排期与重叠确认">
      <div className="panel flow-dialog">
        <div className="flow-head"><h2>排到 {date}</h2><button type="button" aria-label="关闭" disabled={session.state.status === 'committing'} onClick={close}>×</button></div>
        <label className="flow-time">落点时间
          <input type="time" step="300" disabled={session.state.status === 'committing'} value={toTime(focus)} onChange={e => {
            const m = Math.max(0, Math.min(1435, Math.round(fromTime(e.target.value) / 5) * 5));
            setFocus(m); setAckFor(null); void session.moveTo(date, m);
          }} />
        </label>
        {error ? <div className="message" role="alert">{error}</div> : null}
        {busy ? <p role="status">正在检查落点：{date}T{toTime(focus)}…</p> : null}
        {session.state.unresolved.length ? <div className="message">{session.state.unresolved.join('；')}</div> : null}
        <div className="flow-candidates">
          {preview?.candidates.map(c => (
            <div key={c.id} className={`flow-candidate ${chosen === c.id ? 'chosen' : ''} ${c.state}`}>
              <label className="flow-pick">
                <input type="radio" disabled={busy} name="candidate" checked={chosen === c.id} onChange={() => session.selectCandidate(c.id)} />
                <span><strong>{c.label}</strong><small>{c.offsetLabel} · {c.units} 格</small></span>
              </label>
              {c.state === 'conflict' ? <>
                <ul className="flow-blockers">{c.blockers.map(b => <li key={JSON.stringify([b.kind, b.id])}>与 {b.title} 重叠 {fmt(b.overlap, zone)}</li>)}</ul>
                <p className="flow-reason">{c.reason}</p>
                <label className="flow-ack"><input type="checkbox" disabled={busy} checked={ackFor === c.id} onChange={e => setAckFor(e.target.checked ? c.id : null)} />我知道有重叠，仍要安排在这个时间</label>
              </> : <p className="flow-ok">这个时间没有冲突。</p>}
            </div>
          ))}
          {preview && !preview.candidates.length ? <p className="flow-reason">没有可用落点，请换一个时间。</p> : null}
        </div>
        <div className="toolbar flow-actions">
          <button type="button" className="primary" disabled={busy || !chosen} onClick={() => void commit()}>确认排期</button>
          <button type="button" disabled={session.state.status === 'committing'} onClick={close}>取消</button>
        </div>
      </div>
    </div>
  );
}

/* 1b. 查看手牌（焦点约束/Escape/返回触发点，F13） */
export function ViewCardDialog(props: Readonly<{
  card: CardView;
  onPlace: (card: CardView) => void;
  onClose: () => void;
}>) {
  const { card, onPlace, onClose } = props;
  const focusRef = useFlowFocus(onClose);
  return (
    <div className="flow-overlay" ref={focusRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="查看手牌">
      <div className="panel flow-dialog">
        <div className="flow-head">
          <h2>{card.title}</h2>
          <button type="button" aria-label="关闭" onClick={onClose}>×</button>
        </div>
        <p>{card.presetMinutes === null ? '无时长' : card.presetMinutes + ' 分钟'} · {card.targetDate || '无目标日期'}</p>
        <p>{card.criteria || '未填写完成标准。'}</p>
        <div className="toolbar flow-actions">
          <button type="button" className="primary" onClick={() => onPlace(card)}>打出</button>
          <button type="button" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/* 2a. 固定块一次性解锁 */
export function FixedUnlockButton(props: Readonly<{
  client: WorkspaceClient; commitment: VersionRef; onUnlocked: (unlockId: Id) => void;
  disabled?: boolean; label?: string;
}>) {
  const { client, commitment, onUnlocked, disabled, label } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function click() {
    setBusy(true); setError(null);
    const token = await freshToken(client);
    if (typeof token === 'string') { setError(token); setBusy(false); return; }
    const r = await client.unlockFixed({ token, commitmentId: commitment.id, version: commitment.version });
    setBusy(false);
    if (!r.ok) { setError(r.message); return; }
    onUnlocked(r.value);
  }
  return (
    <span className="flow-unlock">
      {error ? <span className="inline-err" role="alert">{error}</span> : null}
      <button type="button" className="act-mini" disabled={disabled || busy} onClick={() => void click()}>{label ?? '解锁并调整'}</button>
    </span>
  );
}

/* 3. 实际确认 */
export function ActualConfirmDialog(props: Readonly<{
  client: WorkspaceClient; zone: string; instanceId: Id; instanceVersion: number;
  planned?: Readonly<{ planId: Id; planVersion: number }>;
  initialStart: Readonly<{ date: string; time: string }>;
  initialEnd: Readonly<{ date: string; time: string }>;
  onConfirmed?: () => void; onClose: () => void;
}>) {
  const { client, zone, instanceId, instanceVersion, planned, initialStart, initialEnd, onConfirmed, onClose } = props;
  const [startDate, setStartDate] = useState(initialStart.date);
  const [startTime, setStartTime] = useState(initialStart.time);
  const [endDate, setEndDate] = useState(initialEnd.date);
  const [endTime, setEndTime] = useState(initialEnd.time);
  const [preview, setPreview] = useState<ActualPreview | null>(null);
  const [stale, setStale] = useState(true);
  // Permission is bound to a specific preview, not to the dialog: the checkbox is
  // only valid for the preview whose conflicts the user actually reviewed.
  const [ackFor, setAckFor] = useState<Id | null>(null);
  // DST fall-back repeats wall-clock minutes; each endpoint is disambiguated by
  // an explicit offset chosen by the user (1F §4, C36).
  const [startOffset, setStartOffset] = useState<string | null>(null);
  const [endOffset, setEndOffset] = useState<string | null>(null);
  const [startOffsetOptions, setStartOffsetOptions] = useState<readonly string[]>([]);
  const [endOffsetOptions, setEndOffsetOptions] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previewIdRef = useRef<Id | null>(null);
  const mounted = useRef(true);

  const focusRef = useFlowFocus(() => { if (!busy) close(); });

  function buildDraft(): ActualDraft {
    const start = { date: startDate, time: startTime, zone, ...(startOffset ? { offset: startOffset } : {}) };
    const end = { date: endDate, time: endTime, zone, ...(endOffset ? { offset: endOffset } : {}) };
    return planned
      ? { instanceId, instanceVersion, mode: 'planned', planId: planned.planId, planVersion: planned.planVersion, start, end }
      : { instanceId, instanceVersion, mode: 'unplanned', start, end };
  }
  const runPreview = useCallback(async (): Promise<ActualPreview | null> => {
    setBusy(true); setError(null);
    const token = await freshToken(client);
    if (typeof token === 'string') { setError(token); setBusy(false); return null; }
    // Resolve DST ambiguity for each endpoint before creating the preview.
    // resolveLocal returns the concrete offset choices for a repeated minute.
    const probes: Readonly<{
      key: 'start' | 'end'; input: LocalInput;
      chosen: string | null; setOptions: (v: readonly string[]) => void;
    }>[] = [
      { key: 'start', input: { date: startDate, time: startTime, zone, ...(startOffset ? { offset: startOffset } : {}) }, chosen: startOffset, setOptions: setStartOffsetOptions },
      { key: 'end', input: { date: endDate, time: endTime, zone, ...(endOffset ? { offset: endOffset } : {}) }, chosen: endOffset, setOptions: setEndOffsetOptions },
    ];
    let ambiguous = false;
    for (const probe of probes) {
      const resolved = await client.resolveLocal(probe.input);
      if (!mounted.current) return null;
      if (!resolved.ok) {
        if (resolved.choices?.length) { probe.setOptions(resolved.choices.map(c => c.input.offset).filter((o): o is string => !!o)); ambiguous = true; }
        else { setError(resolved.message); setBusy(false); return null; }
      } else {
        probe.setOptions([]);
      }
    }
    if (ambiguous) { setError('该时间在夏令时切换时重复，请分别选择开始和结束的时区偏移。'); setBusy(false); return null; }
    const r = await client.previewActual({ token, draft: buildDraft() });
    if (!mounted.current) { if (r.ok) client.cancelPreview(r.value.previewId); return null; }
    if (!r.ok) { setError(r.message); setBusy(false); return null; }
    if (previewIdRef.current) client.cancelPreview(previewIdRef.current);
    previewIdRef.current = r.value.previewId;
    setPreview(r.value); setStale(false); setAckFor(null); setBusy(false);
    return r.value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, zone, instanceId, instanceVersion, planned, startDate, startTime, endDate, endTime, startOffset, endOffset]);

  useEffect(() => {
    mounted.current = true;
    void runPreview();
    return () => { mounted.current = false; if (previewIdRef.current) client.cancelPreview(previewIdRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => client.subscribe(external => {
    if (!external) return;
    if (previewIdRef.current) client.cancelPreview(previewIdRef.current);
    previewIdRef.current = null; setPreview(null); setStale(true); setAckFor(null);
    setError('另一窗口已保存，请重新预览本次实际区间。');
  }), [client]);

  function markStale() {
    setStale(true); setAckFor(null);
    setStartOffset(null); setEndOffset(null);
    setStartOffsetOptions([]); setEndOffsetOptions([]);
  }

  async function confirm() {
    if (busy) return;
    setError(null);
    let latest = preview;
    let justRefreshed = false;
    if (stale || !latest) { latest = await runPreview(); justRefreshed = true; }
    if (!latest) return;
    if (latest.conflicts.length) {
      // After a same-click re-preview the user could not have acknowledged THIS
      // preview yet; otherwise require a checkbox bound to this preview id.
      const permitted = !justRefreshed && ackFor === latest.previewId;
      if (!permitted) { setError('请先勾选确认本次重叠'); return; }
    }
    setBusy(true);
    const cmd = { commandId: crypto.randomUUID(), expected: latest.token, type: 'ConfirmActual', payload: { previewId: latest.previewId, acknowledgedOverlap: latest.conflicts.length ? latest.acknowledgementId : null } } as Command;
    const r = await client.submit(cmd);
    if (!r.ok) {
      setError(r.message); setBusy(false);
      if (['REVISION_CONFLICT', 'WORKSPACE_REPLACED', 'PREVIEW_STALE', 'OVERLAP_CONFIRMATION_REQUIRED'].includes(r.code)) { previewIdRef.current = null; void runPreview(); }
      return;
    }
    previewIdRef.current = null; setBusy(false); onConfirmed?.();
  }
  function close() { if (previewIdRef.current) client.cancelPreview(previewIdRef.current); previewIdRef.current = null; onClose(); }

  return (
    <div ref={focusRef} tabIndex={-1} className="flow-overlay" role="dialog" aria-modal="true" aria-label="确认实际发生">
      <div className="panel flow-dialog">
        <div className="flow-head"><h2>确认实际发生</h2><button type="button" aria-label="关闭" disabled={busy} onClick={close}>×</button></div>
        {preview ? <p className="flow-title">{preview.title}{preview.plannedRange ? <> · 原计划 {fmt(preview.plannedRange, zone)}</> : null}</p> : null}
        <div className="flow-actualgrid">
          <label>开始日期<input type="date" disabled={busy} value={startDate} onChange={e => { setStartDate(e.target.value); markStale(); }} /></label>
          <label>开始时间<input type="time" step="300" disabled={busy} value={startTime} onChange={e => { setStartTime(e.target.value); markStale(); }} /></label>
          <label>结束日期<input type="date" disabled={busy} value={endDate} onChange={e => { setEndDate(e.target.value); markStale(); }} /></label>
          <label>结束时间<input type="time" step="300" disabled={busy} value={endTime} onChange={e => { setEndTime(e.target.value); markStale(); }} /></label>
        </div>
        {startOffsetOptions.length > 1 || endOffsetOptions.length > 1 ? (
          <div className="flow-offsetgrid">
            {startOffsetOptions.length > 1 ? (
              <label>开始时区偏移<select disabled={busy} aria-label="开始时区偏移" value={startOffset ?? ''} onChange={e => { setStartOffset(e.target.value || null); setStale(true); }}>
                <option value="">请选择</option>
                {startOffsetOptions.map(o => <option key={o} value={o}>{o}</option>)}
              </select></label>
            ) : null}
            {endOffsetOptions.length > 1 ? (
              <label>结束时区偏移<select disabled={busy} aria-label="结束时区偏移" value={endOffset ?? ''} onChange={e => { setEndOffset(e.target.value || null); setStale(true); }}>
                <option value="">请选择</option>
                {endOffsetOptions.map(o => <option key={o} value={o}>{o}</option>)}
              </select></label>
            ) : null}
          </div>
        ) : null}
        {stale ? <p className="flow-reason" role="status">时间已修改，提交时会按上面的区间重新预览。</p> : null}
        {localMinuteIsFuture({ date: endDate, time: endTime, zone, ...(endOffset ? { offset: endOffset } : {}) }, new Date().toISOString())
          ? <p className="flow-future" role="status">结束时间尚未到达；确认后将锁定为事实，不能再修改。</p> : null}
        {preview ? <p className="flow-actualrange">实际区间 {fmt(preview.range, zone)}</p> : null}
        {preview?.conflicts.length ? (
          <>
            <ul className="flow-blockers">{preview.conflicts.map(b => <li key={b.id}>与 {b.title} 重叠 {fmt(b.overlap, zone)}</li>)}</ul>
            <label className="flow-ack"><input type="checkbox" disabled={busy} checked={ackFor === preview.previewId} onChange={e => setAckFor(e.target.checked ? preview.previewId : null)} />我知道有重叠，仍按这个实际区间确认</label>
          </>
        ) : null}
        {error ? <div className="message" role="alert">{error}</div> : null}
        <div className="toolbar flow-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void confirm()}>确认实际</button>
          <button type="button" disabled={busy} onClick={close}>取消</button>
        </div>
      </div>
    </div>
  );
}

/* 4. 只读事实与批注 */
export function FactThread(props: Readonly<{
  client: WorkspaceClient; facts: readonly FactView[]; zone: string; onChanged: () => void;
}>) {
  const { client, facts, zone, onChanged } = props;
  const [texts, setTexts] = useState<Record<Id, string>>({});
  const pending = useRef(new Set<Id>());
  const [busyIds, setBusyIds] = useState<ReadonlySet<Id>>(new Set());
  const [errors, setErrors] = useState<Record<Id, string>>({});

  async function add(fact: FactView) {
    const submittedText = texts[fact.factId] ?? '', text = submittedText.trim();
    if (!text || pending.current.has(fact.factId)) return;
    pending.current.add(fact.factId); setBusyIds(new Set(pending.current));
    setErrors(current => ({ ...current, [fact.factId]: '' }));
    try {
      const token = await freshToken(client);
      if (typeof token === 'string') { setErrors(current => ({ ...current, [fact.factId]: token })); return; }
      const cmd = { commandId: crypto.randomUUID(), expected: token, type: 'AppendAnnotation', payload: { factId: fact.factId, text } } as Command;
      const r = await client.submit(cmd);
      if (!r.ok) { setErrors(current => ({ ...current, [fact.factId]: r.message })); return; }
      setTexts(current => current[fact.factId] === submittedText ? { ...current, [fact.factId]: '' } : current);
      onChanged();
    } finally {
      pending.current.delete(fact.factId); setBusyIds(new Set(pending.current));
    }
  }

  if (!facts.length) return <p className="emptyline">还没有已锁定的事实。确认行动实际发生后，会出现在这里。</p>;
  return (
    <div className="fact-thread">
      {facts.map(f => (
        <article key={f.factId} className="fact-item">
          <div className="fact-head">
            <span className="fact-lock">已锁定</span>
            <strong>{f.title}</strong>
            <span className="fact-range">{fmt(f.actualRange, zone)}</span>
          </div>
          {f.plannedRange ? <small className="fact-planned">原计划 {fmt(f.plannedRange, zone)}</small> : null}
          {f.annotations.length ? (
            <ul className="fact-annotations">{f.annotations.map(a => <li key={a.id}>{a.text}</li>)}</ul>
          ) : null}
          {errors[f.factId] ? <div className="message" role="alert">{errors[f.factId]}</div> : null}
          <div className="fact-add">
            <input aria-label={`为 ${f.title} 添加批注`} disabled={busyIds.has(f.factId)} value={texts[f.factId] ?? ''} placeholder="补充纠错说明（只追加，不改事实）"
              onChange={e => { const value = e.target.value; setTexts(current => ({ ...current, [f.factId]: value })); }} />
            <button type="button" disabled={busyIds.has(f.factId)} onClick={() => void add(f)}>添加批注</button>
          </div>
        </article>
      ))}
    </div>
  );
}
