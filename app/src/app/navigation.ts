export type TabId =
  | 'agenda'
  | 'inbox'
  | 'schedule'
  | 'definitions'
  | 'workshop'
  | 'hand'
  | 'journal'
  | 'config'
  | 'data';
// Single source of truth for page labels/hierarchy (docs/产品设计/界面设计.md §分区标签规范): EN caption + ZH title.
export const TAB_META: Record<TabId, { en: string; zh: string; desc: string }> = {
  agenda: {
    en: 'TODAY',
    zh: 'Today · 今日',
    desc: '看今天的时间盘与手牌；打开和切换日期不会生成安排。',
  },
  inbox: {
    en: 'INBOX',
    zh: 'Inbox · 收件箱',
    desc: '先记下来，稍后再整理；捕获不占时间、不生成事实。',
  },
  schedule: {
    en: 'SCHEDULE',
    zh: 'Schedule · 日程',
    desc: '按日期查看完整时间记录；排期与实际确认请到 Today。',
  },
  definitions: { en: 'DEFINITIONS', zh: '行动定义', desc: '维护可抽取的行动定义与完成标准。' },
  workshop: {
    en: 'WORKSHOP',
    zh: '制卡工坊',
    desc: '维护行动原卡、书目、卡池与生成规则；编辑不改已生成快照。',
  },
  hand: { en: 'HAND', zh: '抽卡手牌', desc: '抽取建议、管理手牌；接受后返回 Today 安排时间。' },
  journal: {
    en: 'JOURNAL',
    zh: '日记',
    desc: '一天一篇纯文本，停顿自动存；可补写过去，不写未来。',
  },
  config: {
    en: 'CONFIG',
    zh: '配置工坊',
    desc: '偏好直接保存；定义、模板与例行通过配置包预览后导入。',
  },
  data: { en: 'DATA', zh: '数据与备份', desc: '备份、恢复与迁移；所有文件都留在本机。' },
};
