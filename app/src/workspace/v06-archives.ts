import type { WorkspaceStore } from './store.ts';
import type { Token, Range } from './contracts.ts';
import type {
  DataV5,
  ArchiveIndexEntry,
  ArchiveRecordsV1,
  MonthlyArchiveManifest,
  ArchivePreview,
  ArchiveView,
  V06Result,
  VerifiedArchiveEvidence,
  JournalAutoSegment,
} from './contracts-v06.ts';
import type { MonthlyArchivePort, V06Command, ArchiveClearPreview } from './ports-v06.ts';
import {
  archiveCapacity,
  archiveNeed,
  encodeArchiveZip,
  decodeArchiveZip,
  shaBytes,
} from './archive-zip.ts';
import {
  selectMonthlyRecords,
  archiveData,
  checkManifestRecords,
  removeArchivedRecords,
  recordDates,
} from './archive-data.ts';
import { archiveCollections, validateArchiveIndex } from './archive-ledger.ts';
import { validateMonthlyArchiveManifest, V06ContractError } from './v06-validation.ts';
import {
  validateDataV5,
  validateV5Fingerprints,
  assertActiveCapacity,
  fingerprint,
} from './v5-format.ts';
import { canonicalJson } from './format.ts';
import { checkToken, commandFailure } from './commands.ts';
import { todayView } from './v5-today.ts';
import { projectJournalTimeline, prepareJournalText } from '../journal/model.ts';
import {
  dateAt,
  assertDate,
  assertZone,
  compareInstants,
  dayRange,
  intersectRanges,
  recordRange,
} from '../daily/time.ts';
/** Browser adapter receives no exported bytes: only a new user-chosen external File. */
export type ArchiveRuntime = { pickSavedArchive(): Promise<Blob> };
export function createBrowserArchiveRuntime(): ArchiveRuntime {
  return {
    pickSavedArchive() {
      return new Promise((resolve, reject) => {
        const picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = '.zip,application/zip';
        picker.addEventListener(
          'change',
          () => {
            const file = picker.files?.[0];
            file
              ? resolve(file)
              : reject(new V06ContractError('ARCHIVE_NOT_VERIFIED', '$', '未选择保存的 ZIP'));
          },
          { once: true },
        );
        picker.addEventListener(
          'cancel',
          () => reject(new V06ContractError('ARCHIVE_NOT_VERIFIED', '$', '已取消外部 ZIP 核验')),
          { once: true },
        );
        picker.click();
      });
    },
  };
}
type Source = { loadV5(): Promise<V06Result<{ token: Token; data: DataV5 }>> };
type Decoded = {
  index: ArchiveIndexEntry;
  manifest: MonthlyArchiveManifest;
  pack: ArchiveRecordsV1;
  data: DataV5;
  bytes: number;
};
type ExportSession = { preview: ArchivePreview; zip: Blob; decoded: Decoded; exportId: string };
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b),
  encoder = new TextEncoder();
type FrozenTemplates = {
  createdAt: string;
  coverage: readonly Range[];
  segments: readonly JournalAutoSegment[];
};
/** Assign each actual interval to its first sealed source-day context. A viewing
 * day may span two source days with different template versions or time zones. */
function frozenTemplateSegments(
  contexts: readonly FrozenTemplates[],
  zone: string,
): JournalAutoSegment[] {
  const covered: Range[] = [],
    fragments = new Map<string, { source: JournalAutoSegment; ranges: Range[] }>();
  for (const context of [...contexts].sort((a, b) => compareInstants(a.createdAt, b.createdAt)))
    for (const window of context.coverage) {
      let remaining: Range[] = [window];
      for (const used of covered)
        remaining = remaining.flatMap((range) => {
          const overlap = intersectRanges(range, used);
          if (!overlap) return [range];
          return [
            ...(compareInstants(range.startAt, overlap.startAt) < 0
              ? [{ startAt: range.startAt, endAt: overlap.startAt, zone }]
              : []),
            ...(compareInstants(overlap.endAt, range.endAt) < 0
              ? [{ startAt: overlap.endAt, endAt: range.endAt, zone }]
              : []),
          ];
        });
      for (const segment of context.segments)
        for (const range of remaining) {
          const clip = intersectRanges(segment.clippedRange, range);
          if (!clip) continue;
          const key = JSON.stringify([segment.sourceKey, segment.range]),
            item = fragments.get(key) ?? { source: segment, ranges: [] };
          item.ranges.push({ ...clip, zone });
          fragments.set(key, item);
        }
      covered.push(window);
    }
  return [...fragments.values()].flatMap(({ source, ranges }) => {
    const merged: Range[] = [];
    for (const range of ranges.sort((a, b) => compareInstants(a.startAt, b.startAt))) {
      const prior = merged.at(-1);
      if (prior && compareInstants(range.startAt, prior.endAt) <= 0) {
        merged[merged.length - 1] = {
          ...prior,
          endAt: compareInstants(range.endAt, prior.endAt) > 0 ? range.endAt : prior.endAt,
        };
      } else merged.push(range);
    }
    return merged.map((range) => ({
      ...source,
      id: merged.length === 1 ? source.id : source.id + ':' + range.startAt,
      clippedRange: recordRange(range),
    }));
  });
}
export function createV06Archives(options: {
  store: WorkspaceStore;
  source: Source;
  now: () => string;
  id: () => string;
  runtime?: ArchiveRuntime;
}) {
  const { store, source, now, id } = options,
    runtime = options.runtime ?? createBrowserArchiveRuntime();
  const previews = new Map<string, { preview: ArchivePreview; pack: ArchiveRecordsV1 }>(),
    exports = new Map<string, ExportSession>(),
    verifications = new Map<string, VerifiedArchiveEvidence>(),
    clears = new Map<string, ArchiveClearPreview>(),
    cache = new Map<string, Decoded>();
  let generation = 0;
  const wrap = async <T>(f: () => Promise<T>): Promise<V06Result<T>> => {
    try {
      return { ok: true, value: await f() };
    } catch (e) {
      if (!(e instanceof V06ContractError)) return commandFailure(e);
      return {
        ok: false,
        code: e.code,
        message: e.message,
        retry: ['WORKSPACE_REPLACED', 'REVISION_CONFLICT'].includes(e.code) ? 'reload' : 'edit',
      };
    }
  };
  const live = async (token?: Token) => {
    const s = await source.loadV5();
    if (!s.ok) throw new V06ContractError(s.code, '$', s.message);
    if (token) checkToken(s.value.token, token);
    return s.value;
  };
  const read = async (key: string) => {
    archiveNeed(!!store.readMonthlyArchive, 'ARCHIVE_INVALID', '归档存储不可用');
    return store.readMonthlyArchive!(key);
  };
  const indices = async () => {
    archiveNeed(!!store.listMonthlyArchiveIndex, 'ARCHIVE_INVALID', '归档存储不可用');
    const all = await store.listMonthlyArchiveIndex!();
    all.forEach((x) => validateArchiveIndex(x as ArchiveIndexEntry));
    return all as ArchiveIndexEntry[];
  };
  const atomic = <T>(
    keys: readonly string[],
    reduce: Parameters<NonNullable<WorkspaceStore['atomicMonthlyArchive']>>[1],
  ) => {
    archiveNeed(!!store.atomicMonthlyArchive, 'ARCHIVE_INVALID', '归档原子事务不可用');
    return store.atomicMonthlyArchive!(keys, reduce) as Promise<T>;
  };
  async function decode(zip: Blob): Promise<Decoded> {
    try {
      const files = await decodeArchiveZip(zip),
        decoder = new TextDecoder('utf-8', { fatal: true });
      const manifest = JSON.parse(decoder.decode(files['manifest.json']));
      validateMonthlyArchiveManifest(manifest);
      const pack = JSON.parse(decoder.decode(files['records.json'])) as ArchiveRecordsV1;
      archiveNeed(
        manifest.files[0].bytes === files['records.json'].length &&
          manifest.files[0].sha256 === (await shaBytes(files['records.json'])),
        'ARCHIVE_INVALID',
        'records.json 字节数或 SHA-256 不符',
      );
      checkManifestRecords(manifest, pack);
      const data = archiveData(pack, manifest.workspaceId);
      await validateV5Fingerprints(data);
      const index = {
        archiveId: manifest.archiveId,
        workspaceId: manifest.workspaceId,
        month: manifest.month,
        zone: manifest.zone,
        manifestSha256: await shaBytes(files['manifest.json']),
        recordsSha256: manifest.files[0].sha256,
        coveredDates: manifest.coveredDates,
        recordCounts: manifest.recordCounts,
      };
      validateArchiveIndex(index);
      return {
        index,
        manifest,
        pack,
        data,
        bytes: files['manifest.json'].length + files['records.json'].length,
      };
    } catch (e) {
      if (e instanceof V06ContractError) throw e;
      throw new V06ContractError(
        'ARCHIVE_INCOMPLETE',
        '$',
        e instanceof Error ? e.message : '归档依赖不完整',
      );
    }
  }
  async function load(archiveId: string, ticket = generation): Promise<Decoded> {
    const old = cache.get(archiveId);
    if (old) return old;
    const zip = await read('zip:' + archiveId),
      index = await read('index:' + archiveId);
    archiveNeed(
      zip instanceof Blob && !!index,
      'ARCHIVE_MISSING',
      '归档 ZIP 缺失，请重新导入匹配的外部包',
    );
    const d = await decode(zip as Blob);
    archiveNeed(equal(d.index, index), 'ARCHIVE_CONFLICT', '归档索引与 ZIP 不符');
    if (ticket === generation) {
      cache.clear();
      cache.set(archiveId, d);
    }
    return d;
  }
  function projection(d: DataV5, token: Token, date: string, zone: string) {
    assertDate(date);
    assertZone(zone);
    return projectJournalTimeline({
      day: todayView(d, token, { date, zone }, now()),
      templates: d.planner.templates,
      notes: d.journalNotes,
      legacyEntries: d.journalEntries,
      materials: d.handCards,
      references: d.referencePlacements,
      factReferences: d.factReferenceSnapshots,
    });
  }
  const cacheState = () => ({
    loadedArchiveIds: [...cache.keys()],
    decodedBytes: [...cache.values()].reduce((n, d) => n + d.bytes, 0),
    maxLoadedMonths: 1 as const,
  });
  async function coverage(data: DataV5) {
    const all = store.listMonthlyArchiveIndex && store.readMonthlyArchive ? await indices() : [],
      required = data.archiveIndex.map(
        ({ archiveId, workspaceId, manifestSha256, recordsSha256 }) => ({
          archiveId,
          workspaceId,
          manifestSha256,
          recordsSha256,
        }),
      ),
      availableArchiveIds: string[] = [];
    for (const index of all)
      if ((await read('zip:' + index.archiveId)) instanceof Blob)
        availableArchiveIds.push(index.archiveId);
    const missing = required.filter(
      (r) =>
        !all.some(
          (i) =>
            i.archiveId === r.archiveId &&
            i.workspaceId === r.workspaceId &&
            i.manifestSha256 === r.manifestSha256 &&
            i.recordsSha256 === r.recordsSha256 &&
            availableArchiveIds.includes(i.archiveId),
        ),
    );
    return {
      kind: 'active-plus-archives' as const,
      required,
      availableArchiveIds,
      missing,
      complete: missing.length === 0,
    };
  }
  const port: MonthlyArchivePort = {
    stamp: { contractVersion: 'v06-p0-1', backend: 'formal', release: 'draft' },
    readArchivableMonths: (input) =>
      wrap(async () => {
        const s = await live(input.token);
        assertZone(input.zone);
        const months = new Set<string>();
        for (const c of archiveCollections)
          if (c !== 'history') {
            const records = (
              c in s.data.planner ? (s.data.planner as any)[c] : (s.data as any)[c]
            ) as any[];
            for (const item of records)
              for (const date of recordDates(c, item, input.zone))
                if (date.slice(0, 7) < dateAt(now(), input.zone).slice(0, 7))
                  months.add(date.slice(0, 7));
          }
        const result = [];
        for (const month of [...months].sort()) {
          const selected = selectMonthlyRecords(s.data, month, input.zone, now());
          if (selected.selected.length)
            result.push({
              month,
              zone: input.zone,
              eligibleRecords: selected.selected.length,
              retainedRecords: selected.retained.length,
              estimatedBytes: encoder.encode(JSON.stringify(selected.pack)).length,
            });
        }
        return { access: 'live', token: s.token, data: result };
      }),
    previewMonthlyArchive: (input) =>
      wrap(async () => {
        const s = await live(input.token),
          selected = selectMonthlyRecords(s.data, input.month, input.zone, now());
        archiveNeed(
          selected.selected.length > 0,
          'ARCHIVE_INCOMPLETE',
          '没有可移出的封存记录；活动引用继续保留',
        );
        const bytes = encoder.encode(JSON.stringify(selected.pack));
        const previewId = id(),
          archiveId = id(),
          manifest: MonthlyArchiveManifest = {
            format: 'cardgrid-monthly-archive',
            version: 1,
            archiveId,
            workspaceId: s.data.workspaceId,
            month: input.month,
            zone: input.zone,
            createdAt: now(),
            sourceToken: s.token,
            sourceDataFormat: 'action-v5',
            closure: 'self-contained',
            coveredDates: selected.coveredDates,
            recordCounts: Object.fromEntries(
              archiveCollections.map((c) => [c, selected.pack.records[c].length]),
            ),
            files: [{ path: 'records.json', sha256: await shaBytes(bytes), bytes: bytes.length }],
          };
        archiveNeed(
          bytes.length + encoder.encode(JSON.stringify(manifest)).length <=
            archiveCapacity.maxArchiveExpandedBytes,
          'ARCHIVE_BUDGET_EXCEEDED',
          '归档展开容量超限',
        );
        const preview: ArchivePreview = {
          previewId,
          token: s.token,
          workspaceId: s.data.workspaceId,
          month: input.month,
          zone: input.zone,
          sourceFingerprint: await fingerprint(s.data),
          manifest,
          selected: selected.selected,
          retained: selected.retained,
          bytes: bytes.length,
          blockingIssues: [],
        };
        previews.clear();
        exports.clear();
        verifications.clear();
        clears.clear();
        previews.set(previewId, { preview, pack: selected.pack });
        return structuredClone(preview);
      }),
    exportMonthlyArchive: (input) =>
      wrap(async () => {
        await live(input.token);
        const p = previews.get(input.previewId);
        archiveNeed(
          p && equal(p.preview.token, input.token),
          'ARCHIVE_NOT_VERIFIED',
          '归档预览已失效',
        );
        const zip = await encodeArchiveZip({
            'manifest.json': encoder.encode(JSON.stringify(p!.preview.manifest)),
            'records.json': encoder.encode(JSON.stringify(p!.pack)),
          }),
          decoded = await decode(zip),
          exportId = id();
        exports.clear();
        exports.set(exportId, { preview: p!.preview, zip, decoded, exportId });
        return {
          exportId,
          previewId: input.previewId,
          token: input.token,
          archiveId: p!.preview.manifest.archiveId,
          filename: `CardGrid-${encodeURIComponent(p!.preview.workspaceId)}-${p!.preview.month}-${encodeURIComponent(p!.preview.manifest.archiveId)}.zip`,
          compressedBytes: zip.size,
          zip,
        };
      }),
    verifySavedArchive: (input) => {
      const external = runtime.pickSavedArchive().then(
        (zip) => ({ zip, error: null }),
        (error) => ({ zip: null, error }),
      );
      return wrap(async () => {
        const s = await live(input.token),
          session = exports.get(input.exportId),
          ticket = generation;
        archiveNeed(
          session && equal(session.preview.token, s.token),
          'ARCHIVE_NOT_VERIFIED',
          '导出证明已失效',
        );
        const chosen = await external;
        if (chosen.error) throw chosen.error;
        archiveNeed(chosen.zip instanceof Blob, 'ARCHIVE_NOT_VERIFIED', '未读取外部文件');
        const d = await decode(chosen.zip!);
        archiveNeed(
          ticket === generation && equal(d.index, session!.decoded.index),
          'ARCHIVE_NOT_VERIFIED',
          '外部包不匹配本次导出',
        );
        await live(input.token);
        const evidence: VerifiedArchiveEvidence = {
          verificationId: id(),
          exportId: input.exportId,
          previewId: session!.preview.previewId,
          token: input.token,
          archiveId: d.index.archiveId,
          manifestSha256: d.index.manifestSha256,
          recordsSha256: d.index.recordsSha256,
          verifiedAt: now(),
          origin: 'external-reread',
        };
        verifications.set(evidence.verificationId, evidence);
        return evidence;
      });
    },
    previewArchiveClear: (input) =>
      wrap(async () => {
        await live(input.token);
        const p = previews.get(input.previewId),
          v = verifications.get(input.verificationId);
        archiveNeed(
          p && v && v.previewId === input.previewId && equal(v.token, input.token),
          'ARCHIVE_NOT_VERIFIED',
          '缺少会话签发的外部核验证明',
        );
        const value: ArchiveClearPreview = {
          clearPreviewId: id(),
          token: input.token,
          archiveId: v!.archiveId,
          verificationId: input.verificationId,
          removableCount: p!.preview.selected.length,
          retainedCount: p!.preview.retained.length,
          sourceFingerprint: p!.preview.sourceFingerprint,
        };
        clears.set(value.clearPreviewId, value);
        return value;
      }),
    importArchive: (input) =>
      wrap(async () => {
        const d = await decode(input.zip),
          indexKey = 'index:' + d.index.archiveId;
        return atomic([indexKey, 'zip:' + d.index.archiveId], ([old]) => {
          archiveNeed(
            !old || equal(old, d.index),
            'ARCHIVE_CONFLICT',
            '同一 archiveId 的内容不同，原包保留',
          );
          return {
            result: {
              index: d.index,
              disposition: old ? 'duplicate' : 'added',
              storedCompressedBytes: input.zip.size,
            },
            archiveWrites: [
              ...(old ? [] : [{ key: indexKey, value: d.index }]),
              { key: 'zip:' + d.index.archiveId, value: input.zip },
            ],
          };
        });
      }),
    readArchiveIndex: () => wrap(indices),
    readArchive: (input) =>
      wrap(async () => {
        const ticket = ++generation,
          d = await load(input.archiveId, ticket);
        archiveNeed(ticket === generation, 'ARCHIVE_INVALID', '归档切换已失效');
        const view: ArchiveView = {
          access: 'archive',
          editable: false,
          index: d.index,
          catalog: d.pack.catalogSnapshot,
          instances: d.pack.records.instances,
          plans: d.pack.records.plans,
          facts: d.pack.records.facts,
          annotations: d.pack.records.annotations,
          journal: d.manifest.coveredDates.map(
            (date) => projection(d.data, d.manifest.sourceToken, date, d.manifest.zone).timeline,
          ),
        };
        return structuredClone(view);
      }),
    releaseArchive: (input) =>
      wrap(async () => {
        generation++;
        cache.delete(input.archiveId);
        return cacheState();
      }),
    readArchiveCacheState: () => wrap(async () => cacheState()),
    readRecoveryCoverage: () => wrap(async () => coverage((await live()).data)),
  };
  async function commit(
    command: Extract<V06Command, { type: 'CommitMonthlyArchive' }>,
    digest: string,
    at: string,
  ) {
    const before = await live();
    checkToken(before.token, command.expected, false);
    const replay = before.data.commandReceipts.find((r) => r.commandId === command.commandId);
    if (replay) {
      if (replay.type !== command.type || replay.payloadFingerprint !== digest)
        throw new V06ContractError('COMMAND_ID_REUSED', '$', '请求标识已用于另一内容');
      return { token: before.token, resultRefs: replay.resultRefs, replayed: true };
    }
    checkToken(before.token, command.expected);
    const p = previews.get(command.payload.previewId),
      v = verifications.get(command.payload.verificationId),
      clear = clears.get(command.payload.clearPreviewId);
    archiveNeed(
      p &&
        v &&
        clear &&
        command.payload.removalConfirmed === true &&
        v.previewId === p.preview.previewId &&
        clear.verificationId === v.verificationId &&
        clear.archiveId === v.archiveId &&
        equal(clear.token, before.token),
      'ARCHIVE_NOT_VERIFIED',
      '清理需要匹配的预览、外部核验和明确确认',
    );
    const session = exports.get(v!.exportId);
    archiveNeed(session, 'ARCHIVE_NOT_VERIFIED', '原导出会话缺失');
    archiveNeed(
      (await fingerprint(before.data)) === clear!.sourceFingerprint,
      'ARCHIVE_NOT_VERIFIED',
      '归档源已改变',
    );
    const index = session!.decoded.index,
      data0 = removeArchivedRecords(before.data, p!.preview.selected),
      ref = { kind: 'archive' as const, id: index.archiveId };
    const data: DataV5 = {
      ...data0,
      archiveIndex: [...data0.archiveIndex, index],
      commandReceipts: [
        ...data0.commandReceipts,
        {
          commandId: command.commandId,
          type: command.type,
          payloadFingerprint: digest,
          resultRefs: [ref],
        },
      ],
      planner: {
        ...data0.planner,
        history: [
          ...data0.planner.history,
          {
            id: command.commandId + ':archive',
            commandId: command.commandId,
            type: command.type,
            at,
            date: dateAt(at, index.zone),
            entity: ref,
            before: null,
            after: { index, removed: p!.preview.selected } as any,
          },
        ],
      },
    };
    validateDataV5(data);
    assertActiveCapacity(data);
    const result = await atomic<{
      token: Token;
      resultRefs: readonly (typeof ref)[];
      replayed: boolean;
    }>(['index:' + index.archiveId, 'zip:' + index.archiveId], ([old], raw: any) => {
      checkToken({ epoch: raw?.epoch, revision: raw?.revision }, command.expected);
      archiveNeed(
        raw?.dataFormat === 'action-v5' && equal(raw.data, before.data),
        'ARCHIVE_NOT_VERIFIED',
        '清理期间工作区已改变',
      );
      archiveNeed(!old || equal(old, index), 'ARCHIVE_CONFLICT', '本机同 ID 包冲突');
      const token = { epoch: before.token.epoch, revision: before.token.revision + 1 };
      archiveNeed(Number.isSafeInteger(token.revision), 'ARCHIVE_INVALID', '修订号溢出');
      return {
        write: { ...raw, ...token, data },
        at,
        reason: command.type,
        archiveWrites: [
          { key: 'index:' + index.archiveId, value: index },
          { key: 'zip:' + index.archiveId, value: session!.zip },
        ],
        result: { token, resultRefs: [ref], replayed: false },
      };
    });
    previews.clear();
    exports.clear();
    verifications.clear();
    clears.clear();
    cache.clear();
    return result;
  }
  async function fullProjection(token: Token, date: string, zone: string) {
    const s = await live(token);
    let combined = s.data,
      historicalContext: {
        createdAt: string;
        settings: DataV5['settings'];
        templates: DataV5['planner']['templates'];
        days: DataV5['planner']['days'];
      } | null = null;
    const displayed = dayRange(date, zone),
      frozenTemplates: FrozenTemplates[] = [];
    for (const index of s.data.archiveIndex) {
      if (
        !index.coveredDates.includes(date) &&
        !index.coveredDates.some((covered) =>
          intersectRanges(dayRange(covered, index.zone), displayed),
        )
      )
        continue;
      const d = await load(index.archiveId);
      archiveNeed(equal(index, d.index), 'ARCHIVE_CONFLICT', '活动索引与包不符');
      const pack = d.pack,
        r = pack.records;
      // The first sealed context of a day defines its virtual template/sleep
      // projection. Later catalog/settings edits or another overlapping package
      // must not replace it. Explicitly retained records still merge below.
      if (
        !historicalContext ||
        compareInstants(d.manifest.createdAt, historicalContext.createdAt) < 0
      )
        historicalContext = {
          createdAt: d.manifest.createdAt,
          settings: d.data.settings,
          templates: d.data.planner.templates,
          days: d.data.planner.days,
        };
      frozenTemplates.push({
        createdAt: d.manifest.createdAt,
        coverage: index.coveredDates.flatMap((covered) => {
          const clip = intersectRanges(dayRange(covered, index.zone), displayed);
          return clip ? [{ ...clip, zone }] : [];
        }),
        segments: projection(d.data, token, date, zone).timeline.automatic.filter(
          (segment) => segment.sourceKind === 'template',
        ),
      });
      // One package is decoded at a time; retain only this day's ranges and their display sources.
      const plans = r.plans.filter((p) => recordDates('plans', p, zone).includes(date)),
        facts = r.facts.filter((f) => recordDates('facts', f, zone).includes(date)),
        instances = new Set([...plans, ...facts].map((p) => p.instanceId)),
        factIds = new Set(facts.map((f) => f.id));
      const references = r.referencePlacements.filter((p) =>
          p.mode === 'point'
            ? dateAt(p.point.at, zone) === date
            : instances.has(p.targetInstanceId),
        ),
        answers = new Set(references.map((p) => p.answerId));
      const merge = (current: readonly any[], old: readonly any[]) => {
        const ids = new Set(current.map((i) => i.id ?? i.factId));
        return [...current, ...old.filter((i) => !ids.has(i.id ?? i.factId))];
      };
      combined = {
        ...combined,
        journalNotes: merge(
          combined.journalNotes,
          r.journalNotes.filter((n) => n.date === date),
        ) as any,
        journalEntries: merge(
          combined.journalEntries,
          r.journalEntries.filter((n) => n.date === date),
        ) as any,
        handCards: merge(
          combined.handCards,
          r.handCards.filter(
            (c) =>
              answers.has(c.id) ||
              ((c.kind === 'action' || c.kind === 'composite') &&
                instances.has(c.actionInstanceId ?? '')),
          ),
        ) as any,
        referencePlacements: merge(combined.referencePlacements, references) as any,
        factReferenceSnapshots: merge(
          combined.factReferenceSnapshots,
          r.factReferenceSnapshots.filter((f) => factIds.has(f.factId)),
        ) as any,
        planner: {
          ...combined.planner,
          instances: merge(
            combined.planner.instances,
            r.instances.filter((i) => instances.has(i.id)),
          ),
          plans: merge(combined.planner.plans, plans),
          facts: merge(combined.planner.facts, facts),
          annotations: merge(
            combined.planner.annotations,
            r.annotations.filter((a) => factIds.has(a.factId)),
          ),
          fixed: merge(
            combined.planner.fixed,
            r.fixed.filter((f) => recordDates('fixed', f, zone).includes(date)),
          ),
        } as any,
      };
    }
    if (historicalContext) {
      const frozen = historicalContext;
      const savedDates = new Set(frozen.days.map((day) => day.date));
      combined = {
        ...combined,
        settings: frozen.settings,
        planner: {
          ...combined.planner,
          templates: frozen.templates,
          days: [
            ...frozen.days,
            ...combined.planner.days.filter((day) => !savedDates.has(day.date)),
          ],
        },
      };
    }
    await live(token);
    const result = projection(combined, token, date, zone);
    if (!historicalContext) return result;
    const ordinal = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const automatic = [
      ...result.timeline.automatic.filter((segment) => segment.sourceKind !== 'template'),
      ...frozenTemplateSegments(frozenTemplates, zone),
    ].sort(
      (a, b) =>
        compareInstants(a.range.startAt, b.range.startAt) || ordinal(a.sourceKey, b.sourceKey),
    );
    const rows = [
      ...result.rows.filter(
        (row) => row.kind !== 'automatic' || row.segment.sourceKind !== 'template',
      ),
      ...automatic
        .filter((segment) => segment.sourceKind === 'template')
        .map((segment) => ({
          kind: 'automatic' as const,
          at: segment.range.startAt,
          id: segment.id,
          segment,
        })),
    ].sort((a, b) => compareInstants(a.at, b.at) || ordinal(a.kind, b.kind) || ordinal(a.id, b.id));
    return { ...result, timeline: { ...result.timeline, automatic }, rows };
  }
  const discardPreview = () => {
    generation++;
    previews.clear();
    exports.clear();
    verifications.clear();
    clears.clear();
  };
  return {
    port,
    commit,
    coverage,
    discardPreview,
    fullProjection,
    fullJournal: async (token: Token, date: string, zone: string) =>
      prepareJournalText(await fullProjection(token, date, zone)),
    projection,
    async readonlyProjection(archiveId: string, date: string, zone: string) {
      const d = await load(archiveId),
        { token: sourceToken, ...readonly } = projection(
          d.data,
          d.manifest.sourceToken,
          date,
          zone,
        );
      return {
        access: 'archive' as const,
        editable: false as const,
        archiveId,
        projection: readonly,
      };
    },
    async journal(archiveId: string, date: string, zone: string) {
      const d = await load(archiveId);
      return {
        access: 'archive' as const,
        editable: false as const,
        archiveId,
        data: projection(d.data, d.manifest.sourceToken, date, zone).timeline,
      };
    },
    invalidate() {
      discardPreview();
      cache.clear();
    },
    capacityPolicy: archiveCapacity,
  };
}
