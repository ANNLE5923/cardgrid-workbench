import { useEffect, useMemo, useRef, useState } from 'react';
import { displayInstant } from '../time.ts';
import type { DialFragment, DialHalf, DialItem, DialScene, HitAnchor } from './types.ts';
import { geometry, defaultMetrics } from './geometry.ts';
import { DayOverview, clockLabel } from './DayOverview.tsx';
import './time-dial.css';

const DAY_MINUTES = 1440;
const HALF_MINUTES = 720;

type RingPath = {
  key: string;
  d: string;
  source: DialFragment['source'];
  fragmentId: string;
  title: string;
  startMinute: number;
  endMinute: number;
  active: boolean;
};

type MarkPath = { key: string; half: DialHalf; start: number; end: number };
type Owned = { owner: string; f: DialFragment };

function halfOf(fragment: DialFragment): DialHalf {
  return fragment.startMinute < HALF_MINUTES ? 'inner' : 'outer';
}
function localEdges(fragment: DialFragment): [number, number] {
  if (fragment.startMinute < HALF_MINUTES) {
    return [fragment.startMinute, fragment.endMinute];
  }
  return [fragment.startMinute - HALF_MINUTES, fragment.endMinute - HALF_MINUTES];
}

const isReal = (f: DialFragment) =>
  f.source === 'plan' || f.source === 'fixed' || f.source === 'fact';

// Overlaps only between DISTINCT source items, confirmed by UTC range, drawn on the shared half.
function overlapPaths(owned: readonly Owned[]): readonly MarkPath[] {
  const real = owned.filter(o => isReal(o.f));
  const out: MarkPath[] = [];
  for (let i = 0; i < real.length; i++) {
    for (let j = i + 1; j < real.length; j++) {
      const A = real[i], B = real[j];
      if (A.owner === B.owner) continue;
      const ra = A.f.range, rb = B.f.range;
      if (!ra || !rb) continue;
      const gs = ra.startAt >= rb.startAt ? ra.startAt : rb.startAt;
      const ge = ra.endAt <= rb.endAt ? ra.endAt : rb.endAt;
      if (!(gs < ge)) continue;
      const aInner = A.f.startMinute < HALF_MINUTES;
      const bInner = B.f.startMinute < HALF_MINUTES;
      if (aInner !== bInner) continue;
      const half: DialHalf = aInner ? 'inner' : 'outer';
      const ws = Math.max(A.f.startMinute, B.f.startMinute);
      const we = Math.min(A.f.endMinute, B.f.endMinute);
      if (!(we > ws)) continue;
      out.push({
        key: `${A.owner}|${B.owner}|${A.f.id}|${B.f.id}`,
        half,
        start: half === 'inner' ? ws : ws - HALF_MINUTES,
        end: half === 'inner' ? we : we - HALF_MINUTES,
      });
    }
  }
  return out;
}

// DST gaps: complement of the valid axis intervals within each half (F08/N03).
function gapPaths(axis: DialScene['axis']): readonly MarkPath[] {
  const out: MarkPath[] = [];
  for (const half of ['inner', 'outer'] as const) {
    const base = half === 'inner' ? 0 : HALF_MINUTES;
    const valid = axis
      .filter(a => a.half === half)
      .map(a => [Math.max(base, a.startMinute), Math.min(base + HALF_MINUTES, a.endMinute)] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    let cursor = base;
    for (const [s, e] of valid) {
      if (s > cursor) {
        out.push({ key: `gap-${half}-${cursor}`, half, start: cursor - base, end: s - base });
      }
      cursor = Math.max(cursor, e);
    }
    if (cursor < base + HALF_MINUTES) {
      out.push({ key: `gap-${half}-end`, half, start: cursor - base, end: HALF_MINUTES });
    }
  }
  return out;
}

type Note = Readonly<{ title: string; items: readonly DialItem[] }>;

export function TimeDial(props: Readonly<{
  scene: DialScene;
  focus: number;
  onFocusChange: (focus: number) => void;
  candidate?: readonly DialFragment[] | null;
  /** A gesture preview is active: dial drag moves the landing instead of rotating the reading. */
  placementActive?: boolean;
  placementMinute?: number;
  onPlacementMove?: (minute: number, originDate?: string) => void;
  onCancelPlacement?: () => void;
  onRetractItem?: (item: DialItem) => void;
  onInteractionStart?: () => void;
  /** Reset to now and resume following (D024). */
  onResetNow?: () => void;
  /** Double-click a plan/fixed arc to reschedule it (F05). */
  onRescheduleItem?: (item: DialItem) => void;
}>) {
  const { scene, focus, onFocusChange, candidate, placementActive = false, placementMinute = focus,
    onPlacementMove, onResetNow, onRescheduleItem } = props;
  const [note, setNote] = useState<Note | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const focusValueRef = useRef(focus);
  focusValueRef.current = focus;

  // Dial rotation drag state; the anchor carries half for radial half-switch hysteresis (F05).
  const dragRef = useRef<{
    active: boolean; moved: boolean; anchor: HitAnchor | null; pointerId: number; sx: number; sy: number;
    initialFocus: number; lastAngle: number; delta: number; startRadius: number; currentRadius: number;
    date: string; preview: boolean; item: DialItem | null;
  }>({ active: false, moved: false, anchor: null, pointerId: -1, sx: 0, sy: 0,
    initialFocus: 0, lastAngle: 0, delta: 0, startRadius: 0, currentRadius: 0,
    date: '', preview: false, item: null });

  const pose = geometry.pose(focus);
  const nowMinute = useMemo(
    () => displayInstant(scene.now, scene.zone).minute,
    [scene.now, scene.zone],
  );

  const allFragments = useMemo(
    () => scene.items.flatMap(i => i.fragments),
    [scene.items],
  );
  const owned = useMemo(
    () => scene.items.flatMap(item => item.fragments.map(f => ({ owner: JSON.stringify([item.source, item.id]), f }))),
    [scene.items],
  );
  const overlaps = useMemo(() => overlapPaths(owned), [owned]);
  const gaps = useMemo(() => gapPaths(scene.axis), [scene.axis]);

  const activeIds = useMemo(
    () =>
      new Set(
        scene.items
          .flatMap(i => i.fragments)
          .filter(f => f.startMinute <= focus && focus < f.endMinute)
          .map(f => f.id),
      ),
    [scene.items, focus],
  );

  const ringPaths: RingPath[] = [];
  for (const item of scene.items) {
    for (const fragment of item.fragments) {
      const half = halfOf(fragment);
      const [ls, le] = localEdges(fragment);
      ringPaths.push({
        key: fragment.id,
        d: geometry.arcPath(half, ls, le, defaultMetrics),
        source: fragment.source,
        fragmentId: fragment.id,
        title: fragment.title,
        startMinute: fragment.startMinute,
        endMinute: fragment.endMinute,
        active: activeIds.has(fragment.id),
      });
    }
  }

  const barSegments = allFragments.filter(isReal);

  const coveringAtMinute = (m: number) =>
    scene.items.filter(i => i.fragments.some(f => f.startMinute <= m && m < f.endMinute));

  function pointFromEvent(clientX: number, clientY: number) {
    const svg = svgRef.current;
    const rect = svg!.getBoundingClientRect();
    return geometry.toLogical(
      { x: clientX - rect.left, y: clientY - rect.top },
      { width: rect.width, height: rect.height },
    );
  }

  // The start target remains stable even while previews/scenes refresh during a drag.
  function onDialPointerDown(ev: React.PointerEvent<SVGSVGElement>) {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const point = pointFromEvent(ev.clientX, ev.clientY);
    const radius = Math.hypot(point.x - 200, point.y - 200);
    const angle = Math.atan2(point.x - 200, 200 - point.y) * 180 / Math.PI;
    const path = (ev.target as Element).closest('[data-fragment-id]');
    const item = scene.items.find(i => i.fragments.some(f => f.id === path?.getAttribute('data-fragment-id')));
    const h = geometry.hit(point, geometry.pose(focus), defaultMetrics, null);
    dragRef.current = {
      active: true, moved: false, pointerId: ev.pointerId, sx: ev.clientX, sy: ev.clientY,
      anchor: h ? { half: h.half, minuteOfHalf: h.minuteOfHalf } : null,
      initialFocus: focus, lastAngle: angle, delta: 0, startRadius: radius,
      currentRadius: radius, date: scene.date, preview: placementActive,
      item: item?.source === 'plan' && !item.readOnly ? item : null,
    };
    props.onInteractionStart?.();
  }
  function onDialPointerMove(ev: React.PointerEvent<SVGSVGElement>) {
    const st = dragRef.current;
    if (!st.active || ev.pointerId !== st.pointerId) return;
    if (!st.moved) {
      if (Math.hypot(ev.clientX - st.sx, ev.clientY - st.sy) < 5) return;
      st.moved = true;
      try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* detached pointer */ }
    }
    const point = pointFromEvent(ev.clientX, ev.clientY);
    st.currentRadius = Math.hypot(point.x - 200, point.y - 200);
    const angle = Math.atan2(point.x - 200, 200 - point.y) * 180 / Math.PI;
    st.delta += ((angle - st.lastAngle + 540) % 360) - 180;
    st.lastAngle = angle;
    if (st.preview) {
      const hit = geometry.hit(point, geometry.pose(st.initialFocus), defaultMetrics, st.anchor);
      if (hit) {
        st.anchor = { half: hit.half, minuteOfHalf: hit.minuteOfHalf };
        onPlacementMove?.(hit.totalMinute, st.date);
      }
    } else {
      onFocusChange(geometry.rotate(st.initialFocus, st.delta));
    }
  }
  function endDial(ev: React.PointerEvent<SVGSVGElement>, cancelled = false) {
    const st = dragRef.current;
    if (!st.active || ev.pointerId !== st.pointerId) return;
    st.active = false;
    if (!cancelled && st.moved && geometry.pulledOutside(st.startRadius, st.currentRadius)) {
      if (st.preview) props.onCancelPlacement?.();
      else if (st.item) props.onRetractItem?.(st.item);
    }
    if (st.moved) window.setTimeout(() => { if (dragRef.current === st) st.moved = false; }, 0);
  }
  // Wheel over the dial moves the focus 5 minutes (native, non-passive to prevent page scroll) (F05).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (ev: WheelEvent) => {
      ev.preventDefault();
      const scale = ev.deltaMode === 1 ? 3 : 1;
      const dir = ev.deltaY > 0 ? 1 : -1;
      const next = Math.max(0, Math.min(DAY_MINUTES, focusValueRef.current + dir * 5 * scale));
      if (placementActive) onPlacementMove?.(next, scene.date); else onFocusChange(next);
    };
    svg.addEventListener('wheel', handler, { passive: false });
    return () => svg.removeEventListener('wheel', handler);
  }, [onFocusChange, placementActive, onPlacementMove, scene.date]);

  function openCovering(minute: number) {
    setNote({ title: clockLabel(minute), items: coveringAtMinute(minute) });
  }
  function openHour(hour: number) {
    const s = hour * 60, e = s + 60;
    setNote({
      title: clockLabel(hour * 60),
      items: scene.items.filter(i => i.fragments.some(f => f.startMinute < e && f.endMinute > s)),
    });
  }
  function openItem(item: DialItem) {
    setNote({ title: clockLabel(item.startMinute), items: [item] });
  }

  const shift = (delta: number) => {
    const next = Math.max(0, Math.min(DAY_MINUTES, (placementActive ? placementMinute : focus) + delta));
    if (placementActive) onPlacementMove?.(next, scene.date); else onFocusChange(next);
  };

  return (
    <div className="time-dial">
      <div className="dial-caption">
        <span className="eyebrow">TODAY / TIME</span>
        <span className="dial-caption-right">
          {allFragments.some(f => f.source === 'empty') ? (
            <span className="dial-empty-key"><i />红色＝空时间</span>
          ) : null}
          <span>按住表盘旋转 · 指针固定 · 双击改期</span>
        </span>
      </div>

      <div className="dial-layout">
        <div className="day-preview" aria-label="24 小时预览条">
          <span className="preview-title">24H</span>
          <div className="preview-cells">
            {Array.from({ length: 24 }, (_, hour) => (
              <button
                type="button"
                key={hour}
                className="preview-hour"
                title={`${clockLabel(hour * 60)}–${clockLabel((hour + 1) * 60)}`}
                onClick={() => openHour(hour)}
              >
                {hour % 3 === 0 ? String(hour).padStart(2, '0') : ''}
              </button>
            ))}
            {barSegments.map((segment, index) => (
              <button
                type="button"
                key={segment.id}
                className={`preview-schedule ${segment.source}`}
                style={{
                  top: `${(segment.startMinute / DAY_MINUTES) * 100}%`,
                  height: `${Math.max(0.5, ((segment.endMinute - segment.startMinute) / DAY_MINUTES) * 100)}%`,
                  left: `${2 + (index % 3) * 7}px`,
                }}
                aria-label={`查看${segment.title}，${clockLabel(segment.startMinute)}—${clockLabel(segment.endMinute)}`}
                title={`${segment.title} · ${clockLabel(segment.startMinute)}`}
                onClick={() => {
                  const item = scene.items.find(i => i.fragments.some(f => f.id === segment.id));
                  if (item) openItem(item);
                }}
              />
            ))}
            <button
              type="button"
              className="preview-pointer now"
              style={{ top: `${(nowMinute / DAY_MINUTES) * 100}%` }}
              onClick={() => (onResetNow ? onResetNow() : onFocusChange(nowMinute))}
              aria-label={`回到现在 ${clockLabel(nowMinute)}`}
            >
              ▶<span>现在 {clockLabel(nowMinute)}</span>
            </button>
            <span
              className="preview-pointer focus"
              style={{ top: `${(focus / DAY_MINUTES) * 100}%` }}
              aria-label={`指针 ${clockLabel(focus)}`}
            >
              <span>{clockLabel(focus)}</span>◀
            </span>
          </div>
          {note ? (
            <DayOverview title={note.title} date={scene.date} zone={scene.zone}
              items={note.items} onClose={() => setNote(null)} />
          ) : null}
          <small>点色段只读 · 点“现在”复位</small>
        </div>

        <div className="dial-frame">
          <svg
            ref={svgRef}
            className="dial-svg"
            viewBox="0 0 400 400"
            role="img"
            aria-label={`${scene.date} 可旋转双环时间盘，内外两圈分别代表前12小时和后12小时`}
            onPointerDown={onDialPointerDown}
            onPointerMove={onDialPointerMove}
            onPointerUp={ev => endDial(ev)}
            onPointerCancel={ev => endDial(ev, true)}
            onLostPointerCapture={ev => endDial(ev, true)}
          >
            <circle cx="200" cy="200" r="158" className="dial-boundary" />
            <circle cx="200" cy="200" r={defaultMetrics.innerRadius} className="dial-track" />
            <circle cx="200" cy="200" r={defaultMetrics.outerRadius} className="dial-track" />

            <g transform={`rotate(${pose.rotationDegrees} 200 200)`}>
              {Array.from({ length: 12 }, (_, i) => {
                const [x1, y1] = ringPoint(152, i * 30);
                const [x2, y2] = ringPoint(i % 3 ? 158 : 164, i * 30);
                return <line key={`tick${i}`} x1={x1} y1={y1} x2={x2} y2={y2} className="dial-tick" />;
              })}
              {Array.from({ length: 12 }, (_, hour) => {
                const [x, y] = ringPoint(171, hour * 30);
                return (
                  <text key={`num${hour}`} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
                    className="dial-number">
                    {hour === 0 ? 12 : hour}
                  </text>
                );
              })}

              {ringPaths.map(p => (
                <path
                  key={p.key}
                  d={p.d}
                  data-fragment-id={p.fragmentId}
                  className={`dial-segment ${p.source}${p.active ? ' active' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${p.title} ${clockLabel(p.startMinute)}`}
                  onClick={ev => {
                    if (dragRef.current.moved) return; // a rotation drag is not a click
                    const minute = pointerMinuteFromEvent(ev, pointFromEvent, focus);
                    openCovering(minute ?? Math.round((p.startMinute + p.endMinute) / 2));
                  }}
                  onDoubleClick={() => {
                    if (placementActive) { props.onCancelPlacement?.(); return; }
                    if (p.source !== 'plan' && p.source !== 'fixed') return;
                    const item = scene.items.find(i => i.fragments.some(f => f.id === p.fragmentId));
                    if (item) onRescheduleItem?.(item);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openCovering(Math.round((p.startMinute + p.endMinute) / 2));
                    }
                  }}
                />
              ))}

              {gaps.map(g => (
                <path
                  key={g.key}
                  d={geometry.arcPath(g.half, g.start, g.end, defaultMetrics)}
                  className="dial-gap"
                  aria-label="当地时间不存在"
                />
              ))}

              {overlaps.map(o => (
                <path
                  key={o.key}
                  d={geometry.arcPath(o.half, o.start, o.end, defaultMetrics)}
                  className="dial-overlap"
                  aria-hidden="true"
                />
              ))}

              {candidate
                ? candidate.map(f => {
                    const half = halfOf(f);
                    const [ls, le] = localEdges(f);
                    return (
                      <path
                        key={`candidate-${f.id}`}
                        d={geometry.arcPath(half, ls, le, defaultMetrics)}
                        className="dial-candidate"
                        aria-hidden="true"
                        onDoubleClick={() => props.onCancelPlacement?.()}
                      />
                    );
                  })
                : null}
            </g>

            <circle cx="200" cy="200" r="63" className="dial-center" />
            <text x="200" y="183" textAnchor="middle" className="dial-center-label">当前刻度</text>
            <text x="200" y="215" textAnchor="middle" className="dial-center-time">{clockLabel(focus)}</text>
            <text x="200" y="237" textAnchor="middle" className="dial-center-label">
              {focus < HALF_MINUTES ? '前 12 小时' : '后 12 小时'}
            </text>
            <path d="M200 391 L193 378 L207 378 Z" className="dial-viewer" />
          </svg>

          <span className="ring-label ring-label-a">前 12 小时 <strong>00–12</strong></span>
          <span className="ring-label ring-label-b">后 12 小时 <strong>12–24</strong></span>
        </div>
      </div>

      <div className="focus-controls">
        <button type="button" onClick={() => shift(-5)} aria-label="向前 5 分钟">−5 分钟</button>
        <input
          type="range"
          className="dial-slider"
          min={0}
          max={DAY_MINUTES - 5}
          step={5}
          value={focus}
          aria-label="拖动选择时间"
          onChange={e => { const next = Number(e.target.value); if (placementActive) onPlacementMove?.(next, scene.date); else onFocusChange(next); }}
        />
        <button type="button" onClick={() => shift(5)} aria-label="向后 5 分钟">+5 分钟</button>
      </div>
    </div>
  );
}

// Resolve the clicked wall minute from the pointer position (F10).
function pointerMinuteFromEvent(
  ev: React.MouseEvent<SVGPathElement>,
  pointFromEvent: (x: number, y: number) => ReturnType<typeof geometry.toLogical>,
  focus: number,
): number | null {
  const logical = pointFromEvent(ev.clientX, ev.clientY);
  return geometry.hit(logical, geometry.pose(focus), defaultMetrics, null)?.totalMinute ?? null;
}

// Ring-coordinate point (same convention as geometry.polar): clockwise from top.
function ringPoint(radius: number, degrees: number): [number, number] {
  const rad = (degrees * Math.PI) / 180;
  return [200 + radius * Math.sin(rad), 200 - radius * Math.cos(rad)];
}
