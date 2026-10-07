// v0.6 A0 时间线日记样稿数据（P13/P14/P16/P18）。
// 自动段是表盘投影（睡眠/早餐/午餐），随记是独立感想；固定合成数据，不依赖真实日期。

export type SampleAutoKind = 'sleep' | 'meal' | 'action';

export type SampleAutoBlock = Readonly<{
  id: string;
  kind: SampleAutoKind;
  name: string;
  start: string; // HH:MM
  end: string;
  reference?: string; // 贴附在行动旁的答案（P08，不另占时间）
  movable?: boolean;
  retractable?: boolean;
}>;

export type SampleNote = Readonly<{
  id: string;
  createdAt: string; // 原记录时间 HH:MM，不随后续修改改变
  text: string;
  modifiedAt?: string;
}>;

export const SAMPLE_AUTO_BLOCKS: readonly SampleAutoBlock[] = [
  { id: 'a-sleep', kind: 'sleep', name: '睡眠', start: '00:00', end: '06:00' },
  {
    id: 'a-breakfast',
    kind: 'meal',
    name: '早餐',
    start: '08:00',
    end: '08:30',
    movable: true,
    retractable: true,
  },
  {
    id: 'a-lunch',
    kind: 'meal',
    name: '午餐',
    start: '12:00',
    end: '12:40',
    reference: '本餐答案 · 番茄鸡蛋面（贴附于午餐，不重复占时）',
  },
];

export const SAMPLE_NOTES: readonly SampleNote[] = [
  { id: 'n-0610', createdAt: '06:10', text: '昨晚睡得不错，今天精神很好。' },
  { id: 'n-0812', createdAt: '08:12', text: '今天早餐很好吃。' },
];

// HH:MM 加分钟，返回 HH:MM。
export const addMinutes = (clock: string, minutes: number): string => {
  const [h, m] = clock.split(':').map(Number);
  const total = (h * 60 + m + minutes) % (24 * 60);
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
};
