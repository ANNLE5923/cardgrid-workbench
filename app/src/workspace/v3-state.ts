import type { DataV3, SlotSelection } from './contracts-v3.ts';
import { validateWorkshopCatalog } from '../workshop/model.ts';
import { assertContent, sameValue } from '../daily/model.ts';
import { compareInstants, dateAt, nextDate, weekday } from '../daily/time.ts';
import {
  assertWorkshopHistory,
  historicalWorkshopEntity,
  historicalInstantEntity,
  versionSnapshot,
  workshopCatalog,
} from './workshop-history.ts';
import { composeDailyCopy } from '../drawing/model.ts';

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function unique(ids: readonly string[], label: string): void {
  ensure(new Set(ids).size === ids.length, `${label} 标识重复`);
}

/** Runs after strict shapes and old daily invariants. No writes or lifecycle side effects. */
export function assertV3State(data: DataV3): void {
  const catalog = validateWorkshopCatalog(workshopCatalog(data));
  ensure(
    catalog.ok,
    catalog.ok ? '' : catalog.issues.map((i) => `${i.path}: ${i.message}`).join('; '),
  );
  assertWorkshopHistory(data);
  unique(
    data.dailyCopies.map((c) => c.id),
    '副本',
  );
  unique(
    data.archiveLogs.map((l) => l.id),
    '归档',
  );
  unique(
    data.archiveLogs.map((l) => l.copyId),
    '归档副本',
  );
  unique(
    data.generationLedger.map((l) => JSON.stringify([l.ruleId, l.sourceDate])),
    '规则来源日',
  );
  unique(
    data.generationLedger.map((l) => l.copyId),
    '生成记账副本',
  );
  const selectionSnapshot = (selection: SlotSelection) => {
    const original = versionSnapshot(
      data,
      'bookEntries',
      selection.entryId,
      selection.entrySnapshot.version,
    );
    ensure(
      original && sameValue(original, selection.entrySnapshot) && original.status === 'active',
      '书目来源版本快照不匹配',
    );
  };
  for (const entry of data.generationLedger) {
    const active = data.dailyCopies.find((c) => c.id === entry.copyId),
      archive = data.archiveLogs.find((l) => l.copyId === entry.copyId);
    ensure(!!active !== !!archive, '生成记账须恰好定位活动副本或归档日志');
    const item = active ?? archive!;
    ensure(
      item.ruleId === entry.ruleId && item.sourceDate === entry.sourceDate,
      '生成记账来源不匹配',
    );
    const currentRule = data.generationRules.find((r) => r.id === entry.ruleId);
    ensure(currentRule, '生成规则不存在');
    const generatedIndex = data.planner.history.findIndex(
      (h) =>
        h.type === 'GenerateDailyCopies' &&
        h.entity.kind === 'daily-copy' &&
        h.entity.id === entry.copyId,
    );
    ensure(generatedIndex >= 0, '副本缺少生成历史');
    const generated = data.planner.history[generatedIndex];
    ensure(generated.at === entry.at && generated.before === null, '生成历史时间或来源不匹配');
    const rule = historicalWorkshopEntity(
      data,
      'generationRules',
      entry.ruleId,
      entry.sourceDate,
      currentRule.zone,
      entry.at,
      generatedIndex,
    );
    const card =
      rule &&
      historicalWorkshopEntity(
        data,
        'actionCards',
        rule.actionCardId,
        entry.sourceDate,
        rule.zone,
        entry.at,
        generatedIndex,
      );
    ensure(
      rule && card && rule.status === 'active' && card.status === 'active',
      '副本没有可用历史原卡或规则版本',
    );
    const generatedDay = dateAt(entry.at, rule.zone);
    ensure(
      entry.sourceDate <= generatedDay && entry.sourceDate >= nextDate(generatedDay, -6),
      '来源日期超出生成保留窗口',
    );
    ensure(
      entry.sourceDate >= rule.startDate &&
        (rule.schedule.mode === 'daily' ||
          rule.schedule.weekdays.includes(weekday(entry.sourceDate))),
      '副本来源日不符合历史规则',
    );
    ensure(
      sameValue(item.actionCard, { id: card.id, version: card.version }) &&
        sameValue(item.contentSnapshot, card.content),
      '副本或归档内容快照不匹配',
    );
    assertContent(item.contentSnapshot);
    const originalCopy = {
      id: entry.copyId,
      version: 1,
      ruleId: rule.id,
      ruleVersion: rule.version,
      actionCard: { id: card.id, version: card.version },
      sourceDate: entry.sourceDate,
      generatedAt: entry.at,
      contentSnapshot: card.content,
      slotSpecSnapshot: card.slots,
      status: 'active' as const,
      acceptedInstanceIds: [],
    };
    ensure(sameValue(generated.after, originalCopy), '生成历史快照不匹配');
    if (active) {
      ensure(
        active.status === 'active' &&
          active.ruleVersion === rule.version &&
          active.generatedAt === entry.at,
        '活动副本规则版本或生成时间不匹配',
      );
      ensure(sameValue(active.slotSpecSnapshot, card.slots), '副本槽定义快照不匹配');
      ensure(active.version === 1 + active.acceptedInstanceIds.length, '副本版本与接受次数不一致');
    } else {
      ensure(
        dateAt(archive!.archivedAt, rule.zone) >= nextDate(entry.sourceDate, 7),
        '副本尚未到期不能归档',
      );
    }
    unique(item.acceptedInstanceIds, '接受记录');
    const accepted = data.planner.instances.filter((i) => i.daily?.copyId === entry.copyId);
    ensure(
      sameValue(
        item.acceptedInstanceIds,
        accepted.map((i) => i.id),
      ),
      '副本接受记录与实例不一致',
    );
    ensure(
      !!active || archive!.disposition === (accepted.length ? 'accepted' : 'none-accepted'),
      '归档处理结果与接受记录不一致',
    );
    for (const [acceptedNumber, instance] of accepted.entries()) {
      const acceptedIndex = data.planner.history.findIndex(
        (h) =>
          h.type === 'AcceptDailyCopy' &&
          h.entity.kind === 'instance' &&
          h.entity.id === instance.id,
      );
      ensure(acceptedIndex > generatedIndex, '接受实例缺少来源历史');
      const acceptedHistory = data.planner.history[acceptedIndex];
      const created = {
        ...instance,
        version: 1,
        currentContent: instance.creationSnapshot,
        targetDate: null,
        state: 'open',
      };
      ensure(
        acceptedHistory.before === null &&
          acceptedHistory.at === instance.createdAt &&
          sameValue(acceptedHistory.after, created),
        '接受创建历史快照不匹配',
      );
      const copyHistory = data.planner.history.find(
        (h) =>
          h.type === 'AcceptDailyCopy' &&
          h.commandId === acceptedHistory.commandId &&
          h.entity.kind === 'daily-copy' &&
          h.entity.id === entry.copyId,
      );
      const beforeAccept = {
        ...originalCopy,
        version: acceptedNumber + 1,
        acceptedInstanceIds: accepted.slice(0, acceptedNumber).map((i) => i.id),
      };
      const afterAccept = {
        ...beforeAccept,
        version: acceptedNumber + 2,
        acceptedInstanceIds: [...beforeAccept.acceptedInstanceIds, instance.id],
      };
      ensure(
        copyHistory &&
          copyHistory.at === instance.createdAt &&
          sameValue(copyHistory.before, beforeAccept) &&
          sameValue(copyHistory.after, afterAccept),
        '接受副本历史快照不匹配',
      );
      ensure(
        instance.source.kind === 'daily-copy' &&
          instance.source.id === entry.copyId &&
          instance.daily!.sourceDate === entry.sourceDate,
        '接受实例来源不匹配',
      );
      ensure(
        instance.definition === null &&
          instance.occurrenceId === null &&
          instance.makeupOf === null,
        '库存接受不能复用旧规则或补做身份',
      );
      ensure(
        compareInstants(instance.createdAt, entry.at) >= 0 &&
          dateAt(instance.createdAt, rule.zone) < nextDate(entry.sourceDate, 7),
        '接受时间无效或已到期',
      );
      unique(
        instance.daily!.slotSelections.map((s) => s.slotId),
        '接受槽位',
      );
      for (const selection of instance.daily!.slotSelections) {
        selectionSnapshot(selection);
        const slot = card.slots.find((s) => s.id === selection.slotId);
        ensure(
          slot &&
            compareInstants(selection.selectedAt, entry.at) >= 0 &&
            compareInstants(selection.selectedAt, instance.createdAt) <= 0,
          '接受槽位或选择时间无效',
        );
      }
      ensure(
        card.slots.every(
          (s) =>
            !s.required ||
            instance.daily!.slotSelections.some((selection) => selection.slotId === s.id),
        ),
        '接受实例缺少必填槽位',
      );
      const books = data.bookEntries
        .map((book) =>
          historicalInstantEntity(data, 'bookEntries', book.id, instance.createdAt, acceptedIndex),
        )
        .filter((book) => book !== null);
      const pools = data.pools
        .map((pool) =>
          historicalInstantEntity(data, 'pools', pool.id, instance.createdAt, acceptedIndex),
        )
        .filter((pool) => pool !== null);
      const composed = composeDailyCopy(
        originalCopy,
        instance.daily!.slotSelections,
        books,
        pools,
        instance.createdAt,
      );
      ensure(
        composed.ready &&
          sameValue(instance.creationSnapshot, { ...card.content, title: composed.composedText }),
        '接受行动创建内容与槽位快照不一致',
      );
    }
    if (archive) {
      const archivedHistory = data.planner.history.find(
        (h) =>
          h.type === 'ArchiveDueCopies' &&
          h.entity.kind === 'archive-log' &&
          h.entity.id === archive.id,
      );
      const beforeArchive = {
        ...originalCopy,
        version: accepted.length + 1,
        acceptedInstanceIds: accepted.map((i) => i.id),
      };
      ensure(
        archivedHistory &&
          archivedHistory.at === archive.archivedAt &&
          sameValue(archivedHistory.before, beforeArchive) &&
          sameValue(archivedHistory.after, archive),
        '归档历史快照不匹配',
      );
      ensure(
        sameValue(
          archive.slotSelectionsSnapshot,
          accepted.flatMap((i) => i.daily!.slotSelections),
        ),
        '归档词条快照与接受记录不一致',
      );
      archive.slotSelectionsSnapshot.forEach(selectionSnapshot);
      ensure(
        !data.planner.handOrder.some((id) => item.acceptedInstanceIds.includes(id)),
        '到期手牌仍在活动列表',
      );
      ensure(
        !data.planner.plans.some(
          (p) => p.status === 'active' && item.acceptedInstanceIds.includes(p.instanceId),
        ),
        '到期未完成排期未撤销',
      );
    }
  }
  for (const item of [...data.dailyCopies, ...data.archiveLogs]) {
    ensure(
      data.generationLedger.some((l) => l.copyId === ('copyId' in item ? item.copyId : item.id)),
      '库存或归档缺少生成记账',
    );
  }
  for (const instance of data.planner.instances) {
    if (instance.source.kind === 'daily-copy' || instance.daily) {
      ensure(
        instance.daily &&
          instance.source.kind === 'daily-copy' &&
          instance.source.id === instance.daily.copyId &&
          data.generationLedger.some((l) => l.copyId === instance.daily!.copyId),
        '每日接受来源缺少可追溯身份',
      );
      ensure(
        data.planner.facts
          .filter((f) => f.instanceId === instance.id)
          .every((f) => sameValue(f.source, instance.source)),
        '每日接受事实来源与实例不一致',
      );
    }
  }
}
