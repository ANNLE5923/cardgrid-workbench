// v0.6 A0 决策样稿数据：正面是问题，背面从指定牌堆抽出具体答案（P03/P08）。
// 抽取在样稿中按确定顺序轮换，便于核对；正式随机规则属于 B 线，P0 冻结后接入。

export type SampleQuestionId = 'eat' | 'read' | 'train';

export type SampleCandidate = Readonly<{
  id: string;
  name: string;
  detail?: string;
}>;

export type SampleQuestion = Readonly<{
  id: SampleQuestionId;
  question: string;
  actionName: string;
  deckName: string;
  candidates: readonly SampleCandidate[];
}>;

export type SampleAnswer = Readonly<{
  candidateId: string;
  name: string;
  detail?: string;
  question: string;
  actionName: string;
  source: string;
}>;

export const SAMPLE_QUESTIONS: readonly SampleQuestion[] = [
  {
    id: 'eat',
    question: '这餐吃什么？',
    actionName: '吃饭',
    deckName: '餐食清单',
    candidates: [
      { id: 'f-noodle', name: '番茄鸡蛋面' },
      { id: 'f-rice', name: '青椒肉丝饭' },
      { id: 'f-salad', name: '蔬菜沙拉' },
      { id: 'f-curry', name: '咖喱鸡饭' },
      { id: 'f-soup', name: '紫菜蛋花汤' },
    ],
  },
  {
    id: 'read',
    question: '读哪一本？',
    actionName: '读书',
    deckName: '书单（待读）',
    candidates: [
      { id: 'b-deep', name: '深度工作', detail: '卡尔·纽波特' },
      { id: 'b-flow', name: '心流', detail: '米哈里·契克森米哈赖' },
      { id: 'b-atomic', name: '原子习惯', detail: '詹姆斯·克利尔' },
      { id: 'b-thinking', name: '思考，快与慢', detail: '丹尼尔·卡尼曼' },
    ],
  },
  {
    id: 'train',
    question: '练什么项目？',
    actionName: '锻炼',
    deckName: '锻炼项目',
    candidates: [
      { id: 'e-pushup', name: '俯卧撑', detail: '3 组 × 15' },
      { id: 'e-pullup', name: '引体向上', detail: '3 组 × 5' },
      { id: 'e-squat', name: '深蹲', detail: '3 组 × 20' },
      { id: 'e-jog', name: '慢跑', detail: '20 分钟' },
      { id: 'e-plank', name: '平板支撑', detail: '3 × 45 秒' },
    ],
  },
];
