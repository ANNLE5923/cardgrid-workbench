import { displayInstant, elapsedMinutes, splitRangeForDay } from '../../action-time.ts';
import type { Candidate, Id, ProductionDayView, Range, Segment } from '../../action-contract.ts';
import type {
  AxisPiece,
  DialFragment,
  DialItem,
  DialProjectionPort,
  DialScene,
  DialSource,
} from './types.ts';

const HALF_MINUTES = 720;
const DAY_MINUTES = 1440;

type MutableItem = {
  source: DialSource;
  id: Id;
  title: string;
  color: string;
  startMinute: number;
  endMinute: number;
  fragments: DialFragment[];
  range?: Range;
  detail?: string;
  readOnly?: boolean;
  legacy?: boolean;
};

const SEMANTIC_COLOR: Record<DialSource, string> = {
  plan: 'var(--planned)',
  fixed: 'var(--fixed)',
  fact: 'var(--fact)',
  'plan-reference': 'var(--reference)',
  empty: 'var(--empty)',
  legacy: 'var(--reference)',
  'projected-readonly': 'var(--reference)',
};

function absoluteMinute(seg: Segment, edge: 'start' | 'end'): number {
  const local = edge === 'start' ? seg.startMinuteOfHalf : seg.endMinuteOfHalf;
  return seg.half * HALF_MINUTES + local;
}

// Unprepared day-template projections are read-only previews, never saved fixed sources (N06).
function effectiveSource(seg: Segment, day?: ProductionDayView): DialSource {
  if (seg.kind === 'fixed' && day && !day.fixed.some(f => f.commitmentId === seg.sourceId)) {
    return 'projected-readonly';
  }
  return seg.kind;
}

function segmentFragment(seg: Segment, day?: ProductionDayView): DialFragment {
  const source = effectiveSource(seg, day);
  const startMinute = absoluteMinute(seg, 'start');
  const endMinute = absoluteMinute(seg, 'end');
  const readOnly =
    source === 'empty' ||
    source === 'plan-reference' ||
    source === 'projected-readonly' ||
    seg.locked;
  return {
    source,
    id: seg.id,
    title: seg.title,
    color: SEMANTIC_COLOR[source],
    startMinute,
    endMinute,
    range: seg.clippedRange,
    dayStart: seg.startDate,
    dayEnd: seg.startDate,
    detail: seg.label,
    readOnly,
  };
}

// Absolute wall minutes spanned by one constant-offset slice inside the viewed day.
function sliceWall(slice: ReturnType<typeof splitRangeForDay>[number], zone: string) {
  const absStart = displayInstant(slice.range.startAt, zone).minute;
  const absEnd = absStart + elapsedMinutes(slice.range);
  return { absStart, absEnd };
}

// Legacy entries reuse the authoritative slicer: minute precision, DST and cross-day intact (F02).
function legacyFragments(
  li: ProductionDayView['legacyItems'][number],
  date: string,
  zone: string,
): DialFragment[] {
  if (!li.range) return [];
  const slices = splitRangeForDay(li.range, date, zone);
  return slices.map((slice, i) => {
    const { absStart, absEnd } = sliceWall(slice, zone);
    return {
      source: 'legacy' as const,
      id: JSON.stringify(['legacy', li.source.sourceId, li.source.path, i]),
      title: li.title,
      color: SEMANTIC_COLOR.legacy,
      startMinute: absStart,
      endMinute: absEnd,
      range: slice.range,
      detail: `旧来源只读 · ${slice.offset}`,
      readOnly: true,
      legacy: true,
    };
  });
}

const pad2 = (n: number) => String(Math.floor(n / 60)).padStart(2, '0');
const minute2 = (n: number) => String(Math.round(n % 60)).padStart(2, '0');
const clockShort = (n: number) => `${pad2(n)}:${minute2(n)}`;

export const projectionAdapter: DialProjectionPort = {
  buildScene(day: ProductionDayView): DialScene {
    // Group by (role namespace, sourceId): same id in plan/fixed/fact/reference never merges (F09).
    const items = new Map<string, MutableItem>();

    const addFragment = (
      key: string,
      fragment: DialFragment,
      init: Omit<MutableItem, 'fragments'>,
    ) => {
      const existing = items.get(key);
      if (existing) {
        existing.fragments.push(fragment);
        existing.startMinute = Math.min(existing.startMinute, fragment.startMinute);
        existing.endMinute = Math.max(existing.endMinute, fragment.endMinute);
      } else {
        items.set(key, { ...init, fragments: [fragment] });
      }
    };

    for (const seg of day.segments) {
      const source = effectiveSource(seg, day);
      const fragment = segmentFragment(seg, day);
      if (seg.kind === 'empty' || !seg.sourceId) {
        // Empty-time arcs are derived (no source id); each is its own red item.
        addFragment(JSON.stringify(['empty', seg.id]), fragment, {
          source: 'empty',
          id: seg.id,
          title: seg.title,
          color: SEMANTIC_COLOR.empty,
          startMinute: fragment.startMinute,
          endMinute: fragment.endMinute,
          range: seg.clippedRange,
          detail: seg.label,
          readOnly: true,
        });
      } else {
        addFragment(JSON.stringify([source, seg.sourceId]), fragment, {
          source,
          id: seg.sourceId,
          title: seg.title,
          color: SEMANTIC_COLOR[source],
          startMinute: fragment.startMinute,
          endMinute: fragment.endMinute,
          range: seg.sourceRange, // full source range; fragments carry the day-clipped ranges
          detail: seg.label,
          readOnly: fragment.readOnly,
        });
      }
    }

    // Legacy read-only entries: identity includes the full LegacyRef (sourceId + path).
    day.legacyItems.forEach(li => {
      const fragments = legacyFragments(li, day.date, day.zone);
      if (!fragments.length) return;
      const key = JSON.stringify(['legacy', li.source.sourceId, li.source.path]);
      addFragment(key, fragments[0], {
        source: 'legacy',
        id: key,
        title: li.title,
        color: SEMANTIC_COLOR.legacy,
        startMinute: fragments[0].startMinute,
        endMinute: fragments[0].endMinute,
        range: li.range ?? undefined,
        detail: '旧来源只读',
        readOnly: true,
        legacy: true,
      });
      for (let i = 1; i < fragments.length; i++) {
        const f = fragments[i];
        addFragment(key, f, {
          source: 'legacy',
          id: key,
          title: li.title,
          color: SEMANTIC_COLOR.legacy,
          startMinute: f.startMinute,
          endMinute: f.endMinute,
          range: li.range ?? undefined,
          detail: '旧来源只读',
          readOnly: true,
          legacy: true,
        });
      }
    });

    // Axis = valid wall intervals of this day, sliced at noon and offset transitions (F08/N03).
    // Absolute wall minutes are stored so a spring-forward gap is simply omitted.
    const axis: AxisPiece[] = splitRangeForDay(day.dayRange, day.date, day.zone).map(slice => {
      const { absStart, absEnd } = sliceWall(slice, day.zone);
      const half = slice.half === 0 ? 'inner' : 'outer';
      return { half, label: `${clockShort(absStart)}—${clockShort(absEnd)}`, startMinute: absStart, endMinute: absEnd };
    });

    return {
      date: day.date,
      zone: day.zone,
      token: day.token,
      dayRange: { start: day.dayRange.startAt, end: day.dayRange.endAt },
      items: Array.from(items.values()),
      axis,
      hand: day.hand,
      freeRanges: day.freeRanges,
      facts: day.facts,
      legacyItems: day.legacyItems,
      now: day.now,
      occupancyKnown: day.occupancyKnown,
      legacy: day.mode === 'legacy-readonly',
      projected: false,
      version: '3A-dial-1',
      source: 'readDay',
    };
  },

  // Half-open occupancy: a fragment covers focus when start <= focus < end.
  focusFragments(scene: DialScene, focus: number): readonly DialFragment[] {
    const result: DialFragment[] = [];
    for (const item of scene.items) {
      for (const fragment of item.fragments) {
        if (fragment.startMinute <= focus && focus < fragment.endMinute) result.push(fragment);
      }
    }
    return result;
  },

  // Hour overview uses real fragment intersection, never an item bounding box (N04).
  hourOverview(scene: DialScene, hour: number): readonly DialItem[] {
    const s = hour * 60;
    const e = s + 60;
    return scene.items.filter(item =>
      item.fragments.some(f => f.startMinute < e && f.endMinute > s),
    );
  },
};

// Convert a placement candidate's projected segments to dial fragments for the live overlay.
export function candidateFragments(candidate: Candidate): readonly DialFragment[] {
  return candidate.segments.map(seg => segmentFragment(seg));
}
