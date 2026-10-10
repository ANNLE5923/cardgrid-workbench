import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  DayView,
  FactView,
  Instance,
  Occurrence,
  PlanView,
  Rule,
  Segment,
  Token,
} from '../../../src/workspace/contracts.ts';
import {
  buildCloseChecklist,
  projectExpectedRoutines,
  type CloseChecklistInput,
  type CloseHandItem,
  type CloseMaterialBinding,
} from '../../../src/daily/close/close-checklist.ts';
import {
  dateAt,
  dayRange,
  elapsedMinutes,
  nextDate,
  plannedRange,
  weekday,
} from '../../../src/daily/schedule/time.ts';
import { content } from '../../fixtures/action/seed.ts';

const ZONE = 'Asia/Shanghai';
const DATE = '2026-10-10'; // 周六
const NOW = '2026-10-10T04:00:00Z'; // 12:00 CST
const token: Token = { epoch: 'ep', revision: 1 };

const r = (time: string, minutes: number, date = DATE) =>
  plannedRange({ date, time, zone: ZONE }, minutes);

function instance(id: string, overrides: Partial<Instance> = {}): Instance {
  return {
    id,
    version: 1,
    definition: null,
    creationSnapshot: content(30),
    currentContent: { ...content(30), title: `安排 ${id}` },
    source: { kind: 'manual' },
    createdAt: NOW,
    targetDate: null,
    state: 'open',
    occurrenceId: null,
    daily: null,
    makeupOf: null,
    ...overrides,
  };
}

function rule(id: string, overrides: Partial<Rule> = {}): Rule {
  return {
    id,
    version: 1,
    name: `例行 ${id}`,
    definitionId: 'def1',
    weekdays: [weekday(nextDate(DATE))], // 默认命中明天
    startDate: DATE,
    zone: ZONE,
    status: 'active',
    source: { kind: 'manual' },
    ...overrides,
  };
}

function occurrence(
  id: string,
  overrides: Partial<Occurrence> & Pick<Occurrence, 'disposition'>,
): Occurrence {
  return { id, ruleId: 'r1', date: DATE, instanceId: `inst-${id}`, ...overrides };
}

function plan(planId: string, instanceId: string, range: PlanView['range']): PlanView {
  return { planId, version: 1, instanceId, instanceVersion: 1, range };
}

function fact(
  factId: string,
  instanceId: string,
  actualRange: FactView['actualRange'],
  plannedRangeRange: FactView['plannedRange'] = null,
): FactView {
  return {
    factId,
    instanceId,
    title: `安排 ${instanceId}`,
    criteria: '',
    actualRange,
    plannedRange: plannedRangeRange,
    confirmedAt: NOW,
    annotations: [],
  };
}

function factSegment(factId: string, clippedRange: Segment['clippedRange']): Segment {
  return {
    id: `seg-${factId}-${clippedRange.startAt}`,
    sourceId: factId,
    kind: 'fact',
    title: '',
    sourceRange: clippedRange,
    clippedRange,
    startDate: dateAt(clippedRange.startAt, ZONE),
    half: 0,
    startMinuteOfHalf: 0,
    endMinuteOfHalf: Math.round(elapsedMinutes(clippedRange)),
    label: '',
    offsetLabel: '',
    locked: true,
    continuesBefore: false,
    continuesAfter: false,
  };
}

function dayView(partial: Partial<DayView> = {}): DayView {
  const d = partial.date ?? DATE;
  const z = partial.zone ?? ZONE;
  return {
    token,
    date: d,
    zone: z,
    now: NOW,
    dayRange: dayRange(d, z),
    hand: [],
    segments: [],
    facts: [],
    plans: [],
    fixed: [],
    freeRanges: [],
    policies: {
      status: 'user-decided',
      actualPrecision: 'minute',
      allowFutureActualEnd: true,
      confirmedOccupancy: 'actual-only',
      dayEnd: 'automatic-recompute',
      placementOverlap: 'explicit-acknowledgement',
    },
    ...partial,
  };
}

function input(partial: Partial<CloseChecklistInput> = {}): CloseChecklistInput {
  return {
    date: DATE,
    zone: ZONE,
    now: NOW,
    day: dayView(),
    occurrences: [],
    instances: [],
    rules: [],
    confirmedInstanceIds: [],
    hand: [],
    materials: [],
    isToday: true,
    archived: false,
    archiveComplete: false,
    ...partial,
  };
}

const handItem = (overrides: Partial<CloseHandItem>): CloseHandItem => ({
  key: 'material:c1',
  kind: 'action',
  title: '手牌',
  expiresAt: null,
  unavailableReason: null,
  instanceId: 'i-hand',
  instanceState: 'open',
  hasFact: false,
  hasActivePlan: false,
  occurrence: null,
  ...overrides,
});

test('C1: 已结束且无 Fact 的有效计划进入待核实并阻塞收口', () => {
  const ended = r('09:00', 30);
  const result = buildCloseChecklist(
    input({ day: dayView({ plans: [plan('p1', 'i1', ended)] }), instances: [instance('i1')] }),
  );
  assert.equal(result.unverified.length, 1);
  assert.equal(result.unverified[0].instanceId, 'i1');
  assert.equal(result.lockedUnverified.length, 0);
  assert.equal(result.canClose, false);
});

test('C1: 确认真实发生（出现当日 Fact）后解除阻塞，撤回/改期（计划移除）也解除且不强增 Fact', () => {
  const ended = r('09:00', 30);
  const confirmed = buildCloseChecklist(
    input({
      day: dayView({ plans: [plan('p1', 'i1', ended)], facts: [fact('f1', 'i1', ended)] }),
      instances: [instance('i1')],
      confirmedInstanceIds: ['i1'],
    }),
  );
  assert.equal(confirmed.unverified.length, 0);
  assert.equal(confirmed.canClose, true);
  assert.equal(confirmed.recap.actualConfirmedCount, 1);

  // 撤回 / 改期后该计划不再 active：可收口，且没有任何 Fact 被补造。
  const withdrawn = buildCloseChecklist(
    input({ day: dayView({ plans: [] }), instances: [instance('i1')] }),
  );
  assert.equal(withdrawn.unverified.length, 0);
  assert.equal(withdrawn.canClose, true);
  assert.equal(withdrawn.recap.actualConfirmedCount, 0);
});

test('C2: 未来/尚未结束的计划不误判超时；跨午夜延续标记 continuesBefore', () => {
  const future = r('13:00', 30); // 13:00 晚于 now 12:00
  const notEnded = buildCloseChecklist(
    input({ day: dayView({ plans: [plan('p2', 'i2', future)] }), instances: [instance('i2')] }),
  );
  assert.equal(notEnded.unverified.length, 0);
  assert.equal(notEnded.canClose, true);

  // 前一日 23:50 开始、当日 00:20 结束（已过 now）应判超时，并标记跨午夜延续。
  const overnightRange = plannedRange({ date: '2026-10-09', time: '23:50', zone: ZONE }, 30);
  const overnight = buildCloseChecklist(
    input({
      day: dayView({ plans: [plan('p3', 'i3', overnightRange)] }),
      instances: [instance('i3')],
    }),
  );
  assert.equal(overnight.unverified.length, 1);
  assert.equal(overnight.unverified[0].continuesBefore, true);
});

test('C6: 原计划在今天、实际发生在明天的 Fact 不计入今天实际；同日 Fact 按 factId 去重、时长取裁剪段', () => {
  // 计划今天 09:00，实际改到明天 09:00 才确认：今天视图含该 fact（原计划对照），但实际数为 0。
  const plannedToday = r('09:00', 30);
  const actualTomorrow = r('09:00', 30, '2026-10-11');
  const day = dayView({
    plans: [plan('p1', 'i1', plannedToday)],
    facts: [fact('f1', 'i1', actualTomorrow, plannedToday)],
  });
  const todayResult = buildCloseChecklist(
    input({ day, instances: [instance('i1')], confirmedInstanceIds: ['i1'] }),
  );
  assert.equal(todayResult.recap.actualConfirmedCount, 0);
  assert.equal(todayResult.recap.actualMinutes, 0);
  // 计划仍 active 且已过点，但实例已有 Fact（哪怕发生在别日）——不再要求重复核实。
  assert.equal(todayResult.unverified.length, 0);

  // 同日两条 fact 裁剪段属于同一 fact：计数 1，时长累加裁剪段（30 分钟）。
  const actual = r('09:00', 30);
  const dayWithSegments = dayView({
    facts: [fact('f2', 'i2', actual)],
    segments: [factSegment('f2', r('09:00', 15)), factSegment('f2', r('09:15', 15))],
  });
  const counted = buildCloseChecklist(input({ day: dayWithSegments }));
  assert.equal(counted.recap.actualConfirmedCount, 1);
  assert.equal(counted.recap.actualMinutes, 30);
});

test('C3: 补录资格对齐 CreateMakeup：过去 generated / missed / skipped 提示，今日 generated、cancelled、已补录、已确认不提示', () => {
  const instances: Instance[] = [
    instance('inst-past'),
    instance('inst-missed'),
    instance('inst-skip'),
    instance('inst-today'),
    instance('inst-cancel'),
    instance('inst-made'),
    instance('inst-done'),
    instance('i-makeup', { makeupOf: { kind: 'occurrence', id: 'o-made' } }),
  ];
  const occurrences: Occurrence[] = [
    occurrence('o-past', {
      ruleId: 'r1',
      instanceId: 'inst-past',
      disposition: 'generated',
      date: '2026-10-09',
    }),
    occurrence('o-missed', {
      ruleId: 'r1',
      instanceId: 'inst-missed',
      disposition: 'missed',
      date: '2026-10-09',
    }),
    occurrence('o-skip', {
      ruleId: 'r1',
      instanceId: 'inst-skip',
      disposition: 'skipped',
      date: '2026-10-09',
    }),
    occurrence('o-today', {
      ruleId: 'r1',
      instanceId: 'inst-today',
      disposition: 'generated',
      date: DATE,
    }),
    occurrence('o-cancel', {
      ruleId: 'r1',
      instanceId: 'inst-cancel',
      disposition: 'cancelled',
      date: '2026-10-09',
    }),
    occurrence('o-made', {
      ruleId: 'r1',
      instanceId: 'inst-made',
      disposition: 'missed',
      date: '2026-10-09',
    }),
    occurrence('o-done', {
      ruleId: 'r1',
      instanceId: 'inst-done',
      disposition: 'missed',
      date: '2026-10-09',
    }),
  ];
  const result = buildCloseChecklist(
    input({
      date: '2026-10-09',
      isToday: false,
      day: dayView({ date: '2026-10-09' }),
      occurrences,
      instances,
      rules: [rule('r1')],
      confirmedInstanceIds: ['inst-done'],
    }),
  );
  const ids = result.routines.map((x) => x.occurrenceId).sort();
  assert.deepEqual(ids, ['o-missed', 'o-past', 'o-skip']);
  assert.ok(result.routines.every((x) => x.makeupEligible));
});

test('C3b: 今天收尾收集过去漏做例行（昨天 missed / 过期 generated），排除今天 generated、未来 skipped、已补录与已确认', () => {
  const instances: Instance[] = [
    instance('inst-ym'),
    instance('inst-yg'),
    instance('inst-tg'),
    instance('inst-fs'),
    instance('inst-made'),
    instance('i-made', { makeupOf: { kind: 'occurrence', id: 'o-made' } }),
    instance('inst-done'),
  ];
  const occurrences: Occurrence[] = [
    occurrence('o-ym', {
      ruleId: 'r1',
      instanceId: 'inst-ym',
      disposition: 'missed',
      date: '2026-10-09',
    }),
    occurrence('o-yg', {
      ruleId: 'r1',
      instanceId: 'inst-yg',
      disposition: 'generated',
      date: '2026-10-09',
    }),
    occurrence('o-tg', {
      ruleId: 'r1',
      instanceId: 'inst-tg',
      disposition: 'generated',
      date: DATE,
    }),
    occurrence('o-fs', {
      ruleId: 'r1',
      instanceId: 'inst-fs',
      disposition: 'skipped',
      date: '2026-10-11',
    }),
    occurrence('o-made', {
      ruleId: 'r1',
      instanceId: 'inst-made',
      disposition: 'missed',
      date: '2026-10-09',
    }),
    occurrence('o-done', {
      ruleId: 'r1',
      instanceId: 'inst-done',
      disposition: 'missed',
      date: '2026-10-09',
    }),
  ];
  const result = buildCloseChecklist(
    input({
      occurrences,
      instances,
      rules: [rule('r1')],
      confirmedInstanceIds: ['inst-done'],
    }),
  );
  const picked = result.routines.map((x) => x.occurrenceId).sort();
  assert.deepEqual(picked, ['o-yg', 'o-ym']);
  assert.ok(result.routines.every((x) => x.makeupEligible));
  // 记录的是原始漏做日期；面板 CreateMakeup 的 targetDate 另用 checklist.date（今天）。
  assert.deepEqual(result.routines.map((x) => x.date).sort(), ['2026-10-09', '2026-10-09']);
});

test('P1: 过去日例行计划原日无合法解除路径 → 历史只读提醒、不阻塞，并链接向前补录实例', () => {
  const pastDate = '2026-10-06';
  const endedPast = r('09:00', 30, pastDate);
  const occurrences: Occurrence[] = [
    occurrence('o-old', {
      ruleId: 'r1',
      instanceId: 'inst-old',
      disposition: 'generated',
      date: pastDate,
    }),
  ];
  const instances: Instance[] = [
    instance('inst-old', { occurrenceId: 'o-old' }),
    instance('i-makeup', { makeupOf: { kind: 'occurrence', id: 'o-old' } }),
  ];
  const past = buildCloseChecklist(
    input({
      date: pastDate,
      isToday: false,
      day: dayView({ date: pastDate, plans: [plan('p-old', 'inst-old', endedPast)] }),
      occurrences,
      instances,
      rules: [rule('r1')],
    }),
  );
  assert.equal(past.unverified.length, 0);
  assert.equal(past.lockedUnverified.length, 1);
  assert.equal(past.lockedUnverified[0].lockedReason, 'past-occurrence');
  assert.equal(past.lockedUnverified[0].makeupInstanceId, 'i-makeup');
  assert.equal(past.canClose, true); // 历史日不得被永久卡死

  // 例行日期=今天、generated：在今天视图里仍是可处理阻塞项。
  const todayOcc = occurrence('o-now', {
    ruleId: 'r1',
    instanceId: 'inst-now',
    disposition: 'generated',
    date: DATE,
  });
  const today = buildCloseChecklist(
    input({
      day: dayView({ plans: [plan('p-now', 'inst-now', r('09:00', 30))] }),
      occurrences: [todayOcc],
      instances: [instance('inst-now', { occurrenceId: 'o-now' })],
      rules: [rule('r1')],
    }),
  );
  assert.equal(today.unverified.length, 1);
  assert.equal(today.canClose, false);

  // 过去日的非例行（手动）计划：同样归入历史只读，原因 historical-readonly。
  const manualPast = buildCloseChecklist(
    input({
      date: pastDate,
      isToday: false,
      day: dayView({ date: pastDate, plans: [plan('p-m', 'inst-m', endedPast)] }),
      instances: [instance('inst-m')],
    }),
  );
  assert.equal(manualPast.unverified.length, 0);
  assert.equal(manualPast.lockedUnverified[0].lockedReason, 'historical-readonly');
  assert.equal(manualPast.canClose, true);
});

test('P1: 午夜到期的每日素材跨日计划，次日 Host 全部拒绝 → 素材锁定提醒、不阻塞收尾', () => {
  const d2 = '2026-10-11';
  const midnight = dayRange(d2, ZONE).startAt; // 素材到期点：10-11 00:00 CST
  const cross = plannedRange({ date: '2026-10-10', time: '23:50', zone: ZONE }, 30); // 23:50–00:20
  const nextMorning = '2026-10-10T17:00:00Z'; // 10-11 01:00 CST，已过计划结束与素材到期
  const expiredBinding: CloseMaterialBinding = {
    instanceId: 'i-mat',
    state: 'available', // 库存对账尚未跑，卡面仍是 available，但时间门禁已拒绝
    consumedBy: null,
    expiresAt: midnight,
  };
  const expired = buildCloseChecklist(
    input({
      date: d2,
      now: nextMorning,
      isToday: true,
      day: dayView({ date: d2, now: nextMorning, plans: [plan('p-mat', 'i-mat', cross)] }),
      instances: [instance('i-mat')],
      materials: [expiredBinding],
    }),
  );
  assert.equal(expired.unverified.length, 0);
  assert.equal(expired.lockedUnverified.length, 1);
  assert.equal(expired.lockedUnverified[0].lockedReason, 'material-expired');
  assert.equal(expired.canClose, true); // 到期素材不得永久卡死收尾

  // 对照：同一跨日计划但素材不到期（expiresAt=null）→ 仍是可处理阻塞项。
  const openBinding: CloseMaterialBinding = {
    instanceId: 'i-mat',
    state: 'available',
    consumedBy: null,
    expiresAt: null,
  };
  const open = buildCloseChecklist(
    input({
      date: d2,
      now: nextMorning,
      isToday: true,
      day: dayView({ date: d2, now: nextMorning, plans: [plan('p-mat', 'i-mat', cross)] }),
      instances: [instance('i-mat')],
      materials: [openBinding],
    }),
  );
  assert.equal(open.unverified.length, 1);
  assert.equal(open.canClose, false);

  // 对照：素材到期点在未来（D3 午夜）→ 仍可处理。
  const freshBinding: CloseMaterialBinding = {
    instanceId: 'i-mat',
    state: 'available',
    consumedBy: null,
    expiresAt: dayRange('2026-10-12', ZONE).startAt,
  };
  const fresh = buildCloseChecklist(
    input({
      date: d2,
      now: nextMorning,
      isToday: true,
      day: dayView({ date: d2, now: nextMorning, plans: [plan('p-mat', 'i-mat', cross)] }),
      instances: [instance('i-mat')],
      materials: [freshBinding],
    }),
  );
  assert.equal(fresh.unverified.length, 1);
  assert.equal(fresh.canClose, false);
});

test('P2: 手牌收回资格逐条对齐正式门禁（过去例行 / 已确认 / 已有计划 / 已关闭 / 到期 / 正常）', () => {
  const items: CloseHandItem[] = [
    handItem({ key: 'ok', instanceId: 'iok' }),
    handItem({
      key: 'ok-today-occ',
      instanceId: 'iocc',
      occurrence: { date: DATE, disposition: 'generated', zone: ZONE },
    }),
    handItem({
      key: 'past-occ',
      instanceId: 'ipast',
      occurrence: { date: '2026-10-09', disposition: 'generated', zone: ZONE },
    }),
    handItem({ key: 'fact', instanceId: 'ifact', hasFact: true }),
    handItem({ key: 'planned', instanceId: 'iplan', hasActivePlan: true }),
    handItem({ key: 'closed', instanceId: 'iclosed', instanceState: 'withdrawn' }),
    handItem({ key: 'expired', instanceId: 'iexp', expiresAt: r('08:00', 5).startAt }),
    handItem({ key: 'ans', kind: 'answer', instanceId: null, instanceState: null }),
  ];
  const result = buildCloseChecklist(input({ hand: items }));
  const byKey = new Map(result.hand.map((h) => [h.key, h]));
  assert.equal(byKey.get('ok')?.withdrawable, true);
  assert.equal(byKey.get('ok-today-occ')?.withdrawable, true);
  assert.equal(byKey.get('past-occ')?.withdrawable, false);
  assert.equal(byKey.get('past-occ')?.withdrawBlockedReason, 'past-occurrence');
  assert.equal(byKey.get('fact')?.withdrawBlockedReason, 'fact-locked');
  assert.equal(byKey.get('planned')?.withdrawBlockedReason, 'already-planned');
  assert.equal(byKey.get('closed')?.withdrawBlockedReason, 'instance-closed');
  assert.equal(byKey.get('expired')?.withdrawable, false);
  assert.equal(byKey.get('expired')?.withdrawBlockedReason, 'expired');
  assert.equal(byKey.get('ans')?.readOnly, true);
  assert.equal(byKey.get('ans')?.withdrawable, false);
  assert.equal(byKey.get('ans')?.withdrawBlockedReason, null);

  // 过去日不展示手牌操作。
  const past = buildCloseChecklist(
    input({
      date: '2026-10-09',
      isToday: false,
      day: dayView({ date: '2026-10-09' }),
      hand: items,
    }),
  );
  assert.equal(past.hand.length, 0);
});

test('C5: 归档覆盖不全时不可完整回顾、不可收口；完整归档可只读回顾', () => {
  const incomplete = buildCloseChecklist(
    input({ isToday: false, archived: true, archiveComplete: false }),
  );
  assert.equal(incomplete.reviewable, false);
  assert.equal(incomplete.canClose, false);
  assert.ok(incomplete.reviewBlockedReason);

  const complete = buildCloseChecklist(
    input({
      isToday: false,
      archived: true,
      archiveComplete: true,
      day: dayView({
        date: '2026-10-09',
        facts: [
          fact('f1', 'i1', plannedRange({ date: '2026-10-09', time: '09:00', zone: ZONE }, 30)),
        ],
      }),
    }),
  );
  assert.equal(complete.reviewable, true);
  assert.equal(complete.canClose, true);
  assert.equal(complete.hand.length, 0);
  assert.equal(complete.recap.actualConfirmedCount, 1);
});

test('P2: 明日例行预计按各规则自己的时区计算，并剔除来源无效规则', () => {
  const at = '2026-10-10T23:30:00Z'; // 上海已是 10-11，纽约仍是 10-10
  const shTomorrow = nextDate(dateAt(at, 'Asia/Shanghai')); // 2026-10-12
  const nyTomorrow = nextDate(dateAt(at, 'America/New_York')); // 2026-10-11
  assert.equal(shTomorrow, '2026-10-12');
  assert.equal(nyTomorrow, '2026-10-11');
  const rules = [
    rule('r-sh', { zone: 'Asia/Shanghai', weekdays: [weekday(shTomorrow)] }),
    rule('r-ny', { zone: 'America/New_York', weekdays: [weekday(nyTomorrow)] }),
    // 只命中"上海明天"、但规则在纽约（其当地明天并不命中）——必须被排除。
    rule('r-trap', { zone: 'America/New_York', weekdays: [weekday(shTomorrow)] }),
    // 来源卡无效：即使排程命中也剔除。
    rule('r-dead', { zone: 'Asia/Shanghai', weekdays: [weekday(shTomorrow)] }),
  ];
  const activeSources = new Set(['r-sh', 'r-ny', 'r-trap']);
  const result = projectExpectedRoutines(rules, {
    now: at,
    isSourceActive: (rule0) => activeSources.has(rule0.id),
  });
  const byId = new Map(result.map((x) => [x.ruleId, x]));
  assert.deepEqual(result.map((x) => x.ruleId).sort(), ['r-ny', 'r-sh']);
  assert.equal(byId.get('r-sh')?.date, '2026-10-12');
  assert.equal(byId.get('r-ny')?.date, '2026-10-11');
  assert.equal(byId.has('r-trap'), false);
  assert.equal(byId.has('r-dead'), false);
});
