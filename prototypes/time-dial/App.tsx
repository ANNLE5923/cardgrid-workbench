import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type TouchEvent, type WheelEvent } from 'react';
import type { ActualDraft, ActualPreview, Candidate, CardView, DayView, Failure, PlacementPreview, PlacementSubject, Segment, SubmitResult } from '../../docs/产品设计/1C-prototype-contract.ts';
import { createPrototype } from './host.ts';
import { scenarioNames, type ScenarioId } from './fixtures.ts';
import { addDate, at, dayRange, labelAt, localParts, oneLocal, offsetLabel, resolveLocal } from './time.ts';
import { HandCard } from './HandCard.tsx';
import { dialRadiusAt, pulledBeyondDial, stagedCardPreview } from './card-placement.ts';

type Selected = { kind: 'card' | 'segment'; id: string } | null;
type Choice = { half: 0 | 1; offset: string } | null;
const scenarioIds = Object.keys(scenarioNames) as ScenarioId[];
const kindLabels: Record<Segment['kind'], string> = { fixed: '固定', plan: '计划', fact: '实际', 'plan-reference': '原计划对照', empty: '空时间' };
const formatDateTime = (instant: string, zone: string) => `${labelAt(instant, zone, true).replace(' ', 'T')}`;
const nextId = () => crypto.randomUUID();

function polar(radius: number, degrees: number): [number, number] {
  const rad = degrees * Math.PI / 180;
  return [200 + radius * Math.sin(rad), 200 - radius * Math.cos(rad)];
}
function arc(radius: number, startMinute: number, endMinute: number): string {
  const start = startMinute / 720 * 360, end = endMinute / 720 * 360;
  if (end - start >= 359.999) {
    const a = polar(radius, start), b = polar(radius, start + 180);
    return `M${a.join(' ')} A${radius} ${radius} 0 1 1 ${b.join(' ')} A${radius} ${radius} 0 1 1 ${a.join(' ')}`;
  }
  const a = polar(radius, start), b = polar(radius, end);
  return `M${a.join(' ')} A${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${b.join(' ')}`;
}
function radiusFor(half: 0 | 1, swapped: boolean): number { return (swapped ? half === 0 : half === 1) ? 132 : 94; }
const clampDay = (minute: number) => Math.max(0, Math.min(1440, minute));
const snapDay = (minute: number) => Math.max(0, Math.min(1435, Math.round(minute / 5) * 5));
const clockLabel = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const minuteOfDay = (instant: string, zone: string) => { const p = localParts(instant, zone); return p.hour * 60 + p.minute; };

function Dial({ view, preview, chosen, focus, swapped, selected, editingSourceId, onSegment, onSegmentDoubleClick, onSegmentPointerDown, onCandidate, onCandidateDoubleClick, onCandidatePointerDown, onDialPointerDown, onFocus, onKeyDown, svgRef }: {
  view: DayView; preview: PlacementPreview | null; chosen: Choice; focus: number; swapped: boolean; selected: Selected;
  editingSourceId: string | null; onSegment: (segment: Segment) => void; onSegmentDoubleClick: (segment: Segment) => void; onCandidate: (candidate: Candidate) => void; onCandidateDoubleClick: () => void;
  onSegmentPointerDown: (event: PointerEvent<SVGPathElement>, segment: Segment) => void;
  onCandidatePointerDown: (event: PointerEvent<SVGPathElement>, candidate: Candidate) => void;
  onDialPointerDown: (event: PointerEvent<SVGSVGElement>) => void;
  onFocus: (n: number) => void; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  const [noteMinute, setNoteMinute] = useState<number | null>(null);
  const rotation = 180 - focus / 720 * 360;
  const visible = view.segments.filter(x => x.kind !== 'empty');
  const focusedIds = new Set(visible.filter(x => x.kind !== 'plan-reference' && focus >= x.half * 720 + x.startMinuteOfHalf && focus < x.half * 720 + x.endMinuteOfHalf).map(x => x.id));
  const now = minuteOfDay(view.now, view.zone);
  const empty = view.segments.filter(x => x.kind === 'empty');
  const candidates = preview?.candidates ?? [];
  const barSegments = view.segments.filter(x => x.kind === 'fixed' || x.kind === 'plan' || x.kind === 'fact');
  const noteSegments = noteMinute === null ? [] : barSegments.filter(x => noteMinute >= x.half * 720 + x.startMinuteOfHalf && noteMinute < x.half * 720 + x.endMinuteOfHalf);
  const occupied = visible.filter(x => x.kind !== 'plan-reference');
  const overlaps = occupied.flatMap((a, i) => occupied.slice(i + 1).flatMap(b => {
    if (a.half !== b.half || a.sourceId === b.sourceId) return [];
    const start = Math.max(a.startMinuteOfHalf, b.startMinuteOfHalf);
    const end = Math.min(a.endMinuteOfHalf, b.endMinuteOfHalf);
    return end > start ? [{ half: a.half, start, end, key: `${a.id}-${b.id}` }] : [];
  }));
  return <section className="dial-section" aria-label="双十二小时时间盘" onKeyDown={onKeyDown}>
    <div className="dial-caption"><span className="eyebrow">TODAY / TIME</span><span className="dial-caption-right">{empty.length > 0 && <span className="dial-empty-key"><i />红色＝空时间</span>}<span>按住表盘旋转 · 指针固定 ↓</span></span></div>
    {visible.some(seg => seg.continuesAfter) && <div className="continuation-hints">{visible.filter(seg => seg.continuesAfter).map(seg => <button type="button" key={seg.id} onClick={() => onSegment(seg)}>{seg.title} · 续次日 →</button>)}</div>}
    <div className="dial-layout"><div className="day-preview" aria-label="24 小时预览条"><span className="preview-title">24H</span><div className="preview-cells">{Array.from({ length: 24 }, (_, hour) => <div key={hour} className="preview-hour" title={`${clockLabel(hour * 60)}–${clockLabel((hour + 1) * 60)}`}>{hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}</div>)}{barSegments.map((segment, index) => <button type="button" key={segment.id} className={`preview-schedule ${segment.kind}`} style={{ top: `${(segment.half * 720 + segment.startMinuteOfHalf) / 1440 * 100}%`, height: `${Math.max(0.5, (segment.endMinuteOfHalf - segment.startMinuteOfHalf) / 1440 * 100)}%`, left: `${2 + index % 3 * 7}px` }} aria-label={`查看${segment.title}概述，${segment.label}`} title={`${segment.title} · ${segment.label}`} onClick={event => { const rect = event.currentTarget.parentElement?.getBoundingClientRect(); if (rect) setNoteMinute(Math.min(1439, Math.floor((event.clientY - rect.top) / rect.height * 1440))); }} />)}<button type="button" className="preview-pointer now" style={{ top: `${now / 1440 * 100}%` }} onClick={() => onFocus(now)} aria-label={`回到现在 ${clockLabel(now)}`}>▶<span>现在 {clockLabel(now)}</span></button><div className="preview-pointer focus" style={{ top: `${focus / 1440 * 100}%` }} aria-label={`指针 ${clockLabel(focus)}`}><span>{clockLabel(focus)}</span>◀</div></div>{noteMinute !== null && <div className="preview-note" role="dialog" aria-label={`${clockLabel(noteMinute)} 日程概述`} style={{ top: `${Math.min(68, noteMinute / 1440 * 100)}%` }}><div className="preview-note-heading"><strong>{clockLabel(noteMinute)} · 日程概述</strong><button type="button" onClick={() => setNoteMinute(null)} aria-label="关闭日程概述">×</button></div>{noteSegments.length ? noteSegments.map(segment => <div key={segment.id} className="preview-note-item"><span className={`time-kind ${segment.kind}`}>{kindLabels[segment.kind]}</span><strong>{segment.title}</strong><small>{labelAt(segment.sourceRange.startAt, view.zone, true)}—{labelAt(segment.sourceRange.endAt, view.zone, true)} · {Math.round((Date.parse(segment.sourceRange.endAt) - Date.parse(segment.sourceRange.startAt)) / 60000)} 分钟</small><p>{view.facts.find(x => x.factId === segment.sourceId)?.criteria ?? segment.label}</p></div>) : <p>这一刻没有日程。</p>}</div>}<small>点左指针复位 · 色段只读</small></div><div className="dial-frame">
      <svg ref={svgRef} className="dial-svg" viewBox="0 0 400 400" role="img" aria-label={`${view.date} 可旋转双环时间盘，内外两圈分别代表上午和下午`} onPointerDown={onDialPointerDown}>
        <circle cx="200" cy="200" r="158" className="dial-boundary" />
        <circle cx="200" cy="200" r={radiusFor(0, swapped)} className="dial-track" />
        <circle cx="200" cy="200" r={radiusFor(1, swapped)} className="dial-track" />
        <g transform={`rotate(${rotation} 200 200)`}>{Array.from({ length: 12 }, (_, i) => {
          const [x1, y1] = polar(152, i * 30), [x2, y2] = polar(i % 3 ? 158 : 164, i * 30);
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="dial-tick" />;
        })}
          {Array.from({ length: 12 }, (_, hour) => { const [x, y] = polar(171, hour * 30); return <text key={hour} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="dial-number">{hour === 0 ? 12 : hour}</text>; })}
          {empty.map(seg => <path key={seg.id} d={arc(radiusFor(seg.half, swapped), seg.startMinuteOfHalf, seg.endMinuteOfHalf)} className="dial-segment empty" />)}
          {visible.map(seg => <path key={seg.id} d={arc(radiusFor(seg.half, swapped), seg.startMinuteOfHalf, seg.endMinuteOfHalf)}
            className={`dial-segment ${seg.kind} ${focusedIds.has(seg.id) || selected?.kind === 'segment' && selected.id === seg.sourceId ? 'active' : ''}`}
            role={seg.kind === 'plan-reference' ? undefined : 'button'} tabIndex={seg.kind === 'plan-reference' ? undefined : 0}
            aria-label={`${kindLabels[seg.kind]}：${seg.label}，UTC${seg.offsetLabel}${seg.kind === 'fixed' || seg.kind === 'plan' ? '，双击解锁或重新锁定调整' : ''}`}
            onPointerDown={e => { if (seg.kind === 'plan') onSegmentPointerDown(e, seg); }}
            onClick={e => { if (seg.kind !== 'plan-reference' && e.detail !== 2 && editingSourceId !== seg.sourceId) onSegment(seg); }}
            onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); if (seg.kind !== 'plan-reference') onSegmentDoubleClick(seg); }}
            onKeyDown={e => { if (seg.kind !== 'plan-reference' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSegment(seg); } }} />)}
          {overlaps.map(x => <path key={x.key} d={arc(radiusFor(x.half, swapped), x.start, x.end)} className="dial-overlap" aria-hidden="true" />)}
          {candidates.flatMap(candidate => candidate.segments.filter(x => x.startDate === view.date || x.clippedRange.startAt < view.dayRange.endAt && x.clippedRange.endAt > view.dayRange.startAt).map(seg =>
            <path key={`${candidate.id}-${seg.id}`} d={arc(radiusFor(seg.half, swapped), seg.startMinuteOfHalf, seg.endMinuteOfHalf)}
              className={`dial-candidate ${candidate.state} ${chosen?.half === candidate.half && chosen.offset === candidate.offsetLabel ? 'chosen' : ''}`}
              role="button" tabIndex={0} aria-label={`${candidate.half === 0 ? '前十二小时' : '后十二小时'}滑块：${candidate.label} UTC${candidate.offsetLabel}，${candidate.state === 'valid' ? '无重叠' : candidate.reason}`}
              onPointerDown={e => onCandidatePointerDown(e, candidate)}
              onClick={() => onCandidate(candidate)} onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); onCandidateDoubleClick(); }} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCandidate(candidate); } }} />))}
        </g>
        <circle cx="200" cy="200" r="63" className="dial-center" />
        <text x="200" y="183" textAnchor="middle" className="dial-center-label">当前刻度</text>
        <text x="200" y="215" textAnchor="middle" className="dial-center-time">{clockLabel(focus)}</text>
        <text x="200" y="237" textAnchor="middle" className="dial-center-label">{focus < 720 ? '前 12 小时' : '后 12 小时'}</text>
        <path d="M200 391 L193 378 L207 378 Z" className="dial-viewer" />
      </svg>
      <span className={`ring-label ring-label-a ${swapped ? 'ring-outer' : 'ring-inner'}`}>前 12 小时 <strong>00–12</strong></span>
      <span className={`ring-label ring-label-b ${swapped ? 'ring-inner' : 'ring-outer'}`}>后 12 小时 <strong>12–24</strong></span>
    </div></div>
    <div className="focus-controls" aria-label="五分钟微调">
      <button type="button" onClick={() => onFocus(clampDay(focus - 5))} aria-label="向更早微调五分钟">− 5 分钟</button>
      <span>表盘指针 · 00:00—24:00</span>
      <button type="button" onClick={() => onFocus(clampDay(focus + 5))} aria-label="向更晚微调五分钟">+ 5 分钟</button>
    </div>
  </section>;
}

export function App() {
  const harness = useMemo(() => createPrototype('S01'), []);
  const host = harness.host;
  const [scenarioId, setScenarioId] = useState<ScenarioId>('S01');
  const [date, setDate] = useState(harness.scenario.date);
  const [zone, setZone] = useState(harness.scenario.zone);
  const [view, setView] = useState<DayView | null>(null);
  const [issue, setIssue] = useState('');
  const [selected, setSelected] = useState<Selected>(null);
  const [fanOpen, setFanOpen] = useState(false), [fanPage, setFanPage] = useState(0);
  const [focus, setFocus] = useState(() => minuteOfDay(harness.clock, harness.scenario.zone));
  const [placementMinute, setPlacementMinute] = useState(() => snapDay(minuteOfDay(harness.clock, harness.scenario.zone)));
  const [subject, setSubject] = useState<PlacementSubject | null>(null);
  const [preview, setPreview] = useState<PlacementPreview | null>(null);
  const [choice, setChoice] = useState<Choice>(null);
  const [swapped, setSwapped] = useState(false), [night, setNight] = useState(false), [reduce, setReduce] = useState(false);
  const [actualInputs, setActualInputs] = useState<{ start: string; end: string } | null>(null);
  const [actualPreview, setActualPreview] = useState<ActualPreview | null>(null);
  const [actualFailure, setActualFailure] = useState<Failure | null>(null);
  const [annotation, setAnnotation] = useState('');
  const [saving, setSaving] = useState(false);
  const [stretch, setStretch] = useState(0);
  const [dragVisual, setDragVisual] = useState<{ x: number; y: number; title: string; snapped: boolean } | null>(null);
  const [handDrag, setHandDrag] = useState<{ id: string; x: number; y: number; hit: number | null } | null>(null);
  const [morphTransfer, setMorphTransfer] = useState<{ x: number; y: number; title: string } | null>(null);
  const [pullVisual, setPullVisual] = useState<{ x: number; y: number; title: string } | null>(null);
  const [returnMorph, setReturnMorph] = useState<{ x: number; y: number; title: string; dx: number; dy: number } | null>(null);
  const [nowInput, setNowInput] = useState(formatDateTime(harness.clock, harness.scenario.zone));
  const svgRef = useRef<SVGSVGElement>(null), scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean; card: CardView } | null>(null);
  const handDragRef = useRef<{ pointerId: number; x: number; y: number; offsetX: number; offsetY: number; height: number; moved: boolean; hit: number | null; card: CardView } | null>(null);
  const suppressHandClick = useRef<string | null>(null);
  const dialRotateRef = useRef<{ pointerId: number; lastAngle: number; rawFocus: number; moved: boolean } | null>(null);
  const sliderRef = useRef<{ pointerId: number; x: number; y: number; offset: string; moved: boolean; startRadius: number; returning: boolean; kind: 'preview' | 'plan'; segment?: Segment } | null>(null);
  const suppressDialClick = useRef(false);
  const placementAttempt = useRef<{ key: string; commandId: string } | null>(null);
  const actualAttempt = useRef<{ key: string; commandId: string } | null>(null);
  const focusRef = useRef(focus), subjectRef = useRef(subject);
  const touchRef = useRef<number | null>(null), stretchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  focusRef.current = focus; subjectRef.current = subject;

  const reload = useCallback(() => {
    const result = host.readDay({ date, zone });
    if (result.ok) { setView(result.value); setIssue(''); } else setIssue(result.message);
  }, [host, date, zone]);
  useEffect(() => { reload(); return host.subscribe(() => { reload(); setPreview(null); setChoice(null); setActualPreview(null); }); }, [host, reload]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [scenarioId, date]);
  useEffect(() => { if (fanOpen) scrollRef.current?.scrollTo({ top: 0 }); }, [fanOpen]);
  useEffect(() => {
    if (!view || !subject) { setPreview(null); return; }
    if (placementMinute > 1435) { setPreview(null); setIssue('24:00 是当天终点，不能作为卡牌起点。'); return; }
    const result = host.previewPlacement({ token: view.token, subject, date, zone, focusMinuteOfDay: placementMinute });
    if (result.ok) { setPreview(result.value); setChoice(result.value.candidates.length === 1 ? { half: result.value.candidates[0].half, offset: result.value.candidates[0].offsetLabel } : null); setIssue(''); }
    else { setPreview(null); setIssue(result.message); }
    return () => { if (result.ok) host.cancelPreview(result.value.previewId); };
  }, [host, view?.token.epoch, view?.token.revision, subject, date, zone, placementMinute]);

  function changeScenario(id: ScenarioId) {
    harness.loadScenario(id); const data = harness.scenario;
    setScenarioId(id); setDate(data.date); setZone(data.zone); setNowInput(formatDateTime(data.now, data.zone));
    const now = minuteOfDay(data.now, data.zone);
    handDragRef.current = null; sliderRef.current = null; setHandDrag(null); setMorphTransfer(null); setPullVisual(null); setReturnMorph(null);
    setSelected(null); setFanOpen(false); setFanPage(0); setFocus(now); setPlacementMinute(snapDay(now));
    setSubject(null); setPreview(null); setChoice(null); setActualInputs(null); setActualPreview(null); setIssue('');
  }
  function chooseCard(card: CardView) { setSelected({ kind: 'card', id: card.instanceId }); setFanOpen(true); setSubject(null); setActualInputs(null); setActualPreview(null); setIssue(`${card.title} 已转正供查看；从浮窗向上推可化为指针处的滑块。`); }
  function beginCard(card: CardView) { setSelected({ kind: 'card', id: card.instanceId }); setSubject({ kind: 'hand', instanceId: card.instanceId, version: card.version }); setPlacementMinute(snapDay(focusRef.current)); setChoice(null); setFanOpen(false); setIssue('卡牌已在指针所示的绝对时间吸附为连续滑块；按住滑块调位置。'); }
  function cancelPlacement() { if (preview) host.cancelPreview(preview.previewId); setSubject(null); setPreview(null); setChoice(null); setIssue('预览已取消，合成数据未改变。'); }
  function chooseCandidate(candidate: Candidate) {
    if (suppressDialClick.current) return;
    setChoice({ half: candidate.half, offset: candidate.offsetLabel });
    setIssue(candidate.state === 'valid' ? `滑块已选 ${candidate.label} UTC${candidate.offsetLabel}；可拖动调整，确认后才保存。` : `${candidate.reason}。可继续调整；保存前须明确确认重叠。`);
  }
  const picked = preview?.candidates.find(x => x.half === choice?.half && x.offsetLabel === choice.offset) ?? null;
  async function submitPlacement(selectedCandidate: Candidate | null = picked, currentPreview: PlacementPreview | null = preview) {
    if (!view || !currentPreview || !selectedCandidate) { setIssue('请先明确选择一个落点'); return; }
    const key = `${currentPreview.previewId}:${selectedCandidate.id}`;
    const commandId = placementAttempt.current?.key === key ? placementAttempt.current.commandId : nextId();
    placementAttempt.current = { key, commandId };
    setSaving(true);
    const result = await host.submit({ commandId, expected: currentPreview.token, type: 'CommitPlacement', payload: { previewId: currentPreview.previewId, candidateId: selectedCandidate.id, acknowledgedOverlap: selectedCandidate.state === 'conflict' ? selectedCandidate.acknowledgementId : null } });
    setSaving(false); setIssue(result.ok ? `已在合成原型中安排 ${selectedCandidate.label}。` : result.message);
    if (result.ok) { placementAttempt.current = null; setSubject(null); setPreview(null); setChoice(null); setSelected(null); }
  }
  function onSegment(seg: Segment) {
    if (suppressDialClick.current) return;
    if (seg.kind === 'empty' || seg.kind === 'plan-reference') return;
    setSelected({ kind: 'segment', id: seg.sourceId! }); setSubject(null); setActualInputs(null); setActualPreview(null);
    setIssue(seg.kind === 'fact' ? '实际记录已锁定，可查看或追加说明。' : `${kindLabels[seg.kind]}已选中。`);
  }
  const selectedCard = view?.hand.find(x => selected?.kind === 'card' && x.instanceId === selected.id) ?? null;
  const selectedSegment = view?.segments.find(x => selected?.kind === 'segment' && x.sourceId === selected.id && x.kind !== 'plan-reference') ?? null;
  const editingSourceId = subject?.kind === 'plan' ? subject.planId : subject?.kind === 'fixed' ? subject.commitmentId : null;
  const focusedSegments = (view?.segments ?? []).filter(x => x.kind !== 'empty' && x.kind !== 'plan-reference' && focus >= x.half * 720 + x.startMinuteOfHalf && focus < x.half * 720 + x.endMinuteOfHalf);
  const selectedFact = view?.facts.find(x => selectedSegment?.kind === 'fact' && x.factId === selectedSegment.sourceId) ?? null;
  const pendingCard = subject?.kind === 'hand' ? view?.hand.find(x => x.instanceId === subject.instanceId) : null;
  const summaryCandidate = preview?.query.focusMinuteOfDay === placementMinute ? (picked ?? preview.candidates[0]) : null;
  const placementSummary = pendingCard && summaryCandidate
    ? `${pendingCard.title} · ${labelAt(summaryCandidate.range.startAt, zone).slice(-5).replace(':', '.')}—${labelAt(summaryCandidate.range.endAt, zone).slice(-5).replace(':', '.')} · ${summaryCandidate.units * 5} 分钟${summaryCandidate.state === 'conflict' ? ' · 有重叠，需再次确认' : ''}`
    : handDrag?.hit !== null && handDrag ? `${view?.hand.find(x => x.instanceId === handDrag.id)?.title ?? '卡牌'} · 正在计算滑块落点…` : null;
  const planVersion = (id: string) => view?.plans.find(x => x.planId === id)?.version;
  const fixedVersion = (id: string) => view?.fixed.find(x => x.commitmentId === id)?.version;
  function moveSegment(segment: Segment) {
    if (!view || !segment.sourceId) return;
    setSelected({ kind: 'segment', id: segment.sourceId });
    setPlacementMinute(snapDay(minuteOfDay(segment.sourceRange.startAt, zone)));
    if (segment.kind === 'plan') {
      const version = planVersion(segment.sourceId);
      if (version === undefined) { setIssue('计划版本缺失，请重新载入。'); return; }
      setSubject({ kind: 'plan', planId: segment.sourceId, version }); setChoice(null);
      setIssue('移动计划：请选择新的完整落点。');
    } else if (segment.kind === 'fixed') {
      const version = fixedVersion(segment.sourceId);
      if (version === undefined) { setIssue('固定安排版本缺失，请重新载入。'); return; }
      const unlocked = host.unlockFixed({ token: view.token, commitmentId: segment.sourceId, version });
      if (!unlocked.ok) { setIssue(unlocked.message); return; }
      setSubject({ kind: 'fixed', commitmentId: segment.sourceId, version, unlockId: unlocked.value }); setChoice(null);
      setIssue('仅此固定安排已临时解锁一次；新位置若重叠，须列出对象后再次确认。');
    }
  }
  function moveSelected() { if (selectedSegment) moveSegment(selectedSegment); }
  function onSegmentDoubleClick(segment: Segment) {
    if (segment.kind === 'fact') { onSegment(segment); setIssue('完成事实已锁定，只能查看或追加说明。'); return; }
    if (segment.kind !== 'plan' && segment.kind !== 'fixed') return;
    const current = subjectRef.current;
    const editingThis = current?.kind === 'plan' && current.planId === segment.sourceId || current?.kind === 'fixed' && current.commitmentId === segment.sourceId;
    if (editingThis) { cancelPlacement(); setSelected({ kind: 'segment', id: segment.sourceId! }); setIssue('已取消调整，滑块重新锁定；原安排未改变。'); }
    else moveSegment(segment);
  }
  function relockPreview() {
    const current = subjectRef.current;
    if (current?.kind !== 'plan' && current?.kind !== 'fixed') return;
    cancelPlacement();
    setIssue('已取消调整，滑块重新锁定；原安排未改变。');
  }
  async function retractPlan() {
    if (!view || !selectedSegment || selectedSegment.kind !== 'plan') return;
    const version = planVersion(selectedSegment.sourceId!);
    if (version === undefined) { setIssue('计划版本缺失，请重新载入。'); return; }
    const result = await host.submit({ commandId: nextId(), expected: view.token, type: 'RetractPlan', payload: { planId: selectedSegment.sourceId!, version } });
    setIssue(result.ok ? '计划已撤回；原实例返回手牌。' : result.message); if (result.ok) setSelected(null);
  }
  function openActual() {
    if (!view || (!selectedCard && !selectedSegment) || selectedSegment?.kind === 'fixed' || selectedSegment?.kind === 'fact') return;
    setFanOpen(false);
    const planned = selectedSegment?.kind === 'plan' ? selectedSegment.sourceRange : null;
    const end = planned?.endAt ?? harness.clock;
    const start = planned?.startAt ?? new Date(Date.parse(end) - 15 * 60000).toISOString();
    setActualInputs({ start: formatDateTime(start, zone), end: formatDateTime(end, zone) });
    setActualPreview(null); setActualFailure(null); setIssue('请核对实际开始和结束；如果结束尚未到达，确认后也会立即锁定。');
  }
  function actualDraft(): ActualDraft | null {
    if (!actualInputs || !view) return null;
    const [startDate, startTime] = actualInputs.start.split('T'), [endDate, endTime] = actualInputs.end.split('T');
    const plan = selectedSegment?.kind === 'plan' ? view.plans.find(x => x.planId === selectedSegment.sourceId) : null;
    const id = selectedCard?.instanceId ?? plan?.instanceId;
    if (!id || !startDate || !startTime || !endDate || !endTime) return null;
    const instanceVersion = selectedCard?.version ?? plan?.instanceVersion;
    if (instanceVersion === undefined) return null;
    const common = { instanceId: id, instanceVersion,
      start: { date: startDate, time: startTime, zone }, end: { date: endDate, time: endTime, zone } };
    return plan
      ? { ...common, mode: 'planned', planId: plan.planId, planVersion: plan.version }
      : { ...common, mode: 'unplanned' };
  }
  function previewActualInput() {
    if (!view) return;
    const draft = actualDraft(); if (!draft) { setIssue('请填写完整实际区间'); return; }
    const result = host.previewActual({ token: view.token, draft });
    if (result.ok) { setActualPreview(result.value); setActualFailure(null); setIssue('请检查锁定前预览。'); }
    else { setActualPreview(null); setActualFailure(result); setIssue(result.message); }
  }
  async function confirmActual() {
    if (!actualPreview) return;
    const key = `${actualPreview.previewId}:${actualPreview.acknowledgementId ?? ''}`;
    const commandId = actualAttempt.current?.key === key ? actualAttempt.current.commandId : nextId();
    actualAttempt.current = { key, commandId };
    setSaving(true);
    const result = await host.submit({ commandId, expected: actualPreview.token, type: 'ConfirmActual', payload: { previewId: actualPreview.previewId, acknowledgedOverlap: actualPreview.acknowledgementId } });
    setSaving(false); setIssue(result.ok ? '实际区间已在合成原型中确认并立即锁定。' : result.message);
    if (result.ok) { actualAttempt.current = null; setActualInputs(null); setActualPreview(null); setSelected(null); setSubject(null); }
  }
  async function addAnnotation() {
    if (!view || !selectedFact) return;
    const result = await host.submit({ commandId: nextId(), expected: view.token, type: 'AppendAnnotation', payload: { factId: selectedFact.factId, text: annotation } });
    setIssue(result.ok ? '说明已追加，原事实未改动。' : result.message); if (result.ok) setAnnotation('');
  }
  function applyNow() {
    try { const [d, time] = nowInput.split('T'); harness.setNow(oneLocal({ date: d, time, zone })); setIssue(`合成时钟设为 ${nowInput}；日终红色自动重算，无业务写入。`); }
    catch (error) { setIssue((error as Error).message); }
  }
  function keyControls(event: KeyboardEvent<HTMLElement>) {
    const el = event.target as HTMLElement;
    if (!subject || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPlacementMinute(x => snapDay(x + (event.key === 'ArrowRight' ? 5 : -5))); }
    if (event.key === 'Escape') { event.preventDefault(); cancelPlacement(); }
  }
  function dialPosition(x: number, y: number): { angle: number; distance: number; half: 0 | 1 } | null {
    const rect = svgRef.current?.getBoundingClientRect(); if (!rect) return null;
    const scale = Math.min(rect.width / 400, rect.height / 400);
    const contentLeft = rect.left + (rect.width - 400 * scale) / 2;
    const contentTop = rect.top + (rect.height - 400 * scale) / 2;
    const px = (x - contentLeft) / scale - 200, py = (y - contentTop) / scale - 200;
    const distance = Math.hypot(px, py); if (distance < 76 || distance > 185) return null;
    const nearest = Math.abs(distance - radiusFor(0, swapped)) <= Math.abs(distance - radiusFor(1, swapped)) ? 0 : 1;
    const angle = ((Math.atan2(px, -py) * 180 / Math.PI) + 360) % 360;
    return { angle, distance, half: nearest };
  }
  function pointerToDial(x: number, y: number): number | null {
    const position = dialPosition(x, y); if (!position || position.distance > 151) return null;
    const rotation = 180 - focusRef.current / 720 * 360;
    const unrotated = (position.angle - rotation + 720) % 360;
    return snapDay(Math.round(unrotated / 360 * 720 / 5) * 5 + position.half * 720);
  }
  function beginDrag(event: PointerEvent<HTMLDivElement>, card: CardView) {
    if ((event.target as HTMLElement).closest('button')) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, card };
    setDragVisual({ x: event.clientX, y: event.clientY, title: card.title, snapped: false });
  }
  function beginHandDrag(event: PointerEvent<HTMLDivElement>, card: CardView) {
    if (event.button !== 0) return;
    event.preventDefault(); window.getSelection()?.removeAllRanges();
    const rect = event.currentTarget.getBoundingClientRect();
    handDragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      offsetX: rect.left + rect.width / 2 - event.clientX, offsetY: rect.top + rect.height / 2 - event.clientY,
      height: event.currentTarget.offsetHeight, moved: false, hit: null, card };
  }
  function beginDialRotation(event: PointerEvent<SVGSVGElement>) {
    if (dragRef.current || handDragRef.current || sliderRef.current) return;
    const position = dialPosition(event.clientX, event.clientY);
    if (position) { event.preventDefault(); window.getSelection()?.removeAllRanges(); dialRotateRef.current = { pointerId: event.pointerId, lastAngle: position.angle, rawFocus: focusRef.current, moved: false }; }
  }
  function beginSliderMove(event: PointerEvent<SVGPathElement>, candidate: Candidate) {
    event.preventDefault(); event.stopPropagation(); window.getSelection()?.removeAllRanges();
    chooseCandidate(candidate);
    sliderRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offset: candidate.offsetLabel, moved: false, startRadius: dialRadiusAt(event.clientX, event.clientY, svgRef.current!.getBoundingClientRect()) ?? 132, returning: false, kind: 'preview' };
  }
  function beginPlanPull(event: PointerEvent<SVGPathElement>, segment: Segment) {
    if (event.button !== 0 || subjectRef.current) return;
    event.preventDefault(); event.stopPropagation(); window.getSelection()?.removeAllRanges();
    sliderRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offset: segment.offsetLabel, moved: false, startRadius: dialRadiusAt(event.clientX, event.clientY, svgRef.current!.getBoundingClientRect()) ?? 132, returning: false, kind: 'plan', segment };
  }
  function showReturnMorph(x: number, y: number, title: string) {
    setReturnMorph({ x, y, title, dx: window.innerWidth / 2 - x, dy: window.innerHeight - 165 - y });
    setTimeout(() => setReturnMorph(null), 320);
  }
  useEffect(() => {
    const stopSelection = (event: Event) => { if (dialRotateRef.current || sliderRef.current || dragRef.current || handDragRef.current) event.preventDefault(); };
    window.addEventListener('selectstart', stopSelection);
    return () => window.removeEventListener('selectstart', stopSelection);
  }, []);
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const drag = handDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 7) drag.moved = true;
      if (!drag.moved) return;
      const x = event.clientX + drag.offsetX, y = event.clientY + drag.offsetY;
      const rect = svgRef.current?.getBoundingClientRect();
      const hit = rect ? stagedCardPreview(x, y - drag.height / 2, rect, focusRef.current, swapped, drag.y - event.clientY) : null;
      drag.hit = hit;
      setHandDrag({ id: drag.card.instanceId, x, y, hit });
      if (hit !== null) {
        const current = subjectRef.current;
        if (current?.kind !== 'hand' || current.instanceId !== drag.card.instanceId) {
          setSubject({ kind: 'hand', instanceId: drag.card.instanceId, version: drag.card.version });
          subjectRef.current = { kind: 'hand', instanceId: drag.card.instanceId, version: drag.card.version };
        }
        setPlacementMinute(hit);
      } else if (subjectRef.current?.kind === 'hand' && subjectRef.current.instanceId === drag.card.instanceId) {
        subjectRef.current = null; setSubject(null); setPreview(null); setChoice(null);
      }
    };
    const up = (event: globalThis.PointerEvent) => {
      const drag = handDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      handDragRef.current = null; setHandDrag(null);
      if (!drag.moved) return;
      suppressHandClick.current = drag.card.instanceId;
      setTimeout(() => { if (suppressHandClick.current === drag.card.instanceId) suppressHandClick.current = null; }, 0);
      if (event.type === 'pointercancel' || drag.hit === null) {
        subjectRef.current = null; setSubject(null); setPreview(null); setChoice(null);
        setIssue('卡牌已吸回手牌，原安排未改变。');
      } else {
        setMorphTransfer({ x: event.clientX + drag.offsetX, y: event.clientY + drag.offsetY, title: drag.card.title });
        setTimeout(() => setMorphTransfer(null), 320);
        setSelected({ kind: 'card', id: drag.card.instanceId }); setFanOpen(false);
        setIssue('卡牌已形变为时间盘上的滑块；核对时间与重叠后再确认安排。');
      }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  });
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current; if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.y - event.clientY > 38) drag.moved = true;
      if (!drag.moved) return;
      setDragVisual(current => current && { ...current, x: event.clientX, y: event.clientY, snapped: true });
    };
    const up = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current; if (!drag || event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      setDragVisual(null);
      if (drag.moved) beginCard(drag.card);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  });
  useEffect(() => {
    const move = (event: globalThis.PointerEvent) => {
      const dial = dialRotateRef.current;
      if (dial?.pointerId === event.pointerId) {
        const position = dialPosition(event.clientX, event.clientY);
        if (position) {
          let delta = position.angle - dial.lastAngle;
          if (delta > 180) delta -= 360;
          if (delta < -180) delta += 360;
          if (Math.abs(delta) > 0.5) dial.moved = true;
          dial.rawFocus = clampDay(dial.rawFocus - delta * 2);
          dial.lastAngle = position.angle;
          if (dial.moved) setFocus(clampDay(Math.round(dial.rawFocus / 5) * 5));
        }
      }
      const slider = sliderRef.current;
      if (slider?.pointerId === event.pointerId) {
        if (Math.hypot(event.clientX - slider.x, event.clientY - slider.y) > 5) slider.moved = true;
        if (!slider.moved) return;
        const bounds = svgRef.current?.getBoundingClientRect();
        slider.returning = !!bounds && (slider.kind === 'plan' || subjectRef.current?.kind === 'hand') && pulledBeyondDial(event.clientX, event.clientY, bounds, slider.startRadius);
        setPullVisual(slider.returning ? { x: event.clientX, y: event.clientY, title: slider.kind === 'plan' ? slider.segment!.title : view?.hand.find(card => card.instanceId === (subjectRef.current?.kind === 'hand' ? subjectRef.current.instanceId : ''))?.title ?? '行动卡' } : null);
        if (slider.returning) return;
        if (slider.kind === 'plan') return;
        const hit = pointerToDial(event.clientX, event.clientY);
        if (hit !== null) setPlacementMinute(hit);
      }
    };
    const up = (event: globalThis.PointerEvent) => {
      const dial = dialRotateRef.current;
      if (dial?.pointerId === event.pointerId) {
        dialRotateRef.current = null;
        if (dial.moved) { suppressDialClick.current = true; setTimeout(() => { suppressDialClick.current = false; }, 0); }
      }
      const slider = sliderRef.current;
      if (slider?.pointerId !== event.pointerId) return;
      sliderRef.current = null;
      setPullVisual(null);
      if (!slider.moved) return;
      suppressDialClick.current = true; setTimeout(() => { suppressDialClick.current = false; }, 0);
      if (event.type !== 'pointercancel' && slider.returning) {
        if (slider.kind === 'preview' && subjectRef.current?.kind === 'hand') {
          const instanceId = subjectRef.current.instanceId;
          const title = view?.hand.find(card => card.instanceId === instanceId)?.title ?? '行动卡';
          if (preview) host.cancelPreview(preview.previewId);
          subjectRef.current = null; setSubject(null); setPreview(null); setChoice(null); setSelected(null); setFanOpen(true);
          showReturnMorph(event.clientX, event.clientY, title);
          setIssue(`${title} 已收回手牌，原安排未改变。`);
          return;
        }
        if (slider.kind === 'plan' && slider.segment?.sourceId && view) {
          const plan = slider.segment;
          const version = planVersion(plan.sourceId!);
          if (version === undefined) { setIssue('计划版本缺失，请重新载入。'); return; }
          void (async () => {
            setSaving(true);
            const result = await host.submit({ commandId: nextId(), expected: view.token, type: 'RetractPlan', payload: { planId: plan.sourceId!, version } });
            setSaving(false);
            if (result.ok) { setSelected(null); setFanOpen(true); showReturnMorph(event.clientX, event.clientY, plan.title); }
            setIssue(result.ok ? `${plan.title} 已收回手牌。` : result.message);
          })();
          return;
        }
      }
      if (slider.kind === 'plan') { setIssue('计划保留原位；拉出表盘外缘再松手可收回手牌。'); return; }
      const hit = pointerToDial(event.clientX, event.clientY), s = subjectRef.current, v = view;
      if (hit === null || !s || !v) { setIssue('滑块留在原预览位置；请按住时间环内移动。'); return; }
      const result = host.previewPlacement({ token: v.token, subject: s, date, zone, focusMinuteOfDay: hit });
      if (!result.ok) { setIssue(result.message); return; }
      setPreview(result.value);
      const options = result.value.candidates;
      const matching = options.find(x => x.offsetLabel === slider.offset);
      if (matching) { setChoice({ half: matching.half, offset: matching.offsetLabel }); setIssue(matching.state === 'conflict' ? `${matching.reason}；确认重叠后才保存。` : `滑块已移动到 ${matching.label}；确认后才保存。`); }
      else { setChoice(null); setIssue('该刻度有多个偏移或不可用，请从候选列表明确选择。'); }
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  });
  const fanCards = view?.hand.slice(fanPage * 4, fanPage * 4 + 4) ?? [];
  const pages = Math.max(1, Math.ceil((view?.hand.length ?? 0) / 4));
  function wheel(event: WheelEvent<HTMLDivElement>) {
    const node = scrollRef.current; if (!node || reduce || subjectRef.current) return;
    if ((node.scrollTop <= 0 && event.deltaY < 0) || (node.scrollTop + node.clientHeight >= node.scrollHeight - 1 && event.deltaY > 0)) {
      setStretch(Math.sign(event.deltaY) * Math.min(18, Math.abs(event.deltaY) * 0.16));
      if (stretchTimer.current) clearTimeout(stretchTimer.current);
      stretchTimer.current = setTimeout(() => setStretch(0), 180);
    }
  }
  function touchStart(event: TouchEvent<HTMLDivElement>) { if (!(event.target as HTMLElement).closest('button, input, select, .dial-section')) touchRef.current = event.touches[0].clientY; }
  function touchMove(event: TouchEvent<HTMLDivElement>) {
    const node = scrollRef.current; if (touchRef.current === null || !node || reduce || subject) return;
    const delta = event.touches[0].clientY - touchRef.current;
    if ((node.scrollTop <= 0 && delta > 0) || (node.scrollTop + node.clientHeight >= node.scrollHeight - 1 && delta < 0)) setStretch(Math.sign(delta) * Math.min(18, Math.abs(delta) * 0.2));
  }
  const segments = (view?.segments ?? []).filter(x => x.kind !== 'empty' && x.kind !== 'plan-reference').sort((a, b) => a.clippedRange.startAt.localeCompare(b.clippedRange.startAt));

  return <div className={`prototype ${night ? 'night' : ''} ${reduce ? 'reduce-motion' : ''} ${fanOpen ? 'fan-open' : ''}`}>
    <header className="topbar">
      <div><strong className="brand">CardGrid</strong><span className="topbar-divider"/><span>时间盘交互原型</span><small className="prototype-badge">1D · 合成数据</small></div>
      <nav aria-label="原型导航"><span className="nav-active">Today</span><span>Inbox</span><span>Schedule</span></nav>
    </header>
    <div className="app-shell">
      <aside className="scenario-rail" aria-label="合成场景">
        <p className="eyebrow">SCENARIOS / 01–07</p>
        <h2>试验场景</h2>
        <p className="muted">切换场景会重置内存中的安排。</p>
        <div className="scenario-list">{scenarioIds.map(id => <button type="button" key={id} className={scenarioId === id ? 'active' : ''} onClick={() => changeScenario(id)}><span>{id}</span><strong>{scenarioNames[id]}</strong></button>)}</div>
        <div className="rail-settings">
          <label><input type="checkbox" checked={night} onChange={e => setNight(e.target.checked)} /> 夜间主题</label>
          <label><input type="checkbox" checked={reduce} onChange={e => setReduce(e.target.checked)} /> 减少动态效果</label>
          <label><input type="checkbox" checked={swapped} onChange={e => setSwapped(e.target.checked)} /> 交换内外圈作对照</label>
        </div>
      </aside>
      <main className="main-area">
        <div className="page-heading"><div><p className="eyebrow">TODAY / 今日</p><h1>{view ? view.date : date}</h1><p className="muted">{scenarioNames[scenarioId]} · {zone}</p></div><div className="date-controls"><button type="button" onClick={() => { setDate(addDate(date, -1)); cancelPlacement(); }} aria-label="前一天">←</button><button type="button" onClick={() => { setDate(harness.scenario.date); cancelPlacement(); }}>场景日期</button><button type="button" onClick={() => { setDate(addDate(date, 1)); cancelPlacement(); }} aria-label="后一天">→</button></div></div>
        <div className="notice" role="status" aria-live="polite">{placementSummary || issue || '按住卡牌拖入时间盘；将卡牌滑块拉出表盘外缘可收回手牌。'}</div>
        <div className="workspace-scroll" ref={scrollRef} onWheel={wheel} onTouchStart={touchStart} onTouchMove={touchMove} onTouchEnd={() => { touchRef.current = null; setStretch(0); }}>
          <div className="workspace-inner" style={{ transform: `translateY(${stretch}px)` }}>
            <div className="main-grid">
              {view && <Dial view={view} preview={preview} chosen={choice} focus={focus} swapped={swapped} selected={selected} editingSourceId={editingSourceId}
                onSegment={onSegment} onSegmentDoubleClick={onSegmentDoubleClick} onSegmentPointerDown={beginPlanPull} onCandidate={chooseCandidate} onCandidateDoubleClick={relockPreview} onCandidatePointerDown={beginSliderMove} onDialPointerDown={beginDialRotation} onFocus={setFocus} onKeyDown={keyControls} svgRef={svgRef} />}
              <section className="detail-pane" aria-label="时间与操作详情" onKeyDown={keyControls}>
                <div className="section-heading"><div><p className="eyebrow">DETAIL / 当前选择</p><h2>{!subject && (selectedCard?.title ?? selectedSegment?.title) || (focusedSegments.length ? `${clockLabel(focus)} · ${focusedSegments.length} 项` : `${clockLabel(focus)} · 空闲`)}</h2></div>{selected && <button type="button" className="quiet" onClick={() => { setSelected(null); setActualInputs(null); cancelPlacement(); }}>关闭</button>}</div>
                {(!selected || subject) && focusedSegments.length > 0 && <div className="focus-items"><p className="muted">指针指向的全部项目</p>{focusedSegments.map(x => <button key={x.id} type="button" onClick={() => onSegment(x)}><span className={`time-kind ${x.kind}`}>{kindLabels[x.kind]}</span><strong>{x.title}</strong><small>{labelAt(x.clippedRange.startAt, zone)}—{labelAt(x.clippedRange.endAt, zone)}</small></button>)}</div>}
                {selectedCard && <><p className="detail-body">{selectedCard.criteria}</p><div className="stat-row"><span>预设时长</span><strong>{selectedCard.presetMinutes} 分钟 · {(selectedCard.presetMinutes ?? 0) / 5} 单位</strong></div><div className="actions"><button type="button" className="primary" onClick={() => beginCard(selectedCard)}>安排到时间盘</button><button type="button" onClick={openActual}>补记实际</button></div></>}
                {selectedSegment && <><p className="detail-body">{kindLabels[selectedSegment.kind]} · {selectedSegment.label}</p><div className="stat-row"><span>源区间</span><strong>{labelAt(selectedSegment.sourceRange.startAt, zone, true)}—{labelAt(selectedSegment.sourceRange.endAt, zone, true)}</strong></div><div className="actions">{selectedSegment.kind === 'plan' && <><button type="button" onClick={editingSourceId === selectedSegment.sourceId ? relockPreview : moveSelected}>{editingSourceId === selectedSegment.sourceId ? '取消调整并重新锁定' : '调整计划'}</button><button type="button" onClick={retractPlan}>收回手牌</button><button type="button" className="primary" onClick={openActual}>确认实际</button></>}{selectedSegment.kind === 'fixed' && <button type="button" onClick={editingSourceId === selectedSegment.sourceId ? relockPreview : moveSelected}>{editingSourceId === selectedSegment.sourceId ? '取消调整并重新锁定' : '明确解锁并调整一次'}</button>}</div></>}
                {selectedFact && <div className="fact-note"><p><strong>已锁定的实际记录</strong></p><p>{labelAt(selectedFact.actualRange.startAt, zone, true)}—{labelAt(selectedFact.actualRange.endAt, zone, true)}；确认于 {labelAt(selectedFact.confirmedAt, zone, true)}</p>{selectedFact.plannedRange && <p>原计划仅作对照：{labelAt(selectedFact.plannedRange.startAt, zone)}—{labelAt(selectedFact.plannedRange.endAt, zone)}</p>}{selectedFact.annotations.map(x => <p key={x.id}>追加说明：{x.text}</p>)}<label>追加说明<textarea value={annotation} onChange={e => setAnnotation(e.target.value)} placeholder="说明实际记录，原内容仍保持不变" /></label><button type="button" disabled={!annotation.trim()} onClick={addAnnotation}>追加说明</button></div>}
                {preview && <div className="preview-panel"><div className="section-heading"><div><p className="eyebrow">SNAP / 滑块预览</p><h3>选择完整时间段</h3></div><button type="button" className="quiet" onClick={cancelPlacement}>取消</button></div><p className="muted">按住滑块沿圆周调时间、切换内外圈；卡牌预览滑块拉出表盘外缘并松手可回手牌。指针固定，表盘可转动。</p>{preview.unresolved.map((x, i) => <p className="warning" key={i}>{x.half === 0 ? '前十二小时' : '后十二小时'}：{x.message}</p>)}<div className="candidate-list">{preview.candidates.map(x => <button type="button" key={x.id} className={`${x.state} ${picked?.id === x.id ? 'selected' : ''}`} onClick={() => chooseCandidate(x)}><span className="candidate-dot"/><span><strong>{x.half === 0 ? '前 12 小时' : '后 12 小时'}</strong><small>{x.label} · UTC{x.offsetLabel} · {x.units} 个五分钟单位</small>{x.state === 'conflict' && <em>{x.reason}</em>}</span><span aria-hidden="true">{x.state === 'valid' ? '空闲' : '重叠'}</span></button>)}</div>{picked?.state === 'conflict' && <div className="overlap-warning"><strong>这段时间与已有内容重叠。保存后两者都会保留：</strong>{picked.blockers.map(x => <p key={x.id}>{x.title}：{labelAt(x.overlap.startAt, zone)}—{labelAt(x.overlap.endAt, zone)}</p>)}</div>}<button type="button" className="primary wide" disabled={!picked || saving} onClick={() => void submitPlacement()}>{saving ? '保存中…' : picked?.state === 'conflict' ? '已了解重叠，仍确认安排' : '确认安排到所选时间段'}</button></div>}
                {actualInputs && <div className="actual-panel"><p className="eyebrow">ACTUAL / 完成确认</p><h3>填写实际区间</h3><label>实际开始<input type="datetime-local" value={actualInputs.start} onInput={e => { setActualInputs({ ...actualInputs, start: e.currentTarget.value }); setActualPreview(null); }} /></label><label>实际结束<input type="datetime-local" value={actualInputs.end} onInput={e => { setActualInputs({ ...actualInputs, end: e.currentTarget.value }); setActualPreview(null); }} /></label><p className="warning">确认后原事实不可修改，录错只能追加说明。</p><button type="button" onClick={previewActualInput}>核对内容与重叠</button>{actualFailure?.choices?.map((x, i) => <button type="button" key={i} onClick={() => setIssue(`请选择偏移 UTC${x.input.offset}；此原型的完成表单暂不提供重复时间偏移编辑。`)}>UTC{x.input.offset} · {x.instant}</button>)}{actualPreview && <div className="confirmation"><p><strong>{actualPreview.title}</strong> · {actualPreview.criteria}</p><p>实际：{labelAt(actualPreview.range.startAt, zone, true)}—{labelAt(actualPreview.range.endAt, zone, true)}</p>{Date.parse(actualPreview.range.endAt) > Date.parse(harness.clock) && <p className="warning">结束时间尚未到达；提前确认后也会立即锁定。</p>}{actualPreview.conflicts.length > 0 && <div className="overlap-warning"><strong>与以下安排重叠，需要再次确认</strong>{actualPreview.conflicts.map(x => <p key={x.id}>{x.title}：{labelAt(x.overlap.startAt, zone)}—{labelAt(x.overlap.endAt, zone)}</p>)}</div>}<button type="button" className="primary wide" disabled={saving} onClick={confirmActual}>{actualPreview.conflicts.length ? '已了解重叠，仍确认并锁定' : '确认实际并锁定'}</button></div>}</div>}
                {!selected && !preview && focusedSegments.length === 0 && <p className="empty-prompt">指针当前指向空闲时间。点击手牌查看，向上推查看浮窗即可形成滑块。</p>}
              </section>
            </div>
            <section className="timeline" aria-label="时间段列表"><div className="section-heading"><div><p className="eyebrow">TIMELINE / 同一投影</p><h2>时间列表</h2></div><span className="muted">{segments.length} 个可见片段</span></div><div className="legend"><span className="legend-fixed">固定</span><span className="legend-plan">计划</span><span className="legend-fact">实际</span><span className="legend-reference">原计划对照</span><span className="legend-empty">空时间（已结束日期）</span></div>{segments.length ? <div className="timeline-list">{segments.map(x => <button type="button" key={x.id} onClick={() => onSegment(x)}><span className={`time-kind ${x.kind}`}>{kindLabels[x.kind]}</span><span className="timeline-time">{labelAt(x.clippedRange.startAt, zone)}—{labelAt(x.clippedRange.endAt, zone)}</span><strong>{x.title}</strong><small>{x.startDate !== date ? `开始于 ${x.startDate}` : ''}</small></button>)}</div> : <p className="empty-prompt">这一天没有固定安排、计划或完成事实。</p>}</section>
            <section className="lab-panel" aria-label="合成时间与故障控制"><div><p className="eyebrow">LAB / 仅原型</p><h2>合成时钟与故障</h2></div><div className="lab-controls"><label>模拟当前时间<input type="datetime-local" value={nowInput} onInput={e => setNowInput(e.currentTarget.value)} /></label><button type="button" onClick={applyNow}>应用模拟时间</button>{scenarioId === 'S04' && <><button type="button" onClick={() => { const instant = at(date, '09:30', zone); harness.setNow(instant); setNowInput(formatDateTime(instant, zone)); setIssue('模拟 09:30：现在可以预览提前确认。'); }}>09:30 提前确认</button><button type="button" onClick={() => { const instant = at(date, '23:59', zone); harness.setNow(instant); setNowInput(formatDateTime(instant, zone)); setIssue('模拟 23:59：该日尚未填红。'); }}>23:59 日终前</button><button type="button" onClick={() => { const instant = at(addDate(date, 1), '00:00', zone); harness.setNow(instant); setNowInput(formatDateTime(instant, zone)); setIssue('模拟次日 00:00：该日空时间自动填红。'); }}>次日 00:00</button></>}<button type="button" onClick={() => { harness.simulateExternalWrite(); setIssue('已模拟另一窗口写入。旧落点预览失效。'); }}>模拟外部修订</button><button type="button" onClick={() => { harness.failNextSubmit('STORAGE_FAILED'); setIssue('下一次提交将模拟失败，草稿保留。'); }}>下次提交失败</button></div>{scenarioId === 'S06' && <div className="dst-panel"><strong>纽约时间校验</strong><p>春季 2026-03-08 02:30：{resolveLocal({ date: '2026-03-08', time: '02:30', zone: 'America/New_York' }).length} 个有效时间点（不存在）</p><p>秋季 2026-11-01 01:30：{resolveLocal({ date: '2026-11-01', time: '01:30', zone: 'America/New_York' }).map(x => `${x} UTC${offsetLabel(x, 'America/New_York')}`).join('；')}</p><p>10-31 23:00 +150 / +210 分钟：{[150, 210].map(n => labelAt(new Date(Date.parse(at('2026-10-31', '23:00', 'America/New_York')) + n * 60000).toISOString(), 'America/New_York', true)).join(' / ')}</p><p>11-01 当地日范围：{dayRange('2026-11-01', 'America/New_York').startAt}—{dayRange('2026-11-01', 'America/New_York').endAt}</p><div className="actions"><button type="button" onClick={() => { setDate('2026-03-08'); setFocus(150); }}>查看春季缺刻度</button><button type="button" onClick={() => { setDate('2026-11-01'); setFocus(90); }}>查看秋季重复刻度</button><button type="button" onClick={() => { setDate('2026-10-31'); setFocus(660); }}>返回跨日落点</button></div></div>}</section>
          </div>
        </div>
      </main>
    </div>
    <aside className={`hand-dock ${fanOpen ? 'open' : ''}`} aria-label="手牌位置"><div className="hand-toolbar"><div><p className="eyebrow">HAND / 待安排</p><strong>{view?.hand.length ?? 0} 张行动卡</strong></div><div className="hand-actions">{pages > 1 && <><button type="button" disabled={fanPage === 0} onClick={() => setFanPage(x => x - 1)}>上一组</button><span>{fanPage + 1}/{pages}</span><button type="button" disabled={fanPage >= pages - 1} onClick={() => setFanPage(x => x + 1)}>下一组</button></>}<button type="button" className="primary" onClick={() => setFanOpen(x => !x)}>{fanOpen ? '收起手牌' : '展开手牌'}</button></div></div>{fanOpen && <div className="hand-list">{fanCards.map(card => <div key={card.instanceId}><button type="button" onClick={() => chooseCard(card)}>{card.title} · {card.presetMinutes} 分钟</button></div>)}</div>}</aside>
    {fanOpen && <div className="hand-cards-layer" aria-label="独立悬浮手牌">{fanCards.map((card, i) => {
      const angle = fanCards.length === 2 ? (i - .5) * 56
        : (i - (fanCards.length - 1) / 2) * Math.min(13, 55 / Math.max(1, fanCards.length - 1));
      return <HandCard key={card.instanceId} card={card} number={fanPage * 4 + i + 1} angle={angle}
        selected={selected?.kind === 'card' && selected.id === card.instanceId}
        dragging={handDrag?.id === card.instanceId} previewing={handDrag?.id === card.instanceId && handDrag.hit !== null} position={handDrag?.id === card.instanceId ? handDrag : null}
        onPointerDown={beginHandDrag} onView={item => { if (suppressHandClick.current === item.instanceId) { suppressHandClick.current = null; return; } chooseCard(item); }} />;
    })}</div>}
    {selectedCard && fanOpen && !subject && <div className="inspection-card" onPointerDown={e => beginDrag(e, selectedCard)} aria-label={`${selectedCard.title} 查看浮窗，向上推安排`}><span className="card-edge"/><button type="button" className="inspection-close" onClick={() => setSelected(null)} aria-label="关闭查看浮窗">×</button><small>查看卡牌 · {selectedCard.presetMinutes} 分钟</small><h2>{selectedCard.title}</h2><p>{selectedCard.criteria}</p><div className="inspection-hint">↑ 向上推，吸附到 {clockLabel(focus)}</div><button type="button" className="primary" onClick={() => beginCard(selectedCard)}>安排到指针时间</button></div>}
    {dragVisual && <div className={`drag-morph ${dragVisual.snapped ? 'snapped' : ''}`} style={{ left: dragVisual.x, top: dragVisual.y }} aria-hidden="true"><span>{dragVisual.snapped ? '时间段滑块' : dragVisual.title}</span></div>}
    {pullVisual && <div className="slider-pull-ghost" style={{ left: pullVisual.x, top: pullVisual.y }} aria-hidden="true"><span>{pullVisual.title}</span><small>松手收回手牌</small></div>}
    {returnMorph && <div className="slider-return-morph" style={{ left: returnMorph.x, top: returnMorph.y, '--return-x': `${returnMorph.dx}px`, '--return-y': `${returnMorph.dy}px` } as CSSProperties} aria-hidden="true"><span>{returnMorph.title}</span></div>}
    {morphTransfer && <div className="card-to-slider" style={{ left: morphTransfer.x, top: morphTransfer.y }} aria-hidden="true"><span>{morphTransfer.title}</span></div>}
  </div>;
}
