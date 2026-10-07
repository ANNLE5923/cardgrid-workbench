import type { ConfigV4 } from './contracts-v06.ts';
import { emptyWorkspaceData } from './format.ts';
/** No personal data. Sleep is a dial template, never an inferred fact. */
export function configurationExample(): ConfigV4 {
  const settings = { ...emptyWorkspaceData().settings, zone: 'Asia/Shanghai' };
  const content = (title: string, minutes: number) => ({
    title,
    criteria: '',
    presetMinutes: minutes,
    color: '#6495ed',
    categoryId: null,
    categoryLabel: null,
    minimum: false,
    projectIds: [],
    goalIds: [],
    projectLabels: [],
    goalLabels: [],
  });
  const source = { kind: 'manual' as const },
    domains = [
      ['sample-eat', '吃饭', 30, '米饭'],
      ['sample-read', '阅读', 30, '一本书'],
      ['sample-exercise', '锻炼', 30, '散步'],
    ] as const;
  return {
    format: 'cardgrid',
    version: 4,
    kind: 'config',
    config: {
      settings,
      definitions: [],
      rules: [],
      templates: [
        {
          id: 'sleep',
          version: 1,
          name: '夜间睡眠',
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          entries: [
            {
              id: 'sleep-night',
              title: '睡眠',
              start: '22:00',
              elapsedMinutes: 480,
              definitionId: null,
            },
          ],
          source,
        },
      ],
      actionCards: domains.map(([id, title, minutes]) => ({
        id,
        version: 1,
        kind: 'action',
        content: content(`${title}：{选项}`, minutes),
        fields: [{ id: 'choice', label: '选项', valueType: 'text', required: true }],
        status: 'active',
        parentId: null,
        source,
      })),
      catalogEntries: [
        ...domains.map(([id, , , title]) => ({
          id: `${id}-entry`,
          version: 1,
          title,
          attributes: {},
          url: null,
          status: 'active' as const,
          source,
        })),
        {
          id: 'reference-link',
          version: 1,
          title: '独立清单示例',
          attributes: { topic: '参考' },
          url: 'https://example.com/',
          status: 'active',
          source,
        },
      ],
      decks: [
        ...domains.flatMap(([id, title]) => [
          {
            id: `${id}-list`,
            version: 1,
            name: `${title}清单`,
            deckKind: 'entry' as const,
            parentDeckId: null,
            memberIds: [`${id}-entry`],
            source,
          },
          {
            id: `${id}-actions`,
            version: 1,
            name: `${title}行动`,
            deckKind: 'action' as const,
            parentDeckId: null,
            memberIds: [id],
            source,
          },
          {
            id: `${id}-decisions`,
            version: 1,
            name: `${title}决策`,
            deckKind: 'decision' as const,
            parentDeckId: null,
            memberIds: [`${id}-decision`],
            source,
          },
        ]),
        {
          id: 'independent-list',
          version: 1,
          name: '独立网址清单',
          deckKind: 'entry',
          parentDeckId: null,
          memberIds: ['reference-link'],
          source,
        },
      ],
      decisionCards: domains.map(([id, title]) => ({
        id: `${id}-decision`,
        version: 1,
        question: `这次${title}选什么？`,
        ownerActionId: id,
        deckIds: [`${id}-list`],
        mappings: [{ fieldId: 'choice', entryPath: 'title' }],
        status: 'active',
        source,
      })),
      generationRules: [],
    },
  };
}
export const CONFIGURATION_AI_PROMPT = `生成 CardGrid config-v4 JSON，只输出 JSON。以附带示例为结构，保留全部顶层键。配置只含 settings、definitions、templates、rules、generationRules、actionCards、catalogEntries、decks、decisionCards，不含事实、日记或维护日志。ID 稳定且唯一，新对象 version 为 1，source 为 {"kind":"manual"}。吃饭、阅读、锻炼使用同一行动/资源/决策结构。牌堆也可独立作清单。决策引用存在的行动和资源牌堆，映射只用 title 或 attributes 的扁平属性。每个牌堆至多 100 个成员；可拆分子牌堆。行动字段 label 对应正文 {{字段名}}，必填字段由明确答案填写。睡眠放入 templates 的表盘安排，起点和时长为五分钟倍数，不生成睡眠事实。网址只用 http/https。先用 scripts/check-v06-config.mjs 校验，导入前预览并保存活动 JSON 和所需历史 ZIP 备份。`;
