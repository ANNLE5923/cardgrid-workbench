import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CardView,
  Command,
  FactView,
  Id,
  PlacementSubject,
  ProductionDayView,
  RecordedRange,
  Token,
} from '../../workspace/index.ts';
import type { TodayClient } from '../../workspace/index.ts';
import { dateAt, displayInstant, nextDate } from '../schedule/time.ts';
import {
  ActualConfirmDialog,
  FactThread,
  FixedUnlockButton,
  PlacementDialog,
  ViewCardDialog,
} from './action-flow.tsx';
import { projectionAdapter, candidateFragments } from '../schedule/time-dial/projection-adapter.ts';
import { TimeDial } from '../schedule/time-dial/TimeDial.tsx';
import { usePlacementSession } from '../schedule/time-dial/use-placement-session.ts';
import { HandFan } from '../hand/HandFan.tsx';
import { handStackKey } from '../hand/stacking.ts';
import type { DialItem } from '../schedule/time-dial/types.ts';
import type { HandPlayRequest } from '../hand/unified.ts';

type Dialog =
  | Readonly<{
      kind: 'place';
      subject: PlacementSubject;
      focus: number;
      date: string;
      zone: string;
    }>
  | Readonly<{
      kind: 'actual';
      instanceId: Id;
      instanceVersion: number;
      planned?: Readonly<{ planId: Id; planVersion: number }>;
      start: Readonly<{ date: string; time: string }>;
      end: Readonly<{ date: string; time: string }>;
    }>
  | null;
const pad = (n: number) => String(n).padStart(2, '0');
const toTime = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const fromTime = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
};
const startLabel = (r: RecordedRange) => r.localStart;
const endLabel = (r: RecordedRange) => r.localEnd;
// localStart is a PlainDateTime "YYYY-MM-DDTHH:mm"; split it into date and minute inputs.
const splitLocal = (s: string) => {
  const [d, t] = s.split('T');
  return { date: d, time: t };
};

export type DayBoardView = Readonly<{
  date: string;
  zone: string;
  focusTime: string;
  followNow: boolean;
}>;

export function DayBoard(
  props: Readonly<{
    client: TodayClient;
    preparationRevision?: number;
    /** App（非 DayBoard 自身）成功提交了会影响表盘投影的命令（如今日收尾面板）后递增。 */
    externalWriteTick?: number;
    initialView?: DayBoardView;
    onViewChange?: (view: DayBoardView) => void;
    handRequest?: HandPlayRequest | null;
    onHandRequestHandled?: () => void;
  }>,
) {
  const { client, preparationRevision, externalWriteTick } = props;
  const initialView = useRef(props.initialView).current;
  const onViewChange = useRef(props.onViewChange);
  onViewChange.current = props.onViewChange;
  const [zone, setZone] = useState('');
  const [date, setDate] = useState('');
  const [focusTime, setFocusTime] = useState(toTime(540));
  const [day, setDay] = useState<ProductionDayView | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<Id | null>(null);
  const [viewCard, setViewCard] = useState<CardView | null>(null);
  const [titles, setTitles] = useState<Record<Id, string>>({});
  const [fixedTitles, setFixedTitles] = useState<Record<Id, string>>({});
  const [handMeta, setHandMeta] = useState<Record<string, { key: string; sourceDate: string }>>({});
  const lock = useRef(false);
  const readSequence = useRef(0);
  const tokenRef = useRef<Token | null>(null);
  const originView = useRef<{ date: string; focus: number; zone: string } | null>(null);
  const [landingNotice, setLandingNotice] = useState<string | null>(null);
  const [unlockTarget, setUnlockTarget] = useState<ProductionDayView['fixed'][number] | null>(null);
  // D024: focus follows now until the user moves it manually; reset-now resumes following.
  const [followNow, setFollowNow] = useState(initialView?.followNow ?? true);
  const followRef = useRef(followNow);
  followRef.current = followNow;

  const loadMeta = useCallback(async () => {
    const r = await client.load();
    if (!r.ok || !r.value.data) return;
    const p = r.value.data.planner;
    setTitles(Object.fromEntries(p.instances.map((i) => [i.id, i.currentContent.title])));
    setFixedTitles(Object.fromEntries(p.fixed.map((f) => [f.id, f.title])));
    setHandMeta(
      Object.fromEntries(
        p.instances
          .filter((i) => i.daily)
          .map((i) => [
            i.id,
            { key: handStackKey(i, r.value.data!), sourceDate: i.daily!.sourceDate },
          ]),
      ),
    );
  }, [client]);

  // The app may restore a manual browsing session. Following now resumes at the real current instant.
  useEffect(() => {
    let alive = true;
    void client.load().then((r) => {
      if (!alive) return;
      if (!r.ok) {
        setError(r.message);
        return;
      }
      tokenRef.current = r.value.token;
      const z = initialView?.zone ?? r.value.data?.settings.zone ?? 'UTC';
      const nowIso = new Date().toISOString();
      setZone(z);
      setDate(initialView && !initialView.followNow ? initialView.date : dateAt(nowIso, z));
      setFocusTime(
        initialView && !initialView.followNow
          ? initialView.focusTime
          : toTime(displayInstant(nowIso, z).minute),
      );
    });
    return () => {
      alive = false;
    };
  }, [client, initialView]);

  useEffect(() => {
    if (date && zone) onViewChange.current?.({ date, zone, focusTime, followNow });
  }, [date, zone, focusTime, followNow]);

  const reloadDay = useCallback(async () => {
    if (!zone || !date) return;
    const sequence = ++readSequence.current;
    await loadMeta();
    const r = await client.readDay({ date, zone });
    if (sequence !== readSequence.current) return;
    if (r.ok) setDay(r.value);
    else setError(r.message);
  }, [client, zone, date, loadMeta]);

  // PrepareDay is submitted by the app. Other local writes refresh their own
  // projection once; a second subscription refresh can remove the focus target.
  // App-level writes that DayBoard did not submit itself (today close panel,
  // references) are signalled via externalWriteTick so the board never goes stale.
  useEffect(() => {
    void reloadDay();
  }, [reloadDay, preparationRevision, externalWriteTick]);

  // D024/B25: detect the real date crossing midnight. Following now advances the view;
  // manual mode keeps the viewed date and only shows a "new day" notice.
  const [midnightNotice, setMidnightNotice] = useState<string | null>(null);
  const lastTodayRef = useRef<string | null>(null);
  useEffect(() => {
    if (!zone) return;
    const tick = () => {
      const nowIso = new Date().toISOString();
      const today = dateAt(nowIso, zone);
      if (lastTodayRef.current === null) {
        lastTodayRef.current = today;
        return;
      }
      if (today === lastTodayRef.current) return;
      lastTodayRef.current = today;
      if (followRef.current && !operationRef.current) {
        setFocusTime(toTime(displayInstant(nowIso, zone).minute));
        setDate(today);
      } else {
        setMidnightNotice(`已跨午夜，进入新一天 ${today}（当前仍查看 ${date}）`);
      }
    };
    const id = window.setInterval(tick, 20000);
    return () => window.clearInterval(id);
  }, [zone, date]);

  // reset-now: resume following and jump to the current instant (D024).
  const resetNow = useCallback(() => {
    if (!zone) return;
    const nowIso = new Date().toISOString();
    placement.release();
    setDialog(null);
    originView.current = null;
    setLandingNotice(null);
    setMidnightNotice(null);
    setFollowNow(true);
    setDate(dateAt(nowIso, zone));
    setFocusTime(toTime(displayInstant(nowIso, zone).minute));
  }, [zone]);

  // Any manual focus move stops following now until reset-now (D024). The reading cursor
  // may reach 24:00 (end of day display); the controller converts placement per D023.
  function handleFocusChange(f: number) {
    setFollowNow(false);
    setFocusTime(toTime(Math.max(0, Math.min(1440, f))));
  }

  // React to authoritative changes: an epoch replacement must discard this
  // component's local dialog / unlock choices, since they belong to the old
  // workspace; a same-epoch external revision only refreshes the projection.
  useEffect(() => {
    let alive = true;
    const sync = async (external: boolean) => {
      if (external) {
        // Revisions invalidate permissions, but keep the user's time inputs.
        // The App keys this page by epoch so workspace replacement clears it
        // in the same render as the replacement notice.
        client.invalidateCapabilities();
        setConfirmCancel(null);
      }
      const r = await client.load();
      if (!alive || !r.ok) return;
      const prev = tokenRef.current;
      tokenRef.current = r.value.token;
      if (!prev) {
        if (external) await reloadDay();
        return;
      }
      if (r.value.token.epoch !== prev.epoch) {
        setDialog(null);
        setConfirmCancel(null);
        const z = r.value.data?.settings.zone ?? 'UTC';
        setZone(z);
        await loadMeta();
        const dr = await client.readDay({ date, zone: z });
        if (!alive) return;
        if (dr.ok) setDay(dr.value);
        else setError(dr.message);
      } else if (external && r.value.token.revision !== prev.revision) {
        await reloadDay();
      }
    };
    const unsubscribe = client.subscribe(sync);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [client, reloadDay, loadMeta, date]);

  async function submitSimple(type: Command['type'], payload: unknown): Promise<boolean> {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError(null);
    const load = await client.load();
    if (!load.ok) {
      setError(load.message);
      setBusy(false);
      lock.current = false;
      return false;
    }
    const cmd = {
      commandId: crypto.randomUUID(),
      expected: load.value.token,
      type,
      payload,
    } as Command;
    const r = await client.submit(cmd);
    setBusy(false);
    lock.current = false;
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    await reloadDay();
    return true;
  }

  const focus = fromTime(focusTime);
  // The dial consumes the same authoritative projection as the lists; it never recomputes occupancy.
  const scene =
    day && day.date === date && day.zone === zone ? projectionAdapter.buildScene(day) : null;

  // One gesture-driven placement session for the whole day view (single controller).
  const placement = usePlacementSession(client);
  const operationRef = useRef(false);
  operationRef.current =
    !!dialog ||
    !!viewCard ||
    !!unlockTarget ||
    ['preparing', 'preview', 'committing'].includes(placement.state.status);
  function beginInteraction() {
    followRef.current = false;
    setFollowNow(false);
    originView.current ??= { date, focus, zone };
  }
  async function showLanding(targetDate: string, targetFocus: number) {
    if (targetDate === date) return true;
    const sequence = ++readSequence.current;
    const result = await client.readDay({ date: targetDate, zone });
    if (sequence !== readSequence.current) return false;
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    setDay(result.value);
    setDate(targetDate);
    setFocusTime(toTime(targetFocus));
    return true;
  }
  function restoreOrigin() {
    const origin = originView.current;
    originView.current = null;
    setLandingNotice(null);
    if (origin) {
      readSequence.current++;
      setDate(origin.date);
      setFocusTime(toTime(origin.focus));
    }
  }
  function cancelPlacement() {
    placement.release();
    restoreOrigin();
  }
  useEffect(() => {
    if (
      !placement.state.subject ||
      placement.state.status === 'idle' ||
      placement.state.status === 'committed'
    )
      return;
    const target = placement.state.date;
    if (target && target !== date && originView.current) {
      const origin = originView.current;
      void showLanding(target, 0).then((ok) => {
        if (ok && originView.current === origin)
          setLandingNotice(origin.date + ' 24:00 → ' + target + ' 00:00（未保存）');
      });
    }
  }, [placement.state.date]);
  useEffect(() => {
    if (placement.state.status === 'idle' && originView.current && !dialog) restoreOrigin();
  }, [placement.state.status, dialog]);
  useEffect(
    () =>
      client.subscribe((external) => {
        if (external) {
          readSequence.current++;
          setDialog((d) => (d?.kind === 'place' ? null : d));
          setUnlockTarget(null);
          cancelPlacement();
        }
      }),
    [client],
  );

  // Opening any other write dialog must end the gesture session so two committable
  // sessions never coexist (F04).
  useEffect(() => {
    if (dialog) placement.release();
  }, [dialog]);

  // After an external revision the Host cleared capabilities; release the gesture
  // session when the projected scene token no longer matches its preview token (F04).
  const previewTokenKey = placement.state.preview
    ? `${placement.state.preview.token.epoch}:${placement.state.preview.token.revision}`
    : '';
  const sceneTokenKey = scene ? `${scene.token.epoch}:${scene.token.revision}` : '';
  useEffect(() => {
    if (previewTokenKey && sceneTokenKey && previewTokenKey !== sceneTokenKey) placement.release();
  }, [sceneTokenKey]);
  const dialWrapRef = useRef<HTMLDivElement | null>(null);
  const sessionCandidate =
    placement.state.preview?.candidates.find((c) => c.id === placement.state.chosen) ?? null;
  const dialCandidate =
    sessionCandidate &&
    scene &&
    placement.state.date === scene.date &&
    placement.state.zone === scene.zone &&
    previewTokenKey === sceneTokenKey
      ? candidateFragments(sessionCandidate)
      : null;
  // While a gesture preview is active, dragging directly on the dial moves the landing (contract §6).
  const placementActive =
    ['preparing', 'preview'].includes(placement.state.status) && !!placement.state.subject;
  const placementLanding = sessionCandidate
    ? displayInstant(sessionCandidate.range.startAt, zone || 'UTC')
    : null;
  const placementMinute = placementLanding?.minute ?? focus;
  function handlePlacementMove(minute: number, originDate = date) {
    // Dial slide reports continuous minutes; snap to the 5-minute grid before requesting.
    const snapped = Math.max(0, Math.min(1440, Math.round(minute / 5) * 5));
    void placement.moveTo(
      snapped === 1440 ? nextDate(originDate) : originDate,
      snapped === 1440 ? 0 : snapped,
    );
  }
  const getDialRect = useCallback(
    () =>
      (
        dialWrapRef.current?.querySelector('.dial-svg') as SVGSVGElement | null
      )?.getBoundingClientRect() ?? null,
    [],
  );

  function openPlacement(subject: PlacementSubject) {
    beginInteraction();
    placement.release();
    const snapped = Math.max(0, Math.min(1440, Math.round(focus / 5) * 5));
    const landingDate = snapped === 1440 ? nextDate(date) : date;
    const landingFocus = snapped === 1440 ? 0 : snapped;
    setDialog({ kind: 'place', subject, focus: landingFocus, date: landingDate, zone });
    if (landingDate !== date)
      void showLanding(landingDate, landingFocus).then((ok) => {
        if (ok) setLandingNotice(date + ' 24:00 → ' + landingDate + ' 00:00（未保存）');
      });
  }
  function placeHand(card: ProductionDayView['hand'][number]) {
    openPlacement({ kind: 'hand', instanceId: card.instanceId, version: card.version });
  }
  const handledHandRequest = useRef('');
  const handRequestHandled = useRef(props.onHandRequestHandled);
  handRequestHandled.current = props.onHandRequestHandled;
  useEffect(() => {
    const request = props.handRequest;
    if (!request || !date || !zone || handledHandRequest.current === request.requestId) return;
    let active = true;
    void client.readDay({ date, zone }).then((result) => {
      if (!active) return;
      handledHandRequest.current = request.requestId;
      handRequestHandled.current?.();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      if (
        result.value.token.epoch !== request.token.epoch ||
        result.value.token.revision !== request.token.revision
      ) {
        setError('手牌已更新，请重新选择');
        return;
      }
      const selected = request.item.selection;
      const card =
        selected.kind === 'legacy'
          ? result.value.hand.find(
              (c) => c.instanceId === selected.instanceId && c.version === request.item.version,
            )
          : undefined;
      if (!card) {
        setError('这份手牌已不在手中，请重新选择');
        return;
      }
      // Same existing preview/confirm command path as the fan. Opening does not save.
      setViewCard(null);
      setUnlockTarget(null);
      openPlacement({ kind: 'hand', instanceId: card.instanceId, version: card.version });
    });
    return () => {
      active = false;
    };
  }, [props.handRequest, client, date, zone]);
  function movePlan(plan: ProductionDayView['plans'][number]) {
    openPlacement({ kind: 'plan', planId: plan.planId, version: plan.version });
  }
  function retract(plan: ProductionDayView['plans'][number]) {
    void submitSimple('RetractPlan', { planId: plan.planId, version: plan.version });
  }
  function confirmActual(plan: ProductionDayView['plans'][number]) {
    const range = plan.range as RecordedRange;
    setDialog({
      kind: 'actual',
      instanceId: plan.instanceId,
      instanceVersion: plan.instanceVersion,
      planned: { planId: plan.planId, planVersion: plan.version },
      start: splitLocal(startLabel(range)),
      end: splitLocal(endLabel(range)),
    });
  }
  // Unplanned actual: record what happened without creating a plan first. This is
  // the only entry for no-duration hand cards (打出 would require a duration).
  function recordActualUnplanned(card: ProductionDayView['hand'][number]) {
    const startMin = focus === 1440 ? 0 : focus;
    const actualDate = focus === 1440 ? nextDate(date) : date;
    const endTotal = startMin + (card.presetMinutes ?? 30);
    const dayShift = Math.floor(endTotal / 1440);
    setDialog({
      kind: 'actual',
      instanceId: card.instanceId,
      instanceVersion: card.version,
      start: { date: actualDate, time: toTime(startMin) },
      end: {
        date: dayShift ? nextDate(actualDate, dayShift) : actualDate,
        time: toTime(endTotal % 1440),
      },
    });
  }
  function onFixedUnlocked(fixed: ProductionDayView['fixed'][number], unlockId: Id) {
    setUnlockTarget(null);
    openPlacement({
      kind: 'fixed',
      commitmentId: fixed.commitmentId,
      version: fixed.version,
      unlockId,
    });
  }
  // Double-click a dial arc: plans open the placement dialog directly; fixed unlock first (F05).
  function rescheduleItem(item: DialItem) {
    if (item.source === 'plan') {
      const p = day?.plans.find((x) => x.planId === item.id);
      if (p) movePlan(p);
    } else if (item.source === 'fixed') {
      const f = day?.fixed.find((x) => x.commitmentId === item.id);
      if (f) {
        cancelPlacement();
        setUnlockTarget(f);
        setFollowNow(false);
      }
    }
  }
  async function unlockForReschedule(fixed: ProductionDayView['fixed'][number]) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    const load = await client.load();
    if (!load.ok) {
      setError(load.message);
      setBusy(false);
      lock.current = false;
      return;
    }
    const unlock = await client.unlockFixed({
      token: load.value.token,
      commitmentId: fixed.commitmentId,
      version: fixed.version,
    });
    setBusy(false);
    lock.current = false;
    if (!unlock.ok) {
      setError(unlock.message);
      return;
    }
    onFixedUnlocked(fixed, unlock.value);
  }
  async function cancelFixed(fixed: ProductionDayView['fixed'][number]) {
    if (confirmCancel !== fixed.commitmentId) {
      setConfirmCancel(fixed.commitmentId);
      return;
    }
    setConfirmCancel(null);
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    const load = await client.load();
    if (!load.ok) {
      setError(load.message);
      setBusy(false);
      lock.current = false;
      return;
    }
    const unlock = await client.unlockFixed({
      token: load.value.token,
      commitmentId: fixed.commitmentId,
      version: fixed.version,
    });
    if (!unlock.ok) {
      setError(unlock.message);
      setBusy(false);
      lock.current = false;
      return;
    }
    const cmd = {
      commandId: crypto.randomUUID(),
      expected: load.value.token,
      type: 'CancelFixed',
      payload: {
        commitment: { id: fixed.commitmentId, version: fixed.version },
        unlockId: unlock.value,
      },
    } as Command;
    const r = await client.submit(cmd);
    setBusy(false);
    lock.current = false;
    if (!r.ok) {
      setError(r.message);
      return;
    }
    await reloadDay();
  }

  return (
    <div className="dayboard">
      <div className="dayboard-controls toolbar">
        <label>
          日期
          <input
            type="date"
            aria-label="日期"
            value={date}
            disabled={!date}
            onChange={(e) => {
              followRef.current = false;
              setFollowNow(false);
              placement.release();
              setDialog(null);
              originView.current = null;
              setLandingNotice(null);
              readSequence.current++;
              setDate(e.target.value);
            }}
          />
        </label>
        <label>
          时区
          <input
            type="text"
            aria-label="时区"
            value={zone}
            onChange={(e) => {
              followRef.current = false;
              setFollowNow(false);
              cancelPlacement();
              setDialog(null);
              setUnlockTarget(null);
              readSequence.current++;
              setZone(e.target.value);
              lastTodayRef.current = null;
            }}
          />
        </label>
        <label>
          默认落点
          <input
            type="time"
            step="300"
            aria-label="默认落点"
            value={focusTime}
            onChange={(e) => {
              setFollowNow(false);
              setFocusTime(e.target.value);
            }}
          />
        </label>
      </div>
      {error ? (
        <div className="message" role="alert">
          <span>{error}</span>
          <button aria-label="关闭提示" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      ) : null}
      {day && !day.occupancyKnown ? (
        <div className="message">
          <span>当前占用无法完全判定（缺时区或有未保存模板）；排期前请先在配置里确定时区。</span>
        </div>
      ) : null}
      {landingNotice ? (
        <div className="message" role="status">
          {landingNotice}
        </div>
      ) : null}
      {unlockTarget ? (
        <div className="message" role="status">
          <span>固定安排需要解锁后才能改期。</span>
          <button onClick={() => void unlockForReschedule(unlockTarget)}>解锁并调整</button>
          <button onClick={() => setUnlockTarget(null)}>取消</button>
        </div>
      ) : null}
      {midnightNotice ? (
        <div className="message" role="status">
          <span>{midnightNotice}</span>
          <button aria-label="关闭提示" onClick={() => setMidnightNotice(null)}>
            ×
          </button>
        </div>
      ) : null}

      {scene ? (
        <div ref={dialWrapRef}>
          <TimeDial
            scene={scene}
            focus={focus}
            candidate={dialCandidate}
            placementActive={placementActive}
            placementMinute={placementMinute}
            onPlacementMove={handlePlacementMove}
            onCancelPlacement={cancelPlacement}
            onInteractionStart={() => {
              followRef.current = false;
              setFollowNow(false);
            }}
            onRetractItem={(item) => {
              const plan = day?.plans.find((p) => p.planId === item.id);
              if (plan) retract(plan);
            }}
            onFocusChange={handleFocusChange}
            onResetNow={resetNow}
            onRescheduleItem={(item) => void rescheduleItem(item)}
          />
        </div>
      ) : null}

      <section>
        <div className="sectiontitle">
          <h2>手牌（{day?.hand.length ?? 0}）</h2>
        </div>
        {day ? (
          <HandFan
            hand={day.hand}
            handMeta={handMeta}
            date={date}
            zone={zone}
            session={placement}
            onInteractionStart={beginInteraction}
            onGestureStart={() => {
              followRef.current = false;
              setFollowNow(false);
            }}
            onCancel={cancelPlacement}
            getFocus={() => focus}
            getDialRect={getDialRect}
            onView={(c) => {
              cancelPlacement();
              setViewCard(c);
            }}
            onPlace={(c) => placeHand(c)}
            onRecordActual={(c) => recordActualUnplanned(c)}
            onCommitted={async () => {
              const savedDate = placement.state.date;
              originView.current = null;
              setLandingNotice(null);
              if (savedDate !== date) await showLanding(savedDate, placementMinute);
              else await reloadDay();
            }}
          />
        ) : null}
      </section>

      <section>
        <div className="sectiontitle">
          <h2>已排计划（{day?.plans.length ?? 0}）</h2>
        </div>
        {day?.plans.length ? (
          <div className="dayboard-list">
            {day.plans.map((p) => (
              <div key={p.planId} className="dayboard-row">
                <span className="dayboard-name">{titles[p.instanceId] ?? p.instanceId}</span>
                <span className="dayboard-time">
                  {startLabel(p.range as RecordedRange)}—{endLabel(p.range as RecordedRange)}
                </span>
                <span className="dayboard-actions">
                  <button
                    type="button"
                    className="act-mini"
                    disabled={busy}
                    onClick={() => movePlan(p)}
                  >
                    改期
                  </button>
                  <button
                    type="button"
                    className="act-mini"
                    disabled={busy}
                    onClick={() => retract(p)}
                  >
                    撤回手牌
                  </button>
                  <button
                    type="button"
                    className="act-mini"
                    disabled={busy}
                    onClick={() => confirmActual(p)}
                  >
                    确认实际
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="emptyline">当天没有已排计划。</p>
        )}
      </section>

      <section>
        <div className="sectiontitle">
          <h2>固定安排（{day?.fixed.length ?? 0}）</h2>
        </div>
        {day?.fixed.length ? (
          <div className="dayboard-list">
            {day.fixed.map((f) => (
              <div key={f.commitmentId} className="dayboard-row">
                <span className="dayboard-name">
                  {fixedTitles[f.commitmentId] ?? f.commitmentId}
                </span>
                <span className="dayboard-time">
                  {startLabel(f.range as RecordedRange)}—{endLabel(f.range as RecordedRange)}
                </span>
                <span className="dayboard-actions">
                  <FixedUnlockButton
                    client={client}
                    commitment={{ id: f.commitmentId, version: f.version }}
                    disabled={busy}
                    onUnlocked={(unlockId) => onFixedUnlocked(f, unlockId)}
                  />
                  <button
                    type="button"
                    className={`act-mini${confirmCancel === f.commitmentId ? ' danger' : ''}`}
                    disabled={busy}
                    onClick={() => void cancelFixed(f)}
                  >
                    {confirmCancel === f.commitmentId ? '再点一次确认取消' : '取消安排'}
                  </button>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="emptyline">当天没有固定安排。</p>
        )}
      </section>

      <section>
        <div className="sectiontitle">
          <h2>事实（{day?.facts.length ?? 0}）</h2>
        </div>
        {day ? (
          <FactThread
            client={client}
            facts={day.facts}
            zone={zone}
            onChanged={() => {
              void reloadDay();
            }}
          />
        ) : null}
      </section>

      {dialog?.kind === 'place' ? (
        <PlacementDialog
          client={client}
          subject={dialog.subject}
          date={dialog.date}
          zone={dialog.zone}
          initialFocusMinuteOfDay={dialog.focus}
          onCommitted={async () => {
            const savedDate = dialog.date;
            originView.current = null;
            setLandingNotice(null);
            if (savedDate !== date) await showLanding(savedDate, dialog.focus);
            else await reloadDay();
            setDialog(null);
          }}
          onClose={() => {
            setDialog(null);
            restoreOrigin();
          }}
        />
      ) : null}
      {dialog?.kind === 'actual' ? (
        <ActualConfirmDialog
          client={client}
          zone={zone}
          instanceId={dialog.instanceId}
          instanceVersion={dialog.instanceVersion}
          planned={dialog.planned}
          initialStart={dialog.start}
          initialEnd={dialog.end}
          onConfirmed={async () => {
            await reloadDay();
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {viewCard ? (
        <ViewCardDialog
          card={viewCard}
          onClose={() => setViewCard(null)}
          onPlace={(c) => {
            setViewCard(null);
            placeHand(c);
          }}
        />
      ) : null}
    </div>
  );
}
