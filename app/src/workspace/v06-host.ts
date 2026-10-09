/** B4 formal core on the existing WorkspaceStore. Opt-in factory; no boot-time activation.
 * B5/B8 add the full UI business port. This core deliberately does not claim its port stamp.
 */
import type {
  Command,
  BackupEvidence,
  Token,
  EnvelopeV4,
  LifecycleReceipt,
  EntityRef,
} from './contracts.ts';
import type {
  DataV5,
  DecisionPreview,
  SelectedAnswer,
  SynthesisPreview,
  ReferencePreview,
  V06Result,
  SubmitV06Value,
  FieldResolution,
  ReferenceDraft,
  CatalogV06,
  MaintenanceEvent,
} from './contracts-v06.ts';
import type { V06Command } from './ports-v06.ts';
import type { DataV4 } from './contracts-v4.ts';
import { createWorkspaceStore, type WorkspaceStore, type WorkspaceSlotChange } from './store.ts';
import {
  inspectSnapshot,
  checkToken,
  assertCommand,
  commandFailure,
  createActionService,
} from './commands.ts';
import {
  canonicalJson,
  exportWorkspace,
  validateWorkspace,
  emptyWorkspaceData,
  type RestoreTarget,
} from './format.ts';
import { V06ContractError, validateV06CommandInput } from './v06-validation.ts';
import {
  backupV5,
  validateDataV5,
  validateV5Fingerprints,
  parseV06Restore,
  parseConfigV4,
  activeBytes,
  assertActiveCapacity,
  MAX_BACKUP_BYTES,
  MAX_INPUT_BYTES,
  fingerprint,
  exactRecord,
  catalogOf,
  formatNeed,
} from './v5-format.ts';
import { exportConfigV4, readConfiguration } from './v5-config.ts';
import { prepareV5Migration } from './v5-migration.ts';
import {
  applyV5Command,
  materialContext,
  sourceAction,
  needV5,
  type BusinessGrant,
} from './v5-operations.ts';
import {
  collectDecisionCandidates,
  selectDecisionAnswer,
  previewSynthesis,
  previewReferencePlacement,
} from '../decision/model.ts';
import { assertInstant } from '../daily/time.ts';
import { createV06Maintenance } from './v06-maintenance.ts';
import {
  createCommittedEvent,
  createLifecycleEvent,
  createOperationEvent,
  createListUrlEvent,
} from '../maintenance/model.ts';
import { applyDaily, type TakeDailyMaterialCommand } from './v5-daily.ts';
import { todayTypes, plannerView, todayView, applyToday } from './v5-today.ts';
import { projectJournalTimeline } from '../journal/model.ts';
import { assertDate, assertZone } from '../daily/time.ts';
import { projectUnifiedHand } from '../daily/model.ts';
import {
  createTextOutputSession,
  type TextRuntime,
  type TextRepository,
} from '../text-output/index.ts';
import { createV06Archives, type ArchiveRuntime } from './v06-archives.ts';
import { createV06TextSource } from './v06-text-source.ts';

type V5Envelope = Readonly<{
  schemaVersion: 4;
  epoch: string;
  revision: number;
  mode: 'current';
  dataFormat: 'action-v5';
  data: DataV5;
  lifecycleReceipt: LifecycleReceipt | null;
}>;
type Snapshot = {
  token: Token;
  data: DataV5 | DataV4 | RestoreTarget['data'] | null;
  raw: unknown;
  rawKey: string;
  mode: 'uninitialized' | 'current' | 'legacy-readonly';
};
type LifecycleCommand = Extract<
  Command,
  { type: 'RestoreWorkspace' | 'CommitMigration' | 'ClearWorkspace' }
>;
export type TodaySubmitValue = Readonly<{
  token: Token;
  resultRefs: readonly (EntityRef | import('./contracts-v06.ts').V06EntityRef)[];
  replayed: boolean;
}>;
export interface V06Submit {
  (command: V06Command): Promise<V06Result<SubmitV06Value>>;
  (command: Command | TakeDailyMaterialCommand): Promise<V06Result<TodaySubmitValue>>;
  (command: V06Command | Command | TakeDailyMaterialCommand): Promise<V06Result<TodaySubmitValue>>;
}
type Grant = { token: Token; value: BusinessGrant };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const isV5 = (raw: any): raw is V5Envelope =>
  raw?.schemaVersion === 4 && raw?.mode === 'current' && raw?.dataFormat === 'action-v5';
function validateV5Envelope(raw: V5Envelope) {
  exactRecord(raw, [
    'schemaVersion',
    'epoch',
    'revision',
    'mode',
    'dataFormat',
    'data',
    'lifecycleReceipt',
  ]);
  formatNeed(
    typeof raw.epoch === 'string' &&
      !!raw.epoch.trim() &&
      Number.isSafeInteger(raw.revision) &&
      raw.revision >= 0,
    'token',
    'invalid envelope token',
  );
  validateDataV5(raw.data);
  // Reuse the original exact lifecycle-receipt validator without altering its recorded tokens.
  if (raw.lifecycleReceipt !== null) {
    const { data, ...rest } = raw;
    validateWorkspace({ ...rest, dataFormat: 'action-v4', data: emptyWorkspaceData() });
  }
}
// A tiny empty legacy view validates receipt shape; business data uses validateDataV5.
const grandfatheredDecks = (data: DataV5) =>
  data.decks.filter(
    (d) =>
      d.memberIds.length > 100 &&
      data.planner.history.some(
        (h) => h.type === 'MigrateCatalogV5' && h.entity.kind === 'deck' && same(h.after, d),
      ),
  );

export function createV06Host(
  options: {
    store?: WorkspaceStore;
    now?: () => string;
    id?: () => string;
    random?: () => number;
    textRuntime?: TextRuntime;
    textDebounceMs?: number;
    archiveRuntime?: ArchiveRuntime;
  } = {},
) {
  const store = options.store ?? createWorkspaceStore(),
    now = options.now ?? (() => new Date().toISOString()),
    id = options.id ?? (() => crypto.randomUUID()),
    random = options.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]);
  const maintenance = createV06Maintenance(store);
  let collection = Promise.resolve();
  const grants = new Map<string, Grant>(),
    decisions = new Map<
      string,
      {
        token: Token;
        input: { decision: { id: string; version: number }; deckIds: readonly string[] };
        value: DecisionPreview;
      }
    >(),
    selections = new Map<string, SelectedAnswer>();
  const lifecycle = new Map<
    string,
    {
      token: Token;
      kind: 'CommitMigration' | 'RestoreWorkspace';
      target: ReturnType<typeof parseV06Restore>;
      migration?: { workspaceId: string; at: string };
    }
  >();
  const backups = new Map<string, { token: Token; dataFingerprint: string }>(),
    evidenceIds = new Map<string, BackupEvidence>();
  const wrap = async <T>(fn: () => Promise<T>): Promise<V06Result<T>> => {
    try {
      return { ok: true, value: await fn() };
    } catch (e) {
      if (e instanceof V06ContractError)
        return {
          ok: false,
          code: e.code,
          message: e.message,
          field: e.field,
          retry: ['ENTRY_STALE', 'REVISION_CONFLICT', 'WORKSPACE_REPLACED'].includes(e.code)
            ? 'reload'
            : e.code === 'PREVIEW_STALE'
              ? 'preview'
              : 'edit',
        };
      return commandFailure(e);
    }
  };
  function invalidate() {
    archives?.invalidate();
    planner?.invalidateCapabilities();
    grants.clear();
    decisions.clear();
    selections.clear();
    lifecycle.clear();
  }
  async function snapshot(): Promise<Snapshot> {
    const raw = await store.read();
    if (isV5(raw)) {
      validateV5Envelope(raw);
      await validateV5Fingerprints(raw.data);
      return {
        token: { epoch: raw.epoch, revision: raw.revision },
        data: raw.data,
        raw,
        rawKey: canonicalJson(raw),
        mode: 'current',
      };
    }
    return inspectSnapshot(raw);
  }
  const planner = createActionService(store, {
    now,
    id,
    readSnapshot: async () => {
      const s = await snapshot();
      needV5(isV5(s.raw), 'UNSUPPORTED_VERSION', '请先显式升级到 Data v5');
      return { ...s, data: plannerView(s.raw.data) };
    },
  });
  async function live(token: Token) {
    const snap = await snapshot();
    checkToken(snap.token, token);
    needV5(isV5(snap.raw), 'UNSUPPORTED_VERSION', '请先备份、预览并显式升级到 Data v5');
    return snap as Snapshot & { data: DataV5; raw: V5Envelope };
  }
  function checkBackup(evidence: BackupEvidence, token: Token) {
    needV5(evidence?.fileSavedConfirmed === true, 'BACKUP_REQUIRED', '请先下载并确认保存备份');
    checkToken(token, evidence.token);
    const key = canonicalJson({ token: evidence.token, dataFingerprint: evidence.dataFingerprint });
    needV5(backups.has(key), 'BACKUP_REQUIRED', '此会话未生成匹配的完整备份');
  }
  function checkEvidence(evidenceId: string, token: Token) {
    const evidence = evidenceIds.get(evidenceId);
    needV5(evidence, 'BACKUP_REQUIRED', '备份证明已失效');
    checkBackup(evidence, token);
  }
  const host = {
    readonlyScope: 'b4-formal-core' as const,
    // Archive budgets remain unvalidated until B11; do not advertise the whole P0 CapacityPolicy as validated.
    jsonCapacity: Object.freeze({
      activeBytes: MAX_BACKUP_BYTES,
      inputBytes: MAX_INPUT_BYTES,
      scope: 'active-json' as const,
    }),
    load: () => wrap(snapshot),
    loadV5: (input: { epoch?: string } = {}) =>
      wrap(async () => {
        const s = await snapshot();
        needV5(
          input.epoch === undefined || input.epoch === s.token.epoch,
          'WORKSPACE_REPLACED',
          '工作区已被替换，请重新读取',
        );
        needV5(isV5(s.raw), 'UNSUPPORTED_VERSION', '请先备份、预览并显式升级通用卡牌格式');
        return { token: s.token, data: s.raw.data };
      }),
    subscribe: (listener: (external: boolean, changes?: readonly WorkspaceSlotChange[]) => void) =>
      store.subscribe(listener),
    close() {
      planner.close();
      invalidate();
      backups.clear();
      evidenceIds.clear();
      void collection.finally(async () => {
        await textFilePort.close();
        maintenance.close();
        store.close();
      });
    },
    invalidateCapabilities: invalidate,
    prepareBackup: () =>
      wrap(async () => {
        const s = await snapshot();
        const pack = isV5(s.raw) ? backupV5(s.raw.data) : exportWorkspace(s.raw),
          text = JSON.stringify(pack),
          dataFingerprint = await fingerprint(pack.data);
        backups.set(canonicalJson({ token: s.token, dataFingerprint }), {
          token: s.token,
          dataFingerprint,
        });
        return {
          token: s.token,
          dataFingerprint,
          text,
          diagnosticOnly: new TextEncoder().encode(text).length > MAX_INPUT_BYTES,
        };
      }),
    confirmBackupEvidence: (evidence: BackupEvidence) =>
      wrap(async () => {
        evidence = structuredClone(evidence);
        const s = await snapshot();
        checkBackup(evidence, s.token);
        const evidenceId = id();
        evidenceIds.set(evidenceId, evidence);
        return { evidenceId, token: s.token };
      }),
    previewMigrationV5: (input: { token: Token }) =>
      wrap(async () => {
        const s = await snapshot();
        checkToken(s.token, input.token);
        needV5(
          (s.mode === 'current' || s.mode === 'uninitialized') && (s.data as any)?.version === 4,
          'UNSUPPORTED_VERSION',
          '本步只显式迁移 Data v4；更旧版本先走原迁移链',
        );
        const previewId = id(),
          at = now(),
          workspaceId = id();
        assertInstant(at);
        const target = prepareV5Migration(s.data as DataV4, {
          workspaceId,
          commandId: previewId,
          at,
        });
        assertActiveCapacity(target);
        lifecycle.set(previewId, {
          token: s.token,
          kind: 'CommitMigration',
          target: { mode: 'current', dataFormat: 'action-v5', data: target },
          migration: { workspaceId, at },
        });
        return {
          previewId,
          token: s.token,
          sourceFingerprint: await fingerprint(s.data),
          upgrade: { from: 4, to: 5 },
          catalog: catalogOf(target),
          mappedMaterials: target.handCards.length,
          legacyJournalEntries: target.journalEntries.length,
          bytes: activeBytes(target),
        };
      }),
    previewRestore: (input: { token: Token; text: string }) =>
      wrap(async () => {
        const s = await snapshot();
        checkToken(s.token, input.token);
        const target = parseV06Restore(input.text);
        if (target.mode === 'current') {
          if (target.dataFormat === 'action-v5') await validateV5Fingerprints(target.data);
          else {
            const { validateSourceFingerprints } = await import('./format.ts');
            await validateSourceFingerprints(target.data);
          }
        }
        const previewId = id();
        lifecycle.set(previewId, { token: s.token, kind: 'RestoreWorkspace', target });
        return {
          previewId,
          token: s.token,
          mode: target.mode,
          dataFormat: target.dataFormat,
          data: structuredClone(target.data),
          coverage:
            target.mode === 'current' && target.dataFormat === 'action-v5'
              ? await archives.coverage(target.data)
              : null,
        };
      }),
    previewPlacement: planner.previewPlacement,
    previewActual: planner.previewActual,
    previewDayTemplate: planner.previewDayTemplate,
    previewInstanceUpdate: planner.previewInstanceUpdate,
    unlockFixed: planner.unlockFixed,
    readDay: (input: { date: string; zone: string }) =>
      wrap(async () => {
        const s = await snapshot();
        needV5(isV5(s.raw), 'UNSUPPORTED_VERSION', '请先显式升级到 Data v5');
        return todayView(s.raw.data, s.token, input, now());
      }),
    readJournalProjection: (input: { date: string; zone: string; token: Token }) =>
      wrap(async () => {
        const s = await live(input.token);
        if (s.data.archiveIndex.some((i) => i.coveredDates.includes(input.date)))
          return archives.fullProjection(s.token, input.date, input.zone);
        const day = todayView(s.data, s.token, input, now());
        return projectJournalTimeline({
          day,
          templates: s.data.planner.templates,
          notes: s.data.journalNotes,
          legacyEntries: s.data.journalEntries,
          materials: s.data.handCards,
          references: s.data.referencePlacements,
          factReferences: s.data.factReferenceSnapshots,
        });
      }),
    readArchivedJournalProjection: (input: { archiveId: string; date: string; zone: string }) =>
      wrap(async () => archives.readonlyProjection(input.archiveId, input.date, input.zone)),
    readJournalTimeline: (input: {
      date: string;
      zone: string;
      source: { kind: 'live'; token: Token } | { kind: 'archive'; archiveId: string };
    }) =>
      wrap(async () => {
        if (input.source.kind === 'archive')
          return archives.journal(input.source.archiveId, input.date, input.zone);
        const s = await live(input.source.token);
        needV5(
          !s.data.archiveIndex.some((i) => i.coveredDates.includes(input.date)),
          'ARCHIVE_READ_ONLY',
          '已归档日期请使用 archiveId 只读查看，活动视图不代表完整历史',
        );
        const day = todayView(s.data, s.token, input, now());
        const p = projectJournalTimeline({
          day,
          templates: s.data.planner.templates,
          notes: s.data.journalNotes,
          legacyEntries: s.data.journalEntries,
          materials: s.data.handCards,
          references: s.data.referencePlacements,
          factReferences: s.data.factReferenceSnapshots,
        });
        return {
          access: 'live' as const,
          editable: true as const,
          token: s.token,
          data: p.timeline,
        };
      }),
    readJournalDates: (input: { year: number; month: number }) =>
      wrap(async () => {
        needV5(
          Number.isInteger(input.year) &&
            input.year > 0 &&
            Number.isInteger(input.month) &&
            input.month >= 1 &&
            input.month <= 12,
          'INVALID_INPUT',
          '年月无效',
        );
        const s = await snapshot();
        needV5(isV5(s.raw), 'UNSUPPORTED_VERSION', '请先显式升级');
        const prefix =
          String(input.year).padStart(4, '0') + '-' + String(input.month).padStart(2, '0') + '-';
        const dates = new Set<string>(
          [...s.raw.data.journalNotes, ...s.raw.data.journalEntries]
            .map((n) => n.date)
            .filter((d) => d.startsWith(prefix)),
        );
        for (let d = 1; d <= 31; d++) {
          const date = prefix + String(d).padStart(2, '0');
          try {
            assertDate(date);
          } catch {
            continue;
          }
          const zone = s.raw.data.settings.zone ?? 'UTC';
          assertZone(zone);
          const p = projectJournalTimeline({
            day: todayView(s.raw.data, s.token, { date, zone }, now()),
            templates: s.raw.data.planner.templates,
            notes: s.raw.data.journalNotes,
            legacyEntries: s.raw.data.journalEntries,
            materials: s.raw.data.handCards,
            references: s.raw.data.referencePlacements,
            factReferences: s.raw.data.factReferenceSnapshots,
          });
          if (p.rows.length) dates.add(date);
        }
        return {
          liveDates: [...dates].sort(),
          archiveDates: [
            ...new Set(
              s.raw.data.archiveIndex
                .flatMap((i) => i.coveredDates)
                .filter((d) => d.startsWith(prefix)),
            ),
          ].sort(),
        };
      }),
    recordMaintenance: maintenance.record,
    readMaintenanceDay: async (input: Parameters<typeof maintenance.read>[0]) => {
      await collection;
      return maintenance.read(input);
    },
    retryMaintenance: async () => {
      await collection;
      return maintenance.retry();
    },
    navigatePage: (input: { token: Token; page: string; previousPage?: string }) =>
      wrap(async () => {
        const s = await live(input.token);
        const zone = s.data.settings.zone ?? 'UTC';
        await maintenance.record(
          createOperationEvent({
            eventId: id(),
            epoch: s.token.epoch,
            at: now(),
            zone,
            category: 'navigation',
            operation: input.previousPage === undefined ? 'AppStarted' : 'NavigatePage',
            stage: 'requested',
            commandId: null,
            entityRefs: [],
            errorCode: null,
            details: {
              page: input.page,
              ...(input.previousPage === undefined ? {} : { previousPage: input.previousPage }),
            },
          }),
        );
        return { recorded: true };
      }),
    openListUrl: (
      input: { token: Token; entry: { id: string; version: number } },
      open: (url: string) => unknown = (url) => {
        const opened = window.open('about:blank', '_blank');
        if (opened) {
          opened.opener = null;
          opened.location.replace(url);
        }
        return opened;
      },
    ) =>
      wrap(async () => {
        const s = await live(input.token),
          entry = s.data.catalogEntries.find((e) => e.id === input.entry.id);
        needV5(
          entry &&
            entry.version === input.entry.version &&
            entry.status === 'active' &&
            entry.url !== null,
          'ENTRY_STALE',
          '清单条目已改变或没有网址',
        );
        const zone = s.data.settings.zone ?? 'UTC',
          at = now();
        const requested = createListUrlEvent({
          eventId: id(),
          epoch: s.token.epoch,
          at,
          zone,
          entry,
          outcome: 'requested',
        });
        let outcome: 'requested' | 'blocked' | 'failed' = 'requested';
        try {
          if (open(entry.url) === null) outcome = 'blocked';
        } catch {
          outcome = 'failed';
        }
        await maintenance.record(requested);
        if (outcome !== 'requested')
          await maintenance.record(
            createListUrlEvent({ eventId: id(), epoch: s.token.epoch, at, zone, entry, outcome }),
          );
        return { outcome };
      }),
    readCatalog: (input: { token: Token }) =>
      wrap(async () => {
        const s = await live(input.token);
        return {
          access: 'live' as const,
          token: s.token,
          data: structuredClone(catalogOf(s.data)),
        };
      }),
    readMaterials: (input: { token: Token }) =>
      wrap(async () => {
        const s = await live(input.token);
        return { access: 'live' as const, token: s.token, data: structuredClone(s.data.handCards) };
      }),
    readUnifiedHand: (input: { token: Token }) =>
      wrap(async () => {
        const s = await live(input.token);
        return { access: 'live' as const, token: s.token, data: projectUnifiedHand(s.data, now()) };
      }),
    readDecisionCandidates: (input: {
      token: Token;
      decision: { id: string; version: number };
      deckIds: readonly string[];
    }) =>
      wrap(async () => {
        const s = await live(input.token),
          selected = collectDecisionCandidates({
            catalog: s.data,
            decision: input.decision,
            deckIds: input.deckIds,
            grandfatheredDecks: grandfatheredDecks(s.data),
          });
        return {
          token: s.token,
          decision: structuredClone(input.decision),
          candidates: selected.candidates.map((c) => structuredClone(c.entry)),
        };
      }),
    previewDecision: (input: {
      token: Token;
      decision: { id: string; version: number };
      deckIds: readonly string[];
    }) =>
      wrap(async () => {
        input = structuredClone(input);
        const s = await live(input.token),
          decision = s.data.decisionCards.find((d) => d.id === input.decision.id);
        needV5(
          decision && decision.version === input.decision.version,
          'ENTRY_STALE',
          '决策卡已变化',
        );
        const selected = collectDecisionCandidates({
          catalog: s.data,
          decision: input.decision,
          deckIds: input.deckIds,
          grandfatheredDecks: grandfatheredDecks(s.data),
        });
        const previewId = id();
        const value: DecisionPreview = {
          previewId,
          token: s.token,
          decision: input.decision,
          ownerAction: { id: selected.ownerAction.id, version: selected.ownerAction.version },
          candidates: selected.candidates.map((c) => c.entry),
          sourceFingerprint: await fingerprint(selected),
        };
        decisions.set(previewId, {
          token: s.token,
          input: { decision: input.decision, deckIds: input.deckIds },
          value,
        });
        return structuredClone(value);
      }),
    selectDecisionEntry: (input: {
      token: Token;
      previewId: string;
      choice: { mode: 'random' } | { mode: 'manual'; entry: { id: string; version: number } };
    }) =>
      wrap(async () => {
        input = structuredClone(input);
        const s = await live(input.token),
          session = decisions.get(input.previewId);
        needV5(session && same(session.token, s.token), 'PREVIEW_STALE', '决策预览已失效');
        // Reading/retrying an existing selection never rerolls it. A fresh preview permits another selection.
        const existing = selections.get(input.previewId);
        if (existing) return structuredClone(existing);
        const selected = selectDecisionAnswer({
          catalog: s.data,
          decision: session.input.decision,
          deckIds: session.input.deckIds,
          grandfatheredDecks: grandfatheredDecks(s.data),
          choice:
            input.choice.mode === 'random' ? { mode: 'random', nextUint32: random } : input.choice,
          at: now(),
        });
        const selection: SelectedAnswer = {
          selectionId: id(),
          previewId: input.previewId,
          token: s.token,
          answer: selected,
        };
        selections.set(input.previewId, selection);
        grants.set(selection.selectionId, {
          token: s.token,
          value: {
            kind: 'answer',
            selection,
            action: sourceAction(s.data, selection.answer.ownerAction),
            answerId: id(),
            actionId: id(),
          },
        });
        return structuredClone(selection);
      }),
    previewSynthesis: (input: {
      token: Token;
      inputs: readonly [{ id: string; version: number }, { id: string; version: number }];
      resolutions: readonly FieldResolution[];
    }) =>
      wrap(async () => {
        input = structuredClone(input);
        const s = await live(input.token);
        const action = s.data.handCards.find(
          (c) =>
            input.inputs.some((r) => r.id === c.id) &&
            (c.kind === 'action' || c.kind === 'composite'),
        );
        needV5(
          action && (action.kind === 'action' || action.kind === 'composite'),
          'INVALID_INPUT',
          '缺少行动素材',
        );
        const source = sourceAction(s.data, action.ownerAction),
          outputId = id(),
          previewId = id();
        const prepared = previewSynthesis({
          context: materialContext(s.data),
          inputs: input.inputs,
          resolutions: input.resolutions,
          at: now(),
          outputId,
          actionSource: source,
        });
        grants.set(previewId, {
          token: s.token,
          value: {
            kind: 'synthesis',
            inputs: input.inputs,
            resolutions: input.resolutions,
            outputId,
            action: source,
          },
        });
        const value: SynthesisPreview = {
          previewId,
          token: s.token,
          inputs: input.inputs,
          sourceFingerprint: await fingerprint({ inputs: input.inputs, output: prepared.output }),
          output: prepared.output,
          conflicts: prepared.conflicts,
          missingFieldIds: prepared.missingFieldIds,
          ready: prepared.canConfirm,
        };
        return value;
      }),
    previewReference: (input: { token: Token; draft: ReferenceDraft }) =>
      wrap(async () => {
        input = structuredClone(input);
        const s = await live(input.token),
          previewId = id(),
          referenceId = id();
        const p = previewReferencePlacement({
          context: materialContext(s.data),
          draft: input.draft,
          referenceId,
          at: now(),
        });
        grants.set(previewId, {
          token: s.token,
          value: { kind: 'reference', draft: input.draft, referenceId },
        });
        return {
          previewId,
          token: s.token,
          draft: input.draft,
          point: p.point,
          occupiedMinutes: 0,
        } as ReferencePreview;
      }),
    exportConfiguration: () =>
      wrap(async () => {
        const s = await snapshot();
        needV5(isV5(s.raw), 'UNSUPPORTED_VERSION', '请先显式升级');
        const pack = exportConfigV4(s.raw.data);
        parseConfigV4(JSON.stringify(pack));
        return pack;
      }),
    previewCatalogImport: (input: { token: Token; text: string }) =>
      wrap(async () => {
        const s = await live(input.token),
          { pack, legacyMapping } = readConfiguration(input.text),
          previewId = id(),
          catalog = catalogOf(pack.config);
        const changes = (
          ['actionCards', 'catalogEntries', 'decks', 'decisionCards'] as const
        ).flatMap((key, index) =>
          catalog[key].flatMap((item) => {
            const old = s.data[key].find((i) => i.id === item.id);
            const normalized = {
              ...item,
              version: old?.version ?? 1,
              source: old?.source ?? { kind: 'manual' },
            };
            return old && same(old, normalized)
              ? []
              : [
                  {
                    kind: old ? ('update' as const) : ('create' as const),
                    entityId: item.id,
                    entityKind: (['action', 'entry', 'deck', 'decision'] as const)[index],
                  },
                ];
          }),
        );
        const plannerChanges = (
          ['definitions', 'templates', 'rules', 'generationRules'] as const
        ).map((key) => ({ collection: key, incoming: pack.config[key].length }));
        // Test both modes with the exact reducer and receipt boundary; invalid merged references never issue a capability.
        for (const mode of ['merge', 'replace'] as const) {
          const candidate = applyV5Command(
            s.data,
            {
              contractVersion: 'v06-p0-1',
              commandId: previewId,
              expected: s.token,
              type: 'ImportCatalogV4',
              payload: { previewId, mode, backupEvidenceId: 'preview-only' },
            },
            { at: now(), id, grant: { kind: 'catalog', catalog, config: pack.config } },
          ).data;
          validateDataV5(candidate);
          assertActiveCapacity(candidate);
        }
        grants.set(previewId, {
          token: s.token,
          value: { kind: 'catalog', catalog, config: pack.config },
        });
        return {
          previewId,
          token: s.token,
          format: 'config-v4' as const,
          sourceFingerprint: await fingerprint(pack),
          catalog,
          changes,
          plannerChanges,
          legacyMapping,
          bytes: new TextEncoder().encode(input.text).length,
          issues: [],
        };
      }),
    cancelPreview: (input: { token: Token; previewId: string }) =>
      wrap(async () => {
        planner.cancelPreview(input.previewId);
        const capability = grants.get(input.previewId) ?? decisions.get(input.previewId);
        needV5(
          !capability || same(capability.token, input.token),
          'PREVIEW_STALE',
          '不能取消另一个 token 的预览',
        );
        // Revocation releases private drafts even when a later token check rejects
        // a stale caller. It has no persistent side effects or accepted-card undo.
        grants.delete(input.previewId);
        decisions.delete(input.previewId);
        const selected = selections.get(input.previewId);
        if (selected) grants.delete(selected.selectionId);
        selections.delete(input.previewId);
        await live(input.token);
        return { cancelled: true as const };
      }),
    async submit(
      input: V06Command | Command | TakeDailyMaterialCommand,
    ): Promise<V06Result<TodaySubmitValue>> {
      let committedEvent: MaintenanceEvent | null = null,
        operationZone = 'UTC';
      const capture = (raw: any, token: Token, at: string, lifecycle = false) => {
        try {
          operationZone = raw?.data?.settings?.zone ?? 'UTC';
          if (lifecycle) {
            committedEvent = createLifecycleEvent({
              receipt: raw.lifecycleReceipt,
              epoch: token.epoch,
              at,
              zone: operationZone,
            });
            return;
          }
          const receipt = raw.data.commandReceipts.find(
              (r: any) => r.commandId === input.commandId,
            ),
            histories = raw.data.planner.history.filter(
              (h: any) => h.commandId === input.commandId,
            );
          if (receipt && histories.length)
            committedEvent = createCommittedEvent({
              epoch: token.epoch,
              zone: operationZone,
              receipt,
              histories,
            });
        } catch {
          /* metadata errors never abort business */
        }
      };
      const response = await wrap(async () => {
        const command = structuredClone(input);
        const isLifecycle = ['RestoreWorkspace', 'CommitMigration', 'ClearWorkspace'].includes(
          command.type,
        );
        const isToday = todayTypes.has(command.type),
          isDaily = [
            'GenerateDailyCopies',
            'ArchiveDueCopies',
            'AcceptDailyCopy',
            'TakeDailyMaterial',
          ].includes(command.type);
        if (command.type === 'TakeDailyMaterial') {
          exactRecord(command, ['contractVersion', 'commandId', 'expected', 'type', 'payload']);
          needV5(command.contractVersion === 'v06-b7-1', 'INVALID_INPUT', '每日命令版本无效');
          exactRecord(command.payload, ['copy']);
          exactRecord(command.payload.copy, ['id', 'version']);
          assertCommand({
            commandId: command.commandId,
            expected: command.expected,
            type: 'AcceptDailyCopy',
            payload: {
              copy: command.payload.copy,
              selections: [],
              composedText: 'validation-only',
            },
          });
        }
        if (isLifecycle || isToday || (isDaily && command.type !== 'TakeDailyMaterial'))
          assertCommand(command as Command);
        else if (command.type !== 'TakeDailyMaterial') validateV06CommandInput(command);
        const digest = await fingerprint({ type: command.type, payload: command.payload }),
          before = await snapshot(),
          at = now();
        assertInstant(at);
        operationZone = (before.data as DataV5 | null)?.settings?.zone ?? 'UTC';
        const epoch = isLifecycle ? id() : before.token.epoch;
        if (command.type === 'CommitMonthlyArchive') {
          const r = await archives.commit(
            command as Extract<V06Command, { type: 'CommitMonthlyArchive' }>,
            digest,
            at,
          );
          capture(await store.read(), r.token, at);
          return r;
        }
        return store.atomic<TodaySubmitValue>((raw) => {
          const envelope = raw as V5Envelope | EnvelopeV4 | undefined,
            current =
              envelope?.schemaVersion === 4
                ? { epoch: envelope.epoch, revision: envelope.revision }
                : before.token;
          if (isLifecycle) {
            const cmd = command as LifecycleCommand,
              receipt = envelope?.schemaVersion === 4 ? envelope.lifecycleReceipt : null;
            if (receipt?.commandId === cmd.commandId) {
              needV5(
                receipt.type === cmd.type &&
                  receipt.payloadFingerprint === digest &&
                  same(receipt.previousToken, cmd.expected),
                'COMMAND_ID_REUSED',
                '请求标识用于另一操作',
              );
              return { result: { token: current, resultRefs: [], replayed: true } };
            }
            checkToken(current, cmd.expected);
            needV5(
              (raw === undefined ? 'uninitialized' : canonicalJson(raw)) === before.rawKey,
              'REVISION_CONFLICT',
              '工作区已变化',
            );
            needV5(
              cmd.payload.discardDraftsConfirmed === true,
              'INVALID_INPUT',
              '需要明确确认丢弃草稿',
            );
            checkBackup(cmd.payload.backup, current);
            const preview =
              cmd.type === 'ClearWorkspace' ? null : lifecycle.get(cmd.payload.previewId);
            if (cmd.type !== 'ClearWorkspace')
              needV5(
                preview && preview.kind === cmd.type && same(preview.token, current),
                'PREVIEW_STALE',
                '替换预览失效',
              );
            let target = preview?.target ?? {
              mode: 'current' as const,
              dataFormat: 'action-v4' as const,
              data: emptyWorkspaceData(),
            };
            if (cmd.type === 'CommitMigration') {
              needV5(
                preview?.migration && (before.data as any)?.version === 4,
                'PREVIEW_STALE',
                '迁移来源已变化',
              );
              target = {
                mode: 'current',
                dataFormat: 'action-v5',
                data: prepareV5Migration(before.data as DataV4, {
                  ...preview.migration,
                  commandId: cmd.commandId,
                }),
              };
            }
            if (target.mode === 'current') {
              if (target.dataFormat === 'action-v5') {
                validateDataV5(target.data);
                assertActiveCapacity(target.data);
              } else {
                const bytes = new TextEncoder().encode(
                  JSON.stringify(
                    exportWorkspace({
                      schemaVersion: 4,
                      epoch: 'check',
                      revision: 0,
                      lifecycleReceipt: null,
                      ...target,
                    }),
                  ),
                ).length;
                needV5(bytes <= MAX_BACKUP_BYTES, 'DATA_TOO_LARGE', '恢复结果超出活动 JSON 容量');
              }
            }
            const token = { epoch, revision: 1 },
              write = {
                schemaVersion: 4,
                ...token,
                ...structuredClone(target),
                lifecycleReceipt: {
                  commandId: cmd.commandId,
                  type: cmd.type,
                  payloadFingerprint: digest,
                  previousToken: current,
                  resultToken: token,
                },
              };
            capture(write, token, at, true);
            return {
              write,
              at,
              reason: cmd.type,
              result: { token, resultRefs: [], replayed: false },
            };
          }
          checkToken(current, command.expected, false);
          needV5(isV5(raw), 'UNSUPPORTED_VERSION', '请先显式升级到 Data v5');
          const old = raw.data.commandReceipts.find((r) => r.commandId === command.commandId);
          if (old) {
            capture(raw, current, at);
            needV5(
              old.type === command.type && old.payloadFingerprint === digest,
              'COMMAND_ID_REUSED',
              '请求标识用于另一内容',
            );
            return { result: { token: current, resultRefs: old.resultRefs, replayed: true } };
          }
          checkToken(current, command.expected);
          needV5(canonicalJson(raw) === before.rawKey, 'REVISION_CONFLICT', '权威数据已变化');
          let grant: BusinessGrant | undefined;
          const cmd = command as V06Command;
          if (
            [
              'AcceptDecisionAnswer',
              'ConfirmSynthesis',
              'CommitReferencePlacement',
              'ImportCatalogV4',
            ].includes(cmd.type)
          ) {
            const key =
              cmd.type === 'AcceptDecisionAnswer'
                ? cmd.payload.selectionId
                : (cmd.payload as { previewId: string }).previewId;
            const captured = grants.get(key);
            needV5(captured && same(captured.token, current), 'PREVIEW_STALE', '会话证明已失效');
            grant = captured.value;
            if (cmd.type === 'ImportCatalogV4')
              checkEvidence(cmd.payload.backupEvidenceId, current);
          }
          const change = isDaily
            ? applyDaily(raw.data, command as Parameters<typeof applyDaily>[1], at, id)
            : isToday
              ? applyToday(
                  raw.data,
                  command as Command,
                  planner.resolveOperation(command as Command, {
                    mode: 'current',
                    token: current,
                    data: plannerView(raw.data),
                    raw,
                    rawKey: canonicalJson(raw),
                  }),
                  at,
                )
              : applyV5Command(raw.data, cmd, { at, id, grant });
          const data: DataV5 = {
            ...change.data,
            commandReceipts: [
              ...change.data.commandReceipts,
              {
                commandId: cmd.commandId,
                type: cmd.type,
                payloadFingerprint: digest,
                resultRefs: change.resultRefs,
              },
            ],
          };
          validateDataV5(data);
          needV5(
            activeBytes(data) <= MAX_BACKUP_BYTES,
            'DATA_TOO_LARGE',
            '活动 JSON 超过容量门槛，本次未写入',
          );
          needV5(current.revision < Number.MAX_SAFE_INTEGER, 'INVALID_INPUT', '工作区版本无法递增');
          const token = { epoch: current.epoch, revision: current.revision + 1 };
          capture({ ...raw, ...token, data }, token, at);
          return {
            write: { ...raw, ...token, data },
            at,
            reason: cmd.type,
            result: { token, resultRefs: change.resultRefs, replayed: false },
          };
        });
      });
      // Queue only bounded operation metadata, never retain entire workspace snapshots.
      let event: MaintenanceEvent | null = committedEvent;
      if (!response.ok && input?.expected?.epoch) {
        try {
          event = createOperationEvent({
            eventId: id(),
            epoch: input.expected.epoch,
            at: now(),
            zone: operationZone,
            category: 'error',
            operation: input.type,
            stage: 'failed',
            commandId: input.commandId,
            entityRefs: [],
            errorCode: response.code,
            details: {},
          });
        } catch {
          event = null;
        }
      }
      if (!event && response.ok && !response.value.replayed) {
        try {
          event = createOperationEvent({
            eventId: id(),
            epoch: response.value.token.epoch,
            at: now(),
            zone: operationZone,
            category: 'business',
            operation: input.type,
            stage: 'requested',
            commandId: input.commandId,
            entityRefs: [],
            errorCode: null,
            details: { historyCount: 0, sourceRevision: response.value.token.revision },
          });
        } catch {
          event = null;
        }
      }
      if (event) {
        const frozen = event;
        collection = collection.then(async () => {
          await maintenance.record(frozen);
        });
      }
      return response;
    },
  };
  const archives = createV06Archives({
    store,
    source: host,
    now,
    id,
    runtime: options.archiveRuntime,
  });
  const textRepository: TextRepository = {
    read: (key) => {
      if (!store.readTextOutput) throw new Error('文件状态存储不可用');
      return store.readTextOutput(key);
    },
    keys: (prefix) => {
      if (!store.listTextOutputKeys) throw new Error('文件索引存储不可用');
      return store.listTextOutputKeys(prefix);
    },
    atomic: (keys, reduce) => {
      if (!store.atomicTextOutput) throw new Error('文件状态事务不可用');
      return store.atomicTextOutput(keys, reduce);
    },
  };
  const textFilePort = createTextOutputSession({
    repository: textRepository,
    source: createV06TextSource({ store, host, maintenance, now, id, archives }),
    runtime: options.textRuntime,
    now,
    id,
    debounceMs: options.textDebounceMs,
  });
  return {
    ...host,
    submit: host.submit as V06Submit,
    textFilePort,
    archivePort: archives.port,
    cancelMonthlyArchivePreview: archives.discardPreview,
    capacityPolicy: archives.capacityPolicy,
  };
}
export type V06Host = ReturnType<typeof createV06Host>;
