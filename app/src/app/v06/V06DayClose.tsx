import { useMemo, useState } from 'react';
import type { DataV5 } from '../../workspace/v06.ts';
import type { DayView, Id } from '../../workspace/index.ts';
import { buildCloseChecklistFromV5 } from '../../daily/index.ts';
import type {
  CloseChecklist,
  LockedUnverifiedPlan,
  RetainedHandItem,
  UnverifiedPlan,
  WithdrawBlockedReason,
} from '../../daily/index.ts';
import './v06-day-close.css';

export type DayCloseAction = 'RetractPlan' | 'WithdrawInstance' | 'CreateMakeup';

const lockedLabels: Record<LockedUnverifiedPlan['lockedReason'], string> = {
  'past-occurrence': '例行原日已锁定，不能就地确认 / 撤回，可在下方向前补做',
  'material-expired': '绑定素材已到期，确认 / 撤回 / 改期都会被拒，等“归档到期副本”统一收回',
  'historical-readonly': '历史日期只读，这里不提供修改',
};

const withdrawLabels: Record<NonNullable<WithdrawBlockedReason>, string> = {
  'past-occurrence': '过去例行，不能收回',
  'fact-locked': '已确认发生，不能收回',
  'already-planned': '已排进表盘，先撤回安排',
  'instance-closed': '实例已关闭',
  expired: '已到期',
};

const kindLabels = { action: '行动', answer: '答案', composite: '合成', entry: '记录' } as const;

const fmtTime = (at: string, zone: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(at));

const fmtRange = (range: UnverifiedPlan['range'], zone: string) =>
  `${fmtTime(range.startAt, zone)}–${fmtTime(range.endAt, zone)}`;

export function V06DayClose({
  data,
  day,
  now,
  busy,
  onAction,
  onFocusBoard,
  onClose,
}: Readonly<{
  data: DataV5;
  day: DayView;
  now: string;
  busy: boolean;
  onAction: (type: DayCloseAction, payload: unknown) => void | Promise<unknown>;
  onFocusBoard: (focusTime: string) => void;
  onClose: () => void;
}>) {
  const checklist: CloseChecklist = useMemo(
    () => buildCloseChecklistFromV5(data, day, now),
    [data, day, now],
  );
  const [celebrated, setCelebrated] = useState(false);
  const reduceMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const planVersion = (planId: Id) => day.plans.find((p) => p.planId === planId)?.version;
  const instanceVersion = (instanceId: Id) =>
    data.planner.instances.find((i) => i.id === instanceId)?.version;

  const focusPlan = (plan: UnverifiedPlan) => {
    onFocusBoard(fmtTime(plan.range.startAt, checklist.zone));
    onClose();
  };

  return (
    <section className="v06-day-close" aria-label="结束今天收尾面板" data-testid="day-close-panel">
      <header className="v06-day-close-head">
        <h2>结束今天 · {checklist.date}</h2>
        <button type="button" onClick={onClose}>
          收起
        </button>
      </header>

      <p className="v06-day-close-recap">
        已实际确认 <strong>{checklist.recap.actualConfirmedCount}</strong> 项 · 实际{' '}
        <strong>{checklist.recap.actualMinutes}</strong> 分钟 · 表盘上还有{' '}
        <strong>{checklist.recap.activePlanCount}</strong> 项安排
      </p>

      {checklist.unverified.length > 0 && (
        <div className="v06-day-close-block" data-block="unverified">
          <h3>还有 {checklist.unverified.length} 项安排过了时间、没确认</h3>
          <p className="v06-day-close-hint">
            超时不等于没发生。确认真实发生、撤回，或改期；处理完才能收尾（不会替你编造事实）。
          </p>
          <ul>
            {checklist.unverified.map((plan) => (
              <li key={plan.planId} data-plan-id={plan.planId}>
                <span className="v06-day-close-title">
                  {plan.title}
                  {plan.continuesBefore && <em className="v06-day-close-tag">跨午夜延续</em>}
                </span>
                <span className="v06-day-close-time">{fmtRange(plan.range, checklist.zone)}</span>
                <span className="v06-day-close-actions">
                  <button type="button" disabled={busy} onClick={() => focusPlan(plan)}>
                    确认 / 改期
                  </button>
                  <button
                    type="button"
                    disabled={busy || planVersion(plan.planId) === undefined}
                    onClick={() =>
                      void onAction('RetractPlan', {
                        planId: plan.planId,
                        version: planVersion(plan.planId)!,
                      })
                    }
                  >
                    撤回安排
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {checklist.lockedUnverified.length > 0 && (
        <div className="v06-day-close-block" data-block="locked">
          <h3>只读提醒（{checklist.lockedUnverified.length}）· 不阻塞收尾</h3>
          <ul>
            {checklist.lockedUnverified.map((plan) => (
              <li key={plan.planId} data-plan-id={plan.planId} className="is-locked">
                <span className="v06-day-close-title">{plan.title}</span>
                <span className="v06-day-close-time">{fmtRange(plan.range, checklist.zone)}</span>
                <span className="v06-day-close-reason">{lockedLabels[plan.lockedReason]}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {checklist.routines.some((r) => r.makeupEligible) && (
        <div className="v06-day-close-block" data-block="makeup">
          <h3>过去例行可向前补做</h3>
          <ul>
            {checklist.routines
              .filter((r) => r.makeupEligible)
              .map((r) => (
                <li key={r.occurrenceId} data-occurrence-id={r.occurrenceId}>
                  <span className="v06-day-close-title">{r.date} 的例行安排</span>
                  <span className="v06-day-close-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void onAction('CreateMakeup', {
                          occurrence: { kind: 'occurrence', id: r.occurrenceId },
                          targetDate: checklist.date,
                        })
                      }
                    >
                      补做到今天
                    </button>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}

      {checklist.hand.length > 0 && (
        <div className="v06-day-close-block" data-block="hand">
          <h3>仍留在手牌（{checklist.hand.length}）</h3>
          <ul>
            {checklist.hand.map((item: RetainedHandItem) => {
              const iid = item.instanceId;
              return (
                <li key={item.key} data-hand-key={item.key}>
                  <span className="v06-day-close-title">
                    {item.title}
                    <em className="v06-day-close-kind">{kindLabels[item.kind]}</em>
                    {item.expired && <em className="v06-day-close-tag">已到期</em>}
                  </span>
                  <span className="v06-day-close-actions">
                    {item.withdrawable && iid ? (
                      <button
                        type="button"
                        disabled={busy || instanceVersion(iid) === undefined}
                        onClick={() =>
                          void onAction('WithdrawInstance', {
                            instance: { id: iid, version: instanceVersion(iid)! },
                          })
                        }
                      >
                        收回手牌
                      </button>
                    ) : (
                      <em className="v06-day-close-reason">
                        {item.readOnly
                          ? '答案 / 记录只读'
                          : item.withdrawBlockedReason
                            ? withdrawLabels[item.withdrawBlockedReason]
                            : '当前不可收回'}
                      </em>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <footer className="v06-day-close-foot">
        {checklist.canClose ? (
          celebrated ? (
            <p
              className={`v06-day-close-done${reduceMotion ? ' is-static' : ''}`}
              role="status"
              data-testid="day-close-done"
            >
              今天到这里就闭环了：造卡、打出、确认、记录都已对上。明天再抽一张就好。
              <button type="button" onClick={() => setCelebrated(false)}>
                收起提示
              </button>
            </p>
          ) : (
            <button
              type="button"
              className="v06-day-close-finish"
              data-testid="day-close-finish"
              onClick={() => setCelebrated(true)}
            >
              完成今天回顾
            </button>
          )
        ) : (
          <p className="v06-day-close-wait">
            还有 {checklist.unverified.length} 项待核实，处理后即可收尾；只读提醒不会卡住你。
          </p>
        )}
      </footer>
    </section>
  );
}
