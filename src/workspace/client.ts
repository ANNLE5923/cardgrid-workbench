import type { BackupEvidence, Command, ConfigV2, WorkspaceData, EnvelopeV4, Json, MigrationPreview, Result, SubmitResult, Token } from './contracts.ts';
import type {ConfigV3} from './contracts-v3.ts';
import type {WorkshopCatalog} from '../workshop/model.ts';
import {validateWorkshopChange} from '../workshop/model.ts';
import {workshopCatalog} from './workshop-history.ts';
import {drawingQueries} from './drawing-queries.ts';
import {saveWorkshopCatalog} from './v3-operations.ts';
import {suggestDefinition} from '../drawing/model.ts';
import { ActionDomainError, sameValue, type ActionOperation } from '../daily/model.ts';
import { assertCommand, checkToken, commandFailure, createActionService } from './commands.ts';
import {backupBytes, canonicalJson, emptyWorkspaceData, upgradeActionData, exportWorkspace, fingerprint, inspectImportText, MAX_BACKUP_BYTES, parseRestore, validateActionData, validateDefinitionConfig, validateLegacyConfig, validateSourceFingerprints, type RestoreTarget} from './format.ts';
import { prepareMigration, type MigrationChoices, type MigrationSource } from './migration.ts';
import { createWorkspaceStore, type WorkspaceStore } from './store.ts';
import { compatibilityView, projectDay } from '../daily/projection.ts';
import { dateAt, resolveLocal } from '../daily/time.ts';
import type { Config } from './legacy/domain.ts';

function requireValue(value: unknown, code: 'PREVIEW_STALE' | 'BACKUP_REQUIRED' | 'BACKUP_STALE' | 'MIGRATION_BLOCKED' | 'DATA_TOO_LARGE' | 'COMMAND_ID_REUSED' | 'LEGACY_READ_ONLY' | 'INVALID_INPUT', message: string): asserts value {
  if (!value) throw new ActionDomainError(code, message);
}
type LifecyclePreview = { token: Token; type: 'RestoreWorkspace' | 'CommitMigration'; target: RestoreTarget; blocked: boolean };
type DefinitionPreview = {token: Token; config: ConfigV2 | ConfigV3; mode: 'merge' | 'replace'; operation: Extract<ActionOperation, {type: 'ImportDefinitions'}>; workshop: WorkshopCatalog | null};
export type BackupPreparation = Readonly<{ token: Token; dataFingerprint: string; text: string; diagnosticOnly: boolean }>;

/** The only production UI boundary. No public method accepts a replacement Data object. */
export function createWorkspaceClient(options: {store?: WorkspaceStore; now?: () => string; id?: () => string; random?: () => number} = {}) {
  const store = options.store ?? createWorkspaceStore(), now = options.now ?? (() => new Date().toISOString()), id = options.id ?? (() => crypto.randomUUID());
  const lifecycle = new Map<string, LifecyclePreview>(), definitions = new Map<string, DefinitionPreview>(), backups = new Map<string, Token>();
  const backupKey = (value: Pick<BackupEvidence, 'token' | 'dataFingerprint'>) => canonicalJson(value);
  const checkBackup = (evidence: BackupEvidence, token: Token) => {
    requireValue(evidence?.fileSavedConfirmed === true, 'BACKUP_REQUIRED', '请先下载并确认已保存当前完整备份');
    requireValue(sameValue(evidence.token, token), 'BACKUP_STALE', '备份后数据已改变，请重新备份');
    requireValue(backups.has(backupKey({ token: evidence.token, dataFingerprint: evidence.dataFingerprint })), 'BACKUP_REQUIRED', '此会话未生成匹配的备份文件');
  };
  const service = createActionService(store, { now, id, definitionImport: (command, snapshot) => {
    const preview = definitions.get(command.payload.previewId);
    requireValue(preview && sameValue(preview.token, snapshot.token) && preview.mode === command.payload.mode, 'PREVIEW_STALE', '定义预览已失效');
    checkBackup(command.payload.backup, snapshot.token); return structuredClone(preview.operation);
  }, workshopImport: command => {
    const preview = definitions.get(command.payload.previewId);
    requireValue(preview, 'PREVIEW_STALE', '工坊配置预览已失效'); return preview.workshop;
  }});
  const invalidate = () => { service.invalidateCapabilities(); lifecycle.clear(); definitions.clear(); };
  const result = async <T>(fn: () => Promise<T>): Promise<Result<T>> => { try { return { ok: true, value: await fn() }; } catch (error) { return commandFailure(error); } };
  function configOperation(data: WorkspaceData, pack: ConfigV2 | ConfigV3, mode: 'merge' | 'replace'): Extract<ActionOperation, {type: 'ImportDefinitions'}> {
    const merge = <T extends { id: string; version: number }>(old: readonly T[], incoming: readonly T[], retire: (value: T) => T): T[] => {
      const result = old.map(value => mode === 'replace' && !incoming.some(v => v.id === value.id) ? retire(value) : value);
      for (const value of incoming) {
        const index = result.findIndex(v => v.id === value.id), previous = result[index];
        const next = { ...structuredClone(value), version: previous ? previous.version + 1 : 1 };
        if (index < 0) result.push(next); else result[index] = next;
      } return result;
    };
    return { type: 'ImportDefinitions', settings: pack.config.settings,
      definitions: merge(data.planner.definitions, pack.config.definitions, d => ({ ...d, enabled: false, version: d.version + 1 })),
      templates: merge(data.planner.templates, pack.config.templates, t => ({ ...t, weekdays: [], version: t.version + 1 })),
      rules: merge(data.planner.rules, pack.config.rules, r => ({ ...r, status: 'archived', version: r.version + 1 })) };
  }
  function workshopConfigOperation(data: WorkspaceData, pack: ConfigV2 | ConfigV3, mode: 'merge' | 'replace'): WorkshopCatalog | null {
    if (pack.version === 2) return null;
    if (data.version !== 3) throw new ActionDomainError('UNSUPPORTED_VERSION', '请先升级再导入 v3 工坊配置');
    const before = workshopCatalog(data), candidate = structuredClone(before) as Record<keyof WorkshopCatalog, Array<WorkshopCatalog[keyof WorkshopCatalog][number]>>;
    for (const key of ['actionCards', 'bookEntries', 'pools', 'generationRules'] as const) {
      const incoming = pack.config[key];
      candidate[key] = data[key].map(old => {
        if (mode !== 'replace' || incoming.some(item => item.id === old.id)) return old;
        const next = key === 'pools' ? {...old, memberIds: []} : {...old, status: 'archived' as const};
        return sameValue(old, next) ? old : {...next, version: old.version + 1};
      });
      for (const item of incoming) {
        const index = candidate[key].findIndex(old => old.id === item.id), old = candidate[key][index];
        const value = {...structuredClone(item), version: old?.version ?? 1, source: old?.source ?? {kind: 'manual' as const}};
        const next = old && !sameValue(old, value) ? {...value, version: old.version + 1} : value;
        if (index < 0) candidate[key].push(next); else candidate[key][index] = next;
      }
    }
    const checked = validateWorkshopChange(before, candidate);
    requireValue(checked.ok, 'INVALID_INPUT', checked.ok ? '' : checked.issues.map(i => i.message).join('; '));
    return checked.value;
  }
  function oldConfig(config: Config): ConfigV2 {
    validateLegacyConfig(config);
    requireValue(config.cards.every(c => c.minutes % 5 === 0) && config.schedules.every(s => s.entries.every(e => e.minutes % 5 === 0 && Number(e.start.slice(3)) % 5 === 0)), 'MIGRATION_BLOCKED', '旧配置含非五分钟项目；请通过完整来源迁移保留只读，或明确修改配置后重新导入');
    return { format: 'cardgrid', version: 2, kind: 'config', config: { settings: { zone: null, preferences: config.preferences, categories: config.categories }, rules: [],
      definitions: config.cards.map(c => ({ id: c.id, version: 1, enabled: c.enabled, parentDefinitionId: c.parentId, source: { kind: 'manual' }, content: { title: c.title, criteria: c.steps, presetMinutes: c.minutes, minimum: false,
        color: config.categories.find(x => x.id === c.categoryId)?.color ?? '#3c745f', categoryId: c.categoryId, categoryLabel: config.categories.find(x => x.id === c.categoryId)?.name ?? null, projectIds: [], goalIds: [], projectLabels: [], goalLabels: [] } })),
      templates: config.schedules.map(s => ({ id: s.id, version: 1, name: s.name, weekdays: [], source: { kind: 'manual' }, entries: s.entries.map((e, i) => ({ id: `${s.id}:${i}`, title: config.cards.find(c => c.id === e.cardId)!.title, start: e.start, elapsedMinutes: e.minutes, definitionId: e.cardId })) })) } };
  }
  const client = {
    ...drawingQueries(service.readSnapshot, now, options.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0])),
    load: () => result(() => service.readSnapshot()),
    readCompatibilityView(snapshot: Parameters<typeof compatibilityView>[0]) { return compatibilityView(snapshot); },
    subscribe(listener: (external: boolean) => void) { return store.subscribe(listener); },
    invalidateCapabilities: invalidate,
    close() { invalidate(); backups.clear(); service.close(); store.close(); },
    previewPlacement: service.previewPlacement, previewActual: service.previewActual, previewDayTemplate: service.previewDayTemplate, previewInstanceUpdate: service.previewInstanceUpdate,
    unlockFixed: service.unlockFixed, cancelPreview: service.cancelPreview,
    resolveLocal(input: Parameters<typeof resolveLocal>[0]) { try { return { ok: true as const, value: resolveLocal(input) }; } catch (error) { return commandFailure(error); } },
    readDay(input: { date: string; zone: string }) { return result(async () => projectDay(await service.readSnapshot(), input, now())); },
    readCatalog() { return result(async () => { const snapshot = await service.readSnapshot(); return { token: snapshot.token, definitions: snapshot.data?.planner.definitions ?? [], hand: snapshot.data?.planner.handOrder.map(id => snapshot.data!.planner.instances.find(i => i.id === id)!) ?? [] }; }); },
    suggest(input: { token: Token; categoryId?: string | null; minimum?: boolean }) { return result(async () => {
      const snapshot = await service.readSnapshot(); checkToken(snapshot.token, input.token);
      requireValue(snapshot.data, 'LEGACY_READ_ONLY', '旧工作区需先升级');
      return {token:snapshot.token,definition:suggestDefinition(snapshot.data.planner.definitions,input)};
    }); },
    prepareBackup() { return result(async (): Promise<BackupPreparation> => {
      const snapshot = await service.readSnapshot(), pack = exportWorkspace(snapshot.raw), dataFingerprint = await fingerprint(pack.data), text = JSON.stringify(pack);
      backups.set(backupKey({ token: snapshot.token, dataFingerprint }), snapshot.token);
      return { token: snapshot.token, dataFingerprint, text, diagnosticOnly: new TextEncoder().encode(text).length > MAX_BACKUP_BYTES };
    }); },
    exportDefinitions() { return result(async () => {
      const snapshot = await service.readSnapshot(); requireValue(snapshot.data, 'LEGACY_READ_ONLY', '旧数据请导出完整原文');
      const p = snapshot.data.planner;
      // Config packages are portable definitions, not copies of workspace-local provenance.
      const manual = <T extends { source: unknown }>(items: readonly T[]) => items.map(item => ({ ...item, source: { kind: 'manual' as const } }));
      const common = {settings: snapshot.data.settings, definitions: manual(p.definitions), templates: manual(p.templates), rules: manual(p.rules)};
      const pack: ConfigV2 | ConfigV3 = snapshot.data.version === 3
        ? {format: 'cardgrid', version: 3, kind: 'config', config: {...common, actionCards: manual(snapshot.data.actionCards), bookEntries: manual(snapshot.data.bookEntries), pools: manual(snapshot.data.pools), generationRules: manual(snapshot.data.generationRules)}}
        : {format: 'cardgrid', version: 2, kind: 'config', config: common};
      validateDefinitionConfig(pack); return pack;
    }); },
    readRecovery: () => result(() => store.readRecovery()),
    exportRecovery(key: IDBValidKey) { return result(async () => {
      const point = (await store.readRecovery()).find(p => sameValue(p.key, key));
      requireValue(point && point.value && typeof point.value === 'object' && 'raw' in point.value, 'INVALID_INPUT', '该恢复点不含可恢复工作区，请保留诊断原文');
      return exportWorkspace((point.value as { raw: unknown }).raw);
    }); },
    exportRaw: () => result(() => store.read()),
    previewRestore(input: { token: Token; text: string }) { return result(async () => {
      const snapshot = await service.readSnapshot(); checkToken(snapshot.token, input.token);
      const target = parseRestore(input.text); if (target.mode === 'current') await validateSourceFingerprints(target.data);
      const previewId = id(); lifecycle.set(previewId, { token: snapshot.token, type: 'RestoreWorkspace', target, blocked: false });
      return { previewId, token: snapshot.token, mode: target.mode, dataFormat: target.dataFormat, data: structuredClone(target.data) };
    }); },
    previewMigration(input: { token: Token; choices: MigrationChoices; source?: MigrationSource }) { return result(async (): Promise<MigrationPreview> => {
      input = structuredClone(input); const snapshot = await service.readSnapshot(); checkToken(snapshot.token, input.token);
      if (!input.source && snapshot.data?.version === 2) {
        const target = upgradeActionData(snapshot.data), previewId = id();
        lifecycle.set(previewId, {token: snapshot.token, type: 'CommitMigration', target: {mode: 'current', dataFormat: 'action-v3', data: target}, blocked: false});
        return {previewId, token: snapshot.token, sourceFingerprint: await fingerprint(snapshot.data), mappingVersion: 1, bindings: snapshot.data.migrationBindings, issues: [], upgrade: {from: 2, to: 3},
          targetSummary: {definitions: target.planner.definitions.length, instances: target.planner.instances.length, plans: target.planner.plans.length, facts: target.planner.facts.length, readonlyItems: target.migrationBindings.filter(b => b.disposition === 'readonly').length}};
      }
      let source = input.source;
      if (!source) {
        requireValue(snapshot.mode === 'legacy-readonly', 'INVALID_INPUT', '当前没有需要升级的旧工作区');
        const pack = exportWorkspace(snapshot.raw);
        source = { format: pack.version === 2 ? 'envelope-v1' : Object.hasOwn(pack.data as object, 'planner') ? 'cardgrid-v1-p1a' : 'cardgrid-v1-pre-planner', raw: pack.data as Json };
      }
      const prepared = await prepareMigration(snapshot.data ?? emptyWorkspaceData(), source, input.choices, now(), id()), previewId = id();
      const upgraded = prepared.data.version === 2 ? upgradeActionData(prepared.data) : prepared.data;
      lifecycle.set(previewId, {token: snapshot.token, type: 'CommitMigration', target: {mode: 'current', dataFormat: 'action-v3', data: upgraded}, blocked: prepared.report.issues.some(i => i.blocking)});
      return structuredClone({ ...prepared.report, previewId, token: snapshot.token });
    }); },
    previewDefinitions(input: { token: Token; text: string; mode: 'merge' | 'replace' }) { return result(async () => {
      const snapshot = await service.readSnapshot(); checkToken(snapshot.token, input.token); requireValue(snapshot.data, 'LEGACY_READ_ONLY', '旧工作区只读');
      const inspected = inspectImportText(input.text);
      requireValue(inspected.kind === 'config-v1' || inspected.kind === 'config-v2' || inspected.kind === 'config-v3', 'INVALID_INPUT', '请选择定义配置包');
      let pack = inspected.kind === 'config-v1' ? oldConfig((inspected.raw as {config: Config}).config) : inspected.raw as ConfigV2 | ConfigV3;
      if (inspected.kind === 'config-v1' && pack.version === 2) pack = {...pack, config: {...pack.config, settings: {...pack.config.settings, zone: snapshot.data.settings.zone}}};
      validateDefinitionConfig(pack); const operation = configOperation(snapshot.data, pack, input.mode);
      const workshop = workshopConfigOperation(snapshot.data, pack, input.mode);
      let target: WorkspaceData = {...snapshot.data, settings: operation.settings, planner: {...snapshot.data.planner, definitions: operation.definitions, templates: operation.templates, rules: operation.rules}};
      if (workshop && target.version === 3) {
        const at = now();
        target = saveWorkshopCatalog(target, workshop, {commandId: 'import-preview', historyId: 'import-preview',
          at, date: dateAt(at, target.settings.zone ?? 'UTC')}, 'ImportDefinitions').data;
      }
      validateActionData(target); requireValue(backupBytes(target) <= MAX_BACKUP_BYTES, 'DATA_TOO_LARGE', '导入后完整备份超过 5 MiB');
      const previewId = id(); definitions.set(previewId, {token: snapshot.token, config: structuredClone(pack), mode: input.mode, operation: structuredClone(operation), workshop});
      const changes = (['definitions', 'templates', 'rules'] as const).flatMap(kind => operation[kind].flatMap(value => {
        const previous = snapshot.data!.planner[kind].find(old => old.id === value.id);
        return sameValue(previous, value) ? [] : [{ kind, id: value.id, before: previous ?? null, after: value }];
      }));
      return {previewId, token: snapshot.token, mode: input.mode, config: structuredClone(pack.config), changes, workshopChanges: workshop && snapshot.data.version === 3
        ? (['actionCards', 'bookEntries', 'pools', 'generationRules'] as const).flatMap(kind => workshop[kind].flatMap(after => {
          const before = (snapshot.data as import('./contracts-v3.ts').DataV3)[kind].find(item => item.id === after.id);
          return sameValue(before, after) ? [] : [{kind, id: after.id, before: before ?? null, after}];
        })) : [], settingsBefore: snapshot.data.settings, before: {definitions: snapshot.data.planner.definitions.length, templates: snapshot.data.planner.templates.length, rules: snapshot.data.planner.rules.length},
        after: {definitions: operation.definitions.length, templates: operation.templates.length, rules: operation.rules.length}, retiredDefinitions: operation.definitions.filter(d => !d.enabled).map(d => d.id)};
    }); },
    async submit(input: Command): Promise<SubmitResult> {
      if (!['RestoreWorkspace', 'ClearWorkspace', 'CommitMigration'].includes(input?.type)) return service.submit(input);
      try {
        const command = structuredClone(input) as Extract<Command, { type: 'RestoreWorkspace' | 'ClearWorkspace' | 'CommitMigration' }>;
        assertCommand(command);
        requireValue(command.commandId?.trim() && command.payload?.discardDraftsConfirmed === true, 'INVALID_INPUT', '请明确确认丢弃未提交草稿');
        const payloadFingerprint = await fingerprint({ type: command.type, payload: command.payload }), before = await service.readSnapshot();
        const epoch = id(), at = now();
        const response = await store.atomic(raw => {
          const envelope = raw as EnvelopeV4 | undefined;
          const receipt = envelope?.schemaVersion === 4 ? envelope.lifecycleReceipt : null;
          const token = envelope?.schemaVersion === 4 ? { epoch: envelope.epoch, revision: envelope.revision } : before.token;
          if (receipt?.commandId === command.commandId) {
            requireValue(receipt.type === command.type && receipt.payloadFingerprint === payloadFingerprint && sameValue(receipt.previousToken, command.expected), 'COMMAND_ID_REUSED', '请求标识已用于另一操作');
            return { result: { ok: true, value: { token, resultRefs: [], replayed: true } } as SubmitResult };
          }
          checkToken(token, command.expected);
          checkToken(before.token, command.expected);
          requireValue((raw === undefined ? 'uninitialized' : canonicalJson(raw)) === before.rawKey, 'BACKUP_STALE', '工作区已改变，请重新备份和预览');
          checkBackup(command.payload.backup, token);
          const preview = command.type === 'ClearWorkspace' ? undefined : lifecycle.get(command.payload.previewId);
          if (command.type !== 'ClearWorkspace') requireValue(preview && preview.type === command.type && sameValue(preview.token, token), 'PREVIEW_STALE', '替换预览已失效');
          requireValue(!preview?.blocked, 'MIGRATION_BLOCKED', '迁移仍有未解决问题');
          let target: RestoreTarget = preview?.target ?? {mode: 'current', dataFormat: 'action-v3', data: emptyWorkspaceData()};
          if (command.type === 'CommitMigration' && target.mode === 'current') {
            const previous = before.data, data = target.data;
            const added = (kind: 'instances' | 'plans' | 'history', value: { id: string }) => !previous?.planner[kind].some(old => old.id === value.id);
            const updated = {...data,
              legacySources: data.legacySources.map(source => previous?.legacySources.some(old => old.id === source.id) ? source : { ...source, importedAt: at }),
              planner: { ...data.planner,
                instances: data.planner.instances.map(value => added('instances', value) ? { ...value, createdAt: at } : value),
                plans: data.planner.plans.map(value => added('plans', value) ? { ...value, createdAt: at, changedAt: at } : value),
                history: data.planner.history.map(value => added('history', value) ? { ...value, id: `${command.commandId}:migration`, commandId: command.commandId, at, date: dateAt(at, data.settings.zone ?? 'UTC') } : value)
              }
            };
            target = {...target, data: updated} as RestoreTarget;
          }
          if (target.mode === 'current') { validateActionData(target.data); requireValue(backupBytes(target.data) <= MAX_BACKUP_BYTES, 'DATA_TOO_LARGE', '完整备份超过 5 MiB'); }
          const resultToken = { epoch, revision: 1 };
          const write = {schemaVersion: 4, ...resultToken, ...structuredClone(target), lifecycleReceipt: {commandId: command.commandId, type: command.type, payloadFingerprint, previousToken: token, resultToken}} as EnvelopeV4;
          return { write, clearRecovery: true, at, reason: command.type, result: { ok: true, value: { token: resultToken, resultRefs: [], replayed: false } } as SubmitResult };
        });
        if (response.ok) invalidate(); return response;
      } catch (error) { return commandFailure(error); }
    }
  };
  return client;
}
export type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
