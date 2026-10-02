import type { CardView, FactView, Range } from '../../docs/产品设计/1C-prototype-contract.ts';
import { addDate, at, range } from './time.ts';

export type ScenarioId = 'S01' | 'S02' | 'S03' | 'S04' | 'S05' | 'S06' | 'S07';
export type Fixed = { id: string; title: string; range: Range; version: number };
export type Plan = { id: string; title: string; instanceId: string; range: Range; version: number };
export type MutableFact = { id: string; instanceId: string; title: string; criteria: string; range: Range; plannedRange: Range | null; confirmedAt: string; annotations: { id: string; text: string; createdAt: string }[] };
export type Fixture = { id: ScenarioId; title: string; date: string; zone: string; now: string; cards: CardView[]; fixed: Fixed[]; plans: Plan[]; facts: MutableFact[] };

const Z = 'Asia/Shanghai', D = '2026-09-24', fixedNow = at(D, '09:30');
const card = (id: string, title: string, presetMinutes: number): CardView => ({ instanceId: id, version: 1, title, criteria: '按卡片说明完成一次', presetMinutes, color: 'var(--card-green)', targetDate: D });
const slot = (start: string, end: string, date = D, zone = Z): Range => {
  const [endDate, endTime] = end.startsWith('+1 ') ? [addDate(date, 1), end.slice(3)] : [date, end];
  return range(at(date, start, zone), at(endDate, endTime, zone), zone);
};
const block = (id: string, title: string, start: string, end: string, date = D): Fixed => ({ id, title, range: slot(start, end, date), version: 1 });
const fact = (id: string, title: string, start: string, end: string, plannedRange: Range | null = null): MutableFact => ({ id, instanceId: `i-${id}`, title, criteria: '合成完成标准', range: slot(start, end), plannedRange, confirmedAt: fixedNow, annotations: [] });

export const scenarioNames: Record<ScenarioId, string> = {
  S01: '空白日 · 单一落点', S02: '拥挤日 · 固定保护', S03: '跨环与跨午夜',
  S04: '日终空时间 · 实际重叠', S05: '提交失败 · 版本过期',
  S06: '夏令时 · 重复刻度', S07: '长手牌 · 小屏输入',
};
export function createFixture(id: ScenarioId): Fixture {
  const base: Fixture = { id, title: scenarioNames[id], date: D, zone: Z, now: fixedNow, cards: [], fixed: [], plans: [], facts: [] };
  switch (id) {
    case 'S01': base.cards = [card('i-15', '整理桌面', 15), card('i-25', '阅读一章', 25)]; break;
    case 'S02': {
      const intervals = [
        ['00:00', '08:00'], ['08:30', '09:00'], ['09:15', '09:30'], ['10:00', '12:00'],
        ['12:00', '13:00'], ['13:05', '13:30'], ['14:00', '15:00'], ['15:00', '16:00'],
        ['16:15', '17:00'], ['18:00', '19:00'], ['20:00', '22:00'], ['22:00', '+1 00:00'],
      ];
      intervals.forEach(([start, end], n) => {
        const timeRange = slot(start, end);
        if (n === 2 || n === 9) base.facts.push(fact(`f-${n}`, n === 2 ? '已完成：晨间准备' : '已完成：散步', start, end));
        else if (n === 6 || n === 10) base.plans.push({ id: `p-${n}`, instanceId: `scheduled-${n}`, title: n === 6 ? '阅读计划' : '整理资料', range: timeRange, version: 1 });
        else base.fixed.push({ id: `b-${n}`, title: n === 0 ? '睡眠' : n === 4 ? '午间固定安排' : `固定安排 ${n + 1}`, range: timeRange, version: 1 });
      });
      base.cards = [card('i-45', '深度写作', 45), card('i-15', '喝水和休息', 15),
        card('scheduled-6', '阅读计划', 60), card('scheduled-10', '整理资料', 60)];
      break;
    }
    case 'S03':
      base.plans = [
        { id: 'p-noon', instanceId: 'i-noon', title: '午间散步', range: slot('11:50', '12:10'), version: 1 },
        { id: 'p-night', instanceId: 'i-night', title: '夜间阅读', range: slot('23:50', '+1 00:15'), version: 1 },
      ];
      base.fixed = [block('b-next', '次日固定安排', '00:05', '00:30', addDate(D, 1))];
      base.cards = [card('i-cross', '跨午夜练习', 25), card('i-short', '简短整理', 15),
        card('i-noon', '午间散步', 20), card('i-night', '夜间阅读', 25)];
      break;
    case 'S04':
      base.facts = [fact('f-actual', '阅读已经完成', '09:20', '09:50', slot('09:00', '10:00')), fact('f-overlap', '实际散步', '09:40', '10:10')];
      base.cards = [card('i-future', '提前确认样例', 15)];
      base.now = at(addDate(D, 1), '00:00');
      break;
    case 'S05': base.cards = [card('i-retry', '需要可靠保存的卡', 25)]; break;
    case 'S06':
      base.date = '2026-10-31'; base.zone = 'America/New_York'; base.now = at('2026-10-31', '23:00', base.zone);
      base.cards = [card('i-150', '跨夏令时 150 分钟', 150), card('i-210', '跨夏令时 210 分钟', 210)];
      break;
    case 'S07': base.cards = Array.from({ length: 12 }, (_, i) => card(`i-${i + 1}`, `行动卡 ${i + 1} · ${['阅读', '整理', '运动'][i % 3]}`, i % 2 ? 25 : 15)); break;
  }
  return base;
}
export function asFactView(f: MutableFact): FactView {
  return { factId: f.id, instanceId: f.instanceId, title: f.title, criteria: f.criteria,
    actualRange: f.range, plannedRange: f.plannedRange, confirmedAt: f.confirmedAt, annotations: f.annotations };
}
