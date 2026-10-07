// v0.6 A0 隔离样稿数据：仅用于体验验证，不连接个人数据库，字段命名不代表 P0 已冻结的接口。
// 三领域（吃饭/阅读/锻炼）与一个无绑定清单同级；原卡长期保留，拿牌只生成“本次”副本。

export type SampleDeckKind = 'action' | 'decision' | 'collection';

export type SampleEntry = Readonly<{
  id: string;
  name: string;
  detail?: string; // 领域补充字段（作者、组数、预留字段说明等）
  url?: string; // 网址条目的链接文本
}>;

export type SampleDeck = Readonly<{
  id: string;
  name: string;
  kind: SampleDeckKind;
  unbound?: boolean; // 独立清单：不对应任何行动或决策（P11）
  binding?: string; // 作为候选时服务的问题
  color?: string;
  members: readonly SampleEntry[];
}>;

export const SAMPLE_DECKS: readonly SampleDeck[] = [
  {
    id: 'deck-actions',
    name: '常用行动',
    kind: 'action',
    color: '#315e50',
    members: [
      { id: 'act-eat', name: '吃饭', detail: '预留字段：餐次 · 地点' },
      { id: 'act-read', name: '读书', detail: '预留字段：时长 · 地点' },
      { id: 'act-train', name: '锻炼', detail: '预留字段：组数 · 地点' },
    ],
  },
  {
    id: 'deck-questions',
    name: '生活决策',
    kind: 'decision',
    color: '#6b5b95',
    members: [
      { id: 'q-eat', name: '这餐吃什么？', detail: '候选：餐食清单' },
      { id: 'q-read', name: '读哪一本？', detail: '候选：书单（待读）' },
      { id: 'q-train', name: '练什么项目？', detail: '候选：锻炼项目' },
    ],
  },
  {
    id: 'deck-books-todo',
    name: '书单（待读）',
    kind: 'collection',
    binding: '读哪一本？',
    members: [
      { id: 'b-deep', name: '深度工作', detail: '卡尔·纽波特' },
      { id: 'b-flow', name: '心流', detail: '米哈里·契克森米哈赖' },
      { id: 'b-atomic', name: '原子习惯', detail: '詹姆斯·克利尔' },
      { id: 'b-thinking', name: '思考，快与慢', detail: '丹尼尔·卡尼曼' },
    ],
  },
  {
    id: 'deck-books-done',
    name: '已读书单',
    kind: 'collection',
    members: [{ id: 'b-done-gtd', name: '搞定', detail: '戴维·艾伦 · 读完后从待读移入' }],
  },
  {
    id: 'deck-foods',
    name: '餐食清单',
    kind: 'collection',
    binding: '这餐吃什么？',
    members: [
      { id: 'f-noodle', name: '番茄鸡蛋面' },
      { id: 'f-rice', name: '青椒肉丝饭' },
      { id: 'f-salad', name: '蔬菜沙拉' },
      { id: 'f-curry', name: '咖喱鸡饭' },
      { id: 'f-soup', name: '紫菜蛋花汤' },
    ],
  },
  {
    id: 'deck-exercises',
    name: '锻炼项目',
    kind: 'collection',
    binding: '练什么项目？',
    members: [
      { id: 'e-pushup', name: '俯卧撑', detail: '上肢 · 推力' },
      { id: 'e-pullup', name: '引体向上', detail: '上肢 · 拉力' },
      { id: 'e-squat', name: '深蹲', detail: '下肢' },
      { id: 'e-jog', name: '慢跑', detail: '有氧' },
      { id: 'e-plank', name: '平板支撑', detail: '核心' },
    ],
  },
  {
    id: 'deck-urls',
    name: '有用网址',
    kind: 'collection',
    unbound: true,
    members: [
      { id: 'u-github', name: 'GitHub', url: 'https://github.com' },
      { id: 'u-chrome', name: 'Chrome 开发者文档', url: 'https://developer.chrome.com' },
      { id: 'u-example', name: '示例站点', url: 'https://example.com' },
    ],
  },
  {
    id: 'deck-snacks',
    name: '零食',
    kind: 'collection',
    unbound: true,
    members: [
      { id: 's-choco', name: '黑巧克力' },
      { id: 's-nuts', name: '混合坚果' },
    ],
  },
];

export const deckKindLabel = (deck: SampleDeck): string => {
  if (deck.kind === 'action') return '行动牌堆';
  if (deck.kind === 'decision') return '决策牌堆';
  return deck.unbound ? '独立清单' : '收纳牌堆';
};
