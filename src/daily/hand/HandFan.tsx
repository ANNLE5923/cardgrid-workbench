import { useEffect, useRef, useState } from 'react';
import type { CardView, PlacementSubject } from '../../workspace/index.ts';
import { fanLayout, clientPointToLogical, advanceHandEntry, emptyHandEntry, isReclaim } from '../schedule/time-dial/interaction.ts';
import { useFlowFocus } from '../../shared/ui/index.ts';
import { geometry } from '../schedule/time-dial/geometry.ts';
import type { HandEntryState } from '../schedule/time-dial/interaction.ts';
import type { HitAnchor, LogicalPoint } from '../schedule/time-dial/types.ts';
import type { PlacementSession } from '../schedule/time-dial/use-placement-session.ts';
import { HandFanCard } from './HandFanCard.tsx';
import './hand.css';

const CENTER = 200;
const radiusOf = (p: LogicalPoint) => Math.hypot(p.x - CENTER, p.y - CENTER);

export function HandFan(props: Readonly<{
  hand: readonly CardView[];
  handMeta?: Readonly<Record<string,{key: string; sourceDate: string}>>;
  date: string;
  zone: string;
  session: PlacementSession;
  getFocus: () => number;
  getDialRect: () => DOMRect | null;
  onView: (card: CardView) => void;
  onPlace: (card: CardView) => void;
  onRecordActual: (card: CardView) => void;
  onCommitted: () => void | Promise<void>;
  onInteractionStart: () => void;
  onGestureStart?: () => void;
  onCancel: () => void;
}>) {
  const { hand, date, zone, session, onCommitted } = props;

  // Wide screens show at most PAGE cards with paging/expand; on narrow screens all cards
  // wrap and stay operable (F14; C05 requires every card visible at 320px, no overflow).
  const PAGE = 4;
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [openStacks, setOpenStacks] = useState<Readonly<Record<string,boolean>>>({});
  const grouped = new Map<string, CardView[]>();
  for (const card of hand) {const key = props.handMeta?.[card.instanceId]?.key ?? card.instanceId; grouped.set(key,[...(grouped.get(key) ?? []),card]);}
  const displayHand: CardView[] = [], counts = new Map<string,number>(), collapseKeys = new Map<string,string>();
  for (const [key,members] of grouped) {
    if (members.length > 1 && !openStacks[key]) {
      const representative = members.find(c => props.handMeta?.[c.instanceId]?.sourceDate === date) ?? members[0];
      displayHand.push(representative); counts.set(representative.instanceId,members.length);
    } else {displayHand.push(...members); if (members.length > 1) collapseKeys.set(members[0].instanceId,key);}
  }
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 560px)');
    const upd = () => setNarrow(mq.matches);
    upd();
    mq.addEventListener('change', upd);
    return () => mq.removeEventListener('change', upd);
  }, []);
  const showAll = expanded || narrow;
  const pageCount = Math.max(1, Math.ceil(displayHand.length / PAGE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = showAll ? displayHand : displayHand.slice(safePage * PAGE, safePage * PAGE + PAGE);
  const angles = fanLayout(visible.length);

  const dragCardRef = useRef<CardView | null>(null);
  const movedRef = useRef(false);
  const anchorRef = useRef<HitAnchor | null>(null);
  const startRadiusRef = useRef(-1);
  const reclaimRef = useRef(false);
  const pointerRef = useRef<{ id: number; date: string; zone: string; focus: number;
    sx: number; sy: number; dx: number; dy: number; width: number; height: number;
    previousEdge: LogicalPoint; entry: HandEntryState } | null>(null);

  const [dragId, setDragId] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number; width: number; height: number; title: string; color: string; label: string } | null>(null);
  const [ack, setAck] = useState(false);

  const { status, preview, chosen, error } = session.state;
  const activeSubjectId = session.state.subject?.kind === 'hand'
    ? (session.state.subject as PlacementSubject & { kind: 'hand'; instanceId: string }).instanceId
    : null;

  // Switching candidate, moving or a new preview/revision all clear the overlap acknowledgement (F01).
  useEffect(() => { setAck(false); }, [chosen, preview?.previewId]);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>, card: CardView) {
    if (status === 'committing' || event.button !== 0 || (event.target as Element).closest('button')) return;
    props.onGestureStart?.();
    event.currentTarget.focus();
        const rect = event.currentTarget.getBoundingClientRect();
    const width = event.currentTarget.offsetWidth, height = event.currentTarget.offsetHeight;
    const style = getComputedStyle(event.currentTarget);
    const matrix = new DOMMatrix(style.transform === 'none' ? undefined : style.transform);
    const [ox, oy] = style.transformOrigin.split(' ').map(Number.parseFloat);
    const transform = (x: number, y: number) => new DOMPoint(x - ox, y - oy).matrixTransform(matrix);
    const corners = [transform(0, 0), transform(width, 0), transform(0, height), transform(width, height)];
    const top = transform(width / 2, 0);
    const minX = Math.min(...corners.map(p => p.x)), minY = Math.min(...corners.map(p => p.y));
    const scaleX = rect.width / (Math.max(...corners.map(p => p.x)) - minX);
    const scaleY = rect.height / (Math.max(...corners.map(p => p.y)) - minY);
    // The DOMMatrix describes this card; rect also includes ancestor scaling on narrow screens.
    const edge = { x: rect.left + (top.x - minX) * scaleX,
      y: rect.top + (top.y - minY) * scaleY };
    const dial = props.getDialRect();
    if (!dial) return;
    pointerRef.current = { id: event.pointerId, date, zone, focus: props.getFocus(),
      sx: event.clientX, sy: event.clientY, dx: edge.x - event.clientX, dy: edge.y - event.clientY,
      width: width * scaleX, height: height * scaleY, previousEdge: clientPointToLogical(edge.x, edge.y, dial), entry: emptyHandEntry() };

    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* pointer already ended */ }
    dragCardRef.current = card;
    movedRef.current = false;
    anchorRef.current = null;
    startRadiusRef.current = -1;
    reclaimRef.current = false;
    setDragId(card.instanceId);
    setGhost(null);
    event.preventDefault();
  }

  // Window-level move/up so the drag survives leaving the card element.
  useEffect(() => {
    function move(ev: PointerEvent) {
      const card = dragCardRef.current;
      const rect = props.getDialRect();
      const pointer = pointerRef.current;
      if (!card || !rect || !pointer || ev.pointerId !== pointer.id) return;
            const edgeX = ev.clientX + pointer.dx, edgeY = ev.clientY + pointer.dy;
      const logical = clientPointToLogical(edgeX, edgeY, rect);
      const radius = radiusOf(logical);
      if (!movedRef.current && Math.hypot(ev.clientX - pointer.sx, ev.clientY - pointer.sy) < 5) return;
      const advanced = advanceHandEntry(pointer.previousEdge, logical, pointer.focus, pointer.entry);
      pointer.previousEdge = logical; pointer.entry = advanced.state;
      setGhost({ x: edgeX - pointer.width / 2, y: edgeY, width: pointer.width, height: pointer.height,
        title: card.title, color: card.color, label: '拖到表盘放置' });
      if (pointer.entry.entered && startRadiusRef.current < 0) startRadiusRef.current = pointer.entry.entryRadius;
      if (startRadiusRef.current >= 0 && isReclaim(startRadiusRef.current, radius)) {
        reclaimRef.current = true;
        setGhost(g => g ? { ...g, label: '松手收回手牌' } : g);
        return;
      }
      const hit = advanced.hit;

      if (hit) {
        movedRef.current = true;
        anchorRef.current = { half: hit.half, minuteOfHalf: hit.minuteOfHalf };
        if (startRadiusRef.current < 0) startRadiusRef.current = pointer.entry.entryRadius;
        reclaimRef.current = false;
        const landing = geometry.landing(hit, pointer.date); // 24:00 -> next date 00:00 (D023)
        const sameCard = activeSubjectId === card.instanceId;
        if ((status === 'preview' || status === 'preparing') && sameCard) {
          void session.moveTo(landing.date, landing.minuteOfDay);
        } else if (status !== 'preparing' && status !== 'committing') {
          props.onInteractionStart();
          const subject: PlacementSubject = {
            kind: 'hand',
            instanceId: card.instanceId,
            version: card.version,
          };
          void session.start({ subject, date: landing.date, zone: pointer.zone, focusMinute: landing.minuteOfDay });
        }
      } else if (startRadiusRef.current >= 0) {
        const reclaim = isReclaim(startRadiusRef.current, radius);
        reclaimRef.current = reclaim;
        setGhost(g => g ? { ...g, label: reclaim ? '松手收回手牌' : '拖到表盘放置' } : g);
      }
    }
    function up(ev: PointerEvent) {
      if (pointerRef.current && ev.pointerId !== pointerRef.current.id) return;
      pointerRef.current = null;
      const card = dragCardRef.current;
      dragCardRef.current = null;
      setDragId(null);
      setGhost(null);
      if (!card || !movedRef.current) return; // a click is handled by the card itself
      if (reclaimRef.current) {
        props.onCancel();
      } else if ((session.state.status === 'preview' || session.state.status === 'preparing') && activeSubjectId === card.instanceId) {
        // Keep the candidate adjustment open; nothing is scheduled until confirm.
      } else {
        props.onCancel();
      }
      anchorRef.current = null;
      startRadiusRef.current = -1;
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    const cancel = (ev: PointerEvent) => {
      if (!pointerRef.current || ev.pointerId !== pointerRef.current.id) return;
      pointerRef.current = null; dragCardRef.current = null; setDragId(null); setGhost(null); props.onCancel();
    };
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('lostpointercapture', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('lostpointercapture', cancel);
    };
  });

  const chosenCandidate = preview?.candidates.find(c => c.id === chosen) ?? null;
  const needsAck = !!chosenCandidate && chosenCandidate.state !== 'valid';
  const showAdjust = ['preparing', 'preview', 'committing'].includes(status) && !!session.state.subject;

  async function confirm() {
    const ok = await session.commit(ack);
    if (ok) {
      setAck(false);
      await onCommitted();
    }
  }

  return (
    <div className="hand-fan">
      <div className={`hand-fan-stage${showAll ? ' expanded' : ''}`}>
        {hand.length ? (
          visible.map((card, index) => (
            <HandFanCard
              key={card.instanceId}
              card={card}
              index={(showAll ? 0 : safePage * PAGE) + index}
              angle={angles[index] ?? 0}
              selected={dragId === card.instanceId}
              dragging={dragId === card.instanceId}
              previewing={activeSubjectId === card.instanceId && status === 'preview'}
              stackCount={counts.get(card.instanceId)}
              sourceDate={props.handMeta?.[card.instanceId]?.sourceDate}
              onExpand={() => {const key = props.handMeta?.[card.instanceId]?.key; if (key) setOpenStacks(s => ({...s,[key]:true}));}}
              onCollapse={collapseKeys.has(card.instanceId) ? () => {const key = collapseKeys.get(card.instanceId)!; if (activeSubjectId && grouped.get(key)?.some(c => c.instanceId === activeSubjectId)) props.onCancel(); setOpenStacks(s => ({...s,[key]:false}));} : undefined}
              onPointerDown={counts.has(card.instanceId) ? undefined : onPointerDown}
              onView={card => { if (!movedRef.current) {const key = props.handMeta?.[card.instanceId]?.key; if (key && counts.has(card.instanceId)) setOpenStacks(s => ({...s,[key]:true})); else props.onView(card);} }}
              onPlace={props.onPlace}
              onRecordActual={props.onRecordActual}
              disabled={status === 'committing'}
            />
          ))
        ) : (
          <p className="empty-hint">手牌为空。去“收件箱”把待办加入手牌。</p>
        )}
      </div>

      {displayHand.length > PAGE && !narrow ? (
        <div className="hand-pager">
          {!expanded ? (
            <>
              <button type="button" disabled={safePage === 0}
                onClick={() => setPage(safePage - 1)} aria-label="上一页">‹</button>
              <span>第 {safePage + 1} / {pageCount} 页 · 共 {hand.length} 张</span>
              <button type="button" disabled={safePage >= pageCount - 1}
                onClick={() => setPage(safePage + 1)} aria-label="下一页">›</button>
            </>
          ) : <span>共 {hand.length} 张</span>}
          <button type="button" onClick={() => setExpanded(!expanded)}>
            {expanded ? '收起' : '展开全部'}
          </button>
        </div>
      ) : null}

      {ghost ? (
        <div className="drag-card-ghost" aria-hidden="true" style={{ left: ghost.x, top: ghost.y, width: ghost.width, height: ghost.height, borderTopColor: ghost.color }}>
          <span data-card-top-edge="true" /><strong>{ghost.title}</strong><small>{ghost.label}</small>
        </div>
      ) : null}

      {error ? (
        <div className="message">
          <span>{error}</span>
          <button type="button" onClick={props.onCancel}>知道了</button>
        </div>
      ) : null}

      {showAdjust ? (
        <CandidateAdjust onCancel={() => { if (status !== 'committing') props.onCancel(); }}>
          <h3>选择落点</h3>
          {session.state.busy ? <p role="status">正在检查落点…</p> : null}
          {session.state.unresolved.length ? (
            <div className="message">{session.state.unresolved.join('；')}</div>
          ) : null}
          <div className="adjust-candidates">
            {preview?.candidates.map(c => (
              <button
                type="button"
                key={c.id}
                className={`adjust-candidate${chosen === c.id ? ' chosen' : ''}`}
                disabled={session.state.busy}
                onClick={() => session.selectCandidate(c.id)}
              >
                <input type="radio" tabIndex={-1} checked={chosen === c.id} readOnly />
                <span>
                  {c.label}
                  <small>{c.offsetLabel} · {c.state}</small>
                  {'blockers' in c && c.blockers?.length ? (
                    <small className="candidate-blockers">{c.reason}；冲突：{c.blockers.map(b => b.title + '（' + b.overlap.startAt + '—' + b.overlap.endAt + '）').join('、')}</small>
                  ) : null}
                </span>
              </button>
            ))}
            {preview && !preview.candidates.length ? (
              <p className="flow-reason">没有可用落点，请换一个时间。</p>
            ) : null}
          </div>

          {needsAck ? (
            <label className="overlap-ack">
              <input type="checkbox" disabled={session.state.busy} checked={ack} onChange={e => setAck(e.target.checked)} />
              我知道当前选择有重叠/冲突，仍按这个落点排期
            </label>
          ) : null}

          <div className="adjust-actions">
            <button type="button" disabled={status === 'committing'} onClick={() => { props.onCancel(); setAck(false); }}>取消</button>
            <button
              type="button"
              className="primary"
              disabled={session.state.busy || !chosenCandidate || (needsAck && !ack)}
              onClick={() => void confirm()}
            >
              确认排期
            </button>
          </div>
        </CandidateAdjust>
      ) : null}
    </div>
  );
}
function CandidateAdjust(props: Readonly<{ onCancel: () => void; children: React.ReactNode }>) {
  const focusRef = useFlowFocus(props.onCancel);
  return <div ref={focusRef} tabIndex={-1} className="candidate-adjust" role="dialog" aria-label="调整落点并确认">{props.children}</div>;
}
