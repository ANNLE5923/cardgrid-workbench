/** Small removed-ID ledger keeps old receipts precise without retaining historical bodies. */
import type {
  DataV5,
  ArchiveRecordCollection,
  ArchiveRecordRef,
  ArchiveIndexEntry,
} from './contracts-v06.ts';
import { canonicalJson } from './format.ts';
import { V06ContractError } from './v06-validation.ts';
import { assertDate, assertZone } from '../daily/time.ts';
export const archiveCollections: readonly ArchiveRecordCollection[] = [
  'instances',
  'plans',
  'facts',
  'annotations',
  'fixed',
  'history',
  'journalEntries',
  'journalNotes',
  'handCards',
  'referencePlacements',
  'factReferenceSnapshots',
  'dailyCopies',
  'archiveLogs',
];
export const archiveKinds: Partial<Record<ArchiveRecordCollection, string>> = {
  instances: 'instance',
  plans: 'plan',
  facts: 'fact',
  annotations: 'annotation',
  fixed: 'fixed',
  journalEntries: 'journal-entry',
  journalNotes: 'journal-note',
  handCards: 'hand-card',
  referencePlacements: 'reference-placement',
  dailyCopies: 'daily-copy',
  archiveLogs: 'archive-log',
};
export const archiveRefKey = (r: ArchiveRecordRef) => JSON.stringify([r.collection, r.id]);
export function validateArchiveIndex(value: ArchiveIndexEntry) {
  const bad = (condition: unknown) => {
    if (!condition) throw new V06ContractError('ARCHIVE_INVALID', '$', '归档索引无效');
  };
  bad(
    value &&
      Object.keys(value).sort().join(',') ===
        [
          'archiveId',
          'workspaceId',
          'month',
          'zone',
          'manifestSha256',
          'recordsSha256',
          'coveredDates',
          'recordCounts',
        ]
          .sort()
          .join(','),
  );
  bad(
    typeof value.archiveId === 'string' &&
      !!value.archiveId.trim() &&
      typeof value.workspaceId === 'string' &&
      !!value.workspaceId.trim(),
  );
  bad(/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month));
  assertDate(value.month + '-01');
  assertZone(value.zone);
  bad(/^[a-f\d]{64}$/.test(value.manifestSha256) && /^[a-f\d]{64}$/.test(value.recordsSha256));
  bad(
    Array.isArray(value.coveredDates) &&
      new Set(value.coveredDates).size === value.coveredDates.length,
  );
  value.coveredDates.forEach(assertDate);
  bad(
    value.recordCounts &&
      typeof value.recordCounts === 'object' &&
      !Array.isArray(value.recordCounts),
  );
  for (const [key, n] of Object.entries(value.recordCounts))
    bad(
      archiveCollections.includes(key as ArchiveRecordCollection) &&
        Number.isSafeInteger(n) &&
        n >= 0,
    );
}
export function archivedEntityKeys(data: DataV5): Set<string> {
  const keys = new Set<string>(),
    indices = new Set<string>();
  for (const index of data.archiveIndex) {
    validateArchiveIndex(index);
    if (indices.has(index.archiveId) || index.workspaceId !== data.workspaceId)
      throw new V06ContractError('ARCHIVE_INVALID', '$', '重复索引或来源工作区不匹配');
    indices.add(index.archiveId);
    const log = data.planner.history.find(
        (h) =>
          h.type === 'CommitMonthlyArchive' &&
          h.entity.kind === 'archive' &&
          'id' in h.entity &&
          h.entity.id === index.archiveId,
      ),
      after = log?.after as any;
    if (
      !log ||
      log.before !== null ||
      !after ||
      Object.keys(after).sort().join(',') !== 'index,removed' ||
      canonicalJson(after.index) !== canonicalJson(index) ||
      !Array.isArray(after.removed) ||
      !data.commandReceipts.some(
        (r) =>
          r.commandId === log.commandId &&
          r.type === 'CommitMonthlyArchive' &&
          r.resultRefs.some((e) => e.kind === 'archive' && 'id' in e && e.id === index.archiveId),
      )
    )
      throw new V06ContractError('ARCHIVE_INVALID', '$', '归档缺少对应清理回执／摘要');
    const seen = new Set<string>(),
      counts: Record<string, number> = {};
    for (const ref of after.removed) {
      if (
        !ref ||
        Object.keys(ref).sort().join(',') !== 'collection,id' ||
        !archiveCollections.includes(ref.collection) ||
        typeof ref.id !== 'string' ||
        !ref.id
      )
        throw new V06ContractError('ARCHIVE_INVALID', '$', '清理摘要引用无效');
      const key = archiveRefKey(ref);
      if (seen.has(key)) throw new V06ContractError('ARCHIVE_INVALID', '$', '重复清理引用');
      seen.add(key);
      counts[ref.collection] = (counts[ref.collection] ?? 0) + 1;
      const kind = archiveKinds[ref.collection as ArchiveRecordCollection];
      if (kind) {
        const entity = JSON.stringify([kind, ref.id]);
        if (keys.has(entity))
          throw new V06ContractError('ARCHIVE_INVALID', '$', '同一记录重复归档');
        keys.add(entity);
      }
    }
    for (const [collection, n] of Object.entries(counts))
      if (n > (index.recordCounts[collection as ArchiveRecordCollection] ?? 0))
        throw new V06ContractError('ARCHIVE_INVALID', '$', '清理摘要超过包记录数');
  }
  return keys;
}
