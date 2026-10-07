import type { EntityRef, History, LifecycleReceipt, Receipt } from '../workspace/index.ts';
import type { CatalogEntry, MaintenanceEvent, V06EntityRef } from '../workspace/v06.ts';
import { V06ContractError, validateV06Dto } from '../workspace/v06.ts';
import { canonicalJson, fingerprint } from '../workspace/codec.ts';
import {
  assertDate,
  assertInstant,
  assertZone,
  compareInstants,
  dateAt,
  displayInstant,
} from '../daily/time.ts';
import { prepareTextDocument } from '../text-output/model.ts';

const fail = (field: string, message: string): never => {
  throw new V06ContractError('INVALID_INPUT', field, message);
};
const identifier = (value: string, field: string) => {
  if (typeof value !== 'string' || !value.trim()) fail(field, '需要非空标识');
};
const categories = [
  'navigation',
  'business',
  'decision',
  'journal',
  'url',
  'file',
  'lifecycle',
  'error',
];
const stages = ['requested', 'succeeded', 'failed', 'cancelled', 'replayed'];
const refKinds = [
  'catalog-entry',
  'deck',
  'action-card',
  'decision-card',
  'hand-card',
  'reference-placement',
  'journal-note',
  'journal-entry',
  'fact',
  'instance',
  'archive',
];
const detailKeys = new Set([
  'page',
  'previousPage',
  'selectionMode',
  'version',
  'textLength',
  'attempt',
  'bindingId',
  'connectionVersion',
  'outputKind',
  'sourceRevision',
  'historyCount',
  'outcome',
  'url',
]);
function validateEvent(event: MaintenanceEvent): void {
  const eventKeys = [
    'eventId',
    'epoch',
    'at',
    'date',
    'zone',
    'category',
    'operation',
    'stage',
    'commandId',
    'sourceHistoryIds',
    'entityRefs',
    'errorCode',
    'details',
  ];
  if (
    Object.keys(event).length !== eventKeys.length ||
    Object.keys(event).some((k) => !eventKeys.includes(k))
  )
    fail('event', '维护事件不接受未知字段或正文');
  identifier(event.eventId, 'eventId');
  identifier(event.epoch, 'epoch');
  assertInstant(event.at);
  assertZone(event.zone);
  if (event.date !== dateAt(event.at, event.zone))
    fail('date', '维护事件日期须来自原采集时刻和时区');
  if (
    !categories.includes(event.category) ||
    !stages.includes(event.stage) ||
    !/^[-A-Za-z0-9_:]+$/.test(event.operation)
  )
    fail('operation', '需要 CardGrid 语义操作和合法阶段');
  if (event.commandId !== null) identifier(event.commandId, 'commandId');
  if (event.errorCode !== null && !/^[-A-Za-z0-9_:]+$/.test(event.errorCode))
    fail('errorCode', '错误只保存代码，不保存可能包含正文的异常消息');
  if (new Set(event.sourceHistoryIds).size !== event.sourceHistoryIds.length)
    fail('sourceHistoryIds', '历史引用重复');
  for (const historyId of event.sourceHistoryIds) identifier(historyId, 'sourceHistoryIds');
  for (const reference of event.entityRefs) {
    if (!refKinds.includes(reference.kind)) fail('entityRefs', '未知对象引用');
    identifier(reference.id, 'entityRefs.id');
  }
  for (const [name, value] of Object.entries(event.details)) {
    if (!detailKeys.has(name)) fail('details', '只记录受限操作元数据，不接受正文或任意外部活动');
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      fail('details', '只接受平面标量');
    if (
      [
        'version',
        'textLength',
        'attempt',
        'connectionVersion',
        'sourceRevision',
        'historyCount',
      ].includes(name) &&
      (!Number.isSafeInteger(value) || (value as number) < 0)
    )
      fail('details', '计数和版本须为非负整数');
    if (
      ['page', 'previousPage'].includes(name) &&
      (typeof value !== 'string' || !/^[-a-z0-9/]{1,80}$/.test(value))
    )
      fail('details', '页面只记录 CardGrid 内部路由标识');
    if (name === 'selectionMode' && !['manual', 'random'].includes(String(value)))
      fail('details', '选择方式只能为手选或随机');
    if (name === 'outputKind' && !['journal', 'maintenance'].includes(String(value)))
      fail('details', '只记录两类 CardGrid 文本输出');
  }
  if (
    event.category === 'navigation' &&
    !['AppStarted', 'NavigatePage', 'AppClosed', 'OfflineReopen'].includes(event.operation)
  )
    fail('operation', '导航仅记录实际 CardGrid 页面及启动操作');
  if (event.category === 'url') {
    if (
      event.operation !== 'OpenListUrl' ||
      !['requested', 'blocked', 'failed'].includes(String(event.details.outcome)) ||
      typeof event.details.url !== 'string'
    )
      fail('url', '只能记录清单打开请求或浏览器拒绝，不能宣称网页已加载');
    const target = event.details.url as string;
    try {
      const url = new URL(target);
      if (!['http:', 'https:'].includes(url.protocol)) fail('url', '只记录清单 http/https 网址');
    } catch {
      fail('url', '只记录清单 http/https 网址');
    }
    if (event.stage !== (event.details.outcome === 'requested' ? 'requested' : 'failed'))
      fail('stage', '网址打开阶段不一致');
  } else if (Object.hasOwn(event.details, 'url') || Object.hasOwn(event.details, 'outcome'))
    fail('details', '网址与外部结果只属于清单打开事件');
}
type EventInput = Omit<MaintenanceEvent, 'date' | 'sourceHistoryIds'>;
/** Extra application events have no business history; successful business comes from receipts. */
export function createOperationEvent(input: EventInput): MaintenanceEvent {
  if (input.category === 'url') fail('category', '网址事件请使用清单打开构造器');
  if (
    ['business', 'decision', 'journal', 'lifecycle'].includes(input.category) &&
    input.stage === 'succeeded'
  )
    fail('stage', '业务成功须从正式回执及历史构造');
  const event: MaintenanceEvent = {
    ...structuredClone(input),
    date: dateAt(input.at, input.zone),
    sourceHistoryIds: [],
  };
  validateEvent(event);
  return event;
}
export function createListUrlEvent(
  input: Readonly<{
    eventId: string;
    epoch: string;
    at: string;
    zone: string;
    entry: CatalogEntry;
    outcome: 'requested' | 'blocked' | 'failed';
  }>,
): MaintenanceEvent {
  validateV06Dto('entry', input.entry);
  if (input.entry.url === null) fail('entry.url', '条目没有网址');
  const event: MaintenanceEvent = {
    eventId: input.eventId,
    epoch: input.epoch,
    at: input.at,
    zone: input.zone,
    date: dateAt(input.at, input.zone),
    category: 'url',
    operation: 'OpenListUrl',
    stage: input.outcome === 'requested' ? 'requested' : 'failed',
    commandId: null,
    sourceHistoryIds: [],
    entityRefs: [{ kind: 'catalog-entry', id: input.entry.id }],
    errorCode:
      input.outcome === 'requested'
        ? null
        : input.outcome === 'blocked'
          ? 'URL_OPEN_BLOCKED'
          : 'URL_OPEN_FAILED',
    details: { url: input.entry.url, outcome: input.outcome },
  };
  validateEvent(event);
  return event;
}
export type MaintenanceHistory = Omit<History, 'entity'> &
  Readonly<{ entity: EntityRef | V06EntityRef }>;
/** A replacement has its own lifecycle receipt, rather than inventing planner history. */
export function createLifecycleEvent(
  input: Readonly<{ receipt: LifecycleReceipt; epoch: string; at: string; zone: string }>,
): MaintenanceEvent {
  if (
    input.receipt.resultToken.epoch !== input.epoch ||
    !['RestoreWorkspace', 'ClearWorkspace', 'CommitMigration'].includes(input.receipt.type)
  )
    fail('receipt', '生命周期回执与结果工作区不符');
  const event: MaintenanceEvent = {
    eventId: `lifecycle:${encodeURIComponent(input.epoch)}:${encodeURIComponent(input.receipt.commandId)}`,
    epoch: input.epoch,
    at: input.at,
    date: dateAt(input.at, input.zone),
    zone: input.zone,
    category: 'lifecycle',
    operation: input.receipt.type,
    stage: 'succeeded',
    commandId: input.receipt.commandId,
    sourceHistoryIds: [],
    entityRefs: [],
    errorCode: null,
    details: { sourceRevision: input.receipt.resultToken.revision },
  };
  validateEvent(event);
  return event;
}
export function createCommittedEvent(
  input: Readonly<{
    epoch: string;
    zone: string;
    receipt: Receipt;
    histories: readonly MaintenanceHistory[];
  }>,
): MaintenanceEvent {
  const { receipt, histories } = input;
  identifier(receipt.commandId, 'commandId');
  if (!histories.length) fail('histories', '没有变更历史不能补造成功操作');
  const first = histories[0];
  for (const history of histories)
    if (history.commandId !== receipt.commandId || compareInstants(history.at, first.at) !== 0)
      fail('histories', '必须来自同一已提交操作及原时刻');
  const entityRefs: V06EntityRef[] = [],
    seen = new Set<string>();
  let textLength = 0;
  for (const history of histories) {
    if (refKinds.includes(history.entity.kind)) {
      const encoded = canonicalJson(history.entity);
      if (!seen.has(encoded)) {
        entityRefs.push(structuredClone(history.entity) as V06EntityRef);
        seen.add(encoded);
      }
    }
    if (
      ['journal-entry', 'journal-note'].includes(history.entity.kind) &&
      history.after &&
      typeof history.after === 'object' &&
      !Array.isArray(history.after)
    ) {
      const text = (history.after as Readonly<Record<string, unknown>>).text;
      if (typeof text === 'string') textLength += text.length;
    }
  }
  const category = receipt.type.includes('Journal')
    ? 'journal'
    : /Decision|Synthesis|Material/.test(receipt.type)
      ? 'decision'
      : /RestoreWorkspace|ClearWorkspace|CommitMigration/.test(receipt.type)
        ? 'lifecycle'
        : 'business';
  const event: MaintenanceEvent = {
    eventId: `history:${encodeURIComponent(input.epoch)}:${encodeURIComponent(receipt.commandId)}`,
    epoch: input.epoch,
    at: first.at,
    date: dateAt(first.at, input.zone),
    zone: input.zone,
    category,
    operation: receipt.type,
    stage: 'succeeded',
    commandId: receipt.commandId,
    sourceHistoryIds: histories.map((h) => h.id),
    entityRefs,
    errorCode: null,
    details: { historyCount: histories.length, ...(category === 'journal' ? { textLength } : {}) },
  };
  validateEvent(event);
  return event;
}
export function appendMaintenanceEvents(
  existing: readonly MaintenanceEvent[],
  incoming: readonly MaintenanceEvent[],
): Readonly<{
  events: readonly MaintenanceEvent[];
  addedIds: readonly string[];
  replayedIds: readonly string[];
}> {
  const events = existing.map((event) => {
      validateEvent(event);
      return structuredClone(event);
    }),
    addedIds: string[] = [],
    replayedIds: string[] = [];
  if (new Set(events.map((e) => e.eventId)).size !== events.length)
    fail('eventId', '原维护区事件身份重复');
  for (const event of incoming) {
    validateEvent(event);
    const same = events.find((e) => e.eventId === event.eventId);
    if (same) {
      if (canonicalJson(same) !== canonicalJson(event)) fail('eventId', '同一事件 ID 的内容冲突');
      replayedIds.push(event.eventId);
      continue;
    }
    if (
      events.some(
        (e) =>
          e.epoch === event.epoch &&
          event.sourceHistoryIds.some((id) => e.sourceHistoryIds.includes(id)),
      )
    )
      fail('sourceHistoryIds', '同一历史不能被记为另一次成功操作');
    events.push(structuredClone(event));
    addedIds.push(event.eventId);
  }
  return { events, addedIds, replayedIds };
}
export function renderMaintenanceText(
  input: Readonly<{
    epoch: string;
    date: string;
    zone: string;
    events: readonly MaintenanceEvent[];
    hasGaps: boolean;
  }>,
): string {
  identifier(input.epoch, 'epoch');
  assertZone(input.zone);
  assertDate(input.date);
  const events = input.events.filter(
    (e) => e.epoch === input.epoch && e.date === input.date && e.zone === input.zone,
  );
  for (const event of events) validateEvent(event);
  events.sort(
    (a, b) =>
      compareInstants(a.at, b.at) || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  );
  const lines = [
    `# CardGrid 维护日志 ${input.date}`,
    `时区：${input.zone}`,
    `工作区：${JSON.stringify(input.epoch)}`,
    '',
    input.hasGaps ? '存在未落库事件缺口。' : '本批采集无已知缺口。',
    '',
  ];
  if (!events.length) lines.push('当天无已采集操作。');
  for (const event of events) {
    const at = displayInstant(event.at, event.zone);
    lines.push(
      `${at.date} ${at.time} ${at.offset}（UTC ${event.at}） ${event.category}/${event.operation} · ${event.stage} · ${JSON.stringify(event.eventId)} · ${canonicalJson({ commandId: event.commandId, sourceHistoryIds: event.sourceHistoryIds, entityRefs: event.entityRefs, errorCode: event.errorCode, details: event.details })}`,
    );
  }
  return lines.join('\n') + '\n';
}
export async function prepareMaintenanceText(
  input: Parameters<typeof renderMaintenanceText>[0] & Readonly<{ dayRevision: number }>,
) {
  if (!Number.isSafeInteger(input.dayRevision) || input.dayRevision < 0)
    fail('dayRevision', '需要维护日分区版本');
  const { dayRevision, ...renderInput } = input;
  return prepareTextDocument(renderMaintenanceText(renderInput), {
    kind: 'maintenance',
    epoch: input.epoch,
    dayRevision,
    inputFingerprint: await fingerprint(renderInput),
  });
}
