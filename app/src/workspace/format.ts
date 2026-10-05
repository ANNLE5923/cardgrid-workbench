import type {BackupV2, Command, ConfigV2, DataV2, WorkspaceData, EntityRef, EnvelopeV4, Json, LegacyBackupV1, LegacyFormat, LegacyRef} from './contracts.ts';
import type {DataV3, BackupV3, ConfigV3} from './contracts-v3.ts';
import type {DataV4, BackupV4} from './contracts-v4.ts';
import {assertV4State} from './v4-operations.ts';
import {poolCapacityIssue, validateWorkshopCatalog, validateWorkshopEntity} from '../workshop/model.ts';
import {assertV3State} from './v3-state.ts';
import { assertActionState, sameValue } from '../daily/model.ts';
import { assertDate, assertInstant, assertZone, legacyInstant } from '../daily/time.ts';
import type { Config, Data } from './legacy/domain.ts';
import type { Planner } from './legacy/planner.ts';

export const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
export function emptyActionData(): DataV2 {
  return { version: 2, settings: { zone: null, preferences: { theme: 'paper', density: 'comfortable', startHour: 8, endHour: 23, defaultMinutes: 15 }, categories: [] },
    planner: { version: 2, definitions: [], instances: [], handOrder: [], plans: [], facts: [], annotations: [], fixed: [], templates: [], days: [], rules: [], occurrences: [], captures: [], refs: [], goals: [], history: [] },
    legacySources: [], migrationBindings: [], commandReceipts: [] };
}
/** Explicit pure preparation, never called as a side effect of reading existing v2 data. */
export function upgradeActionData(data: DataV2): DataV3 {
  validateActionData(data);
  return {...structuredClone(data), version: 3, actionCards: [], bookEntries: [], pools: [], generationRules: [], dailyCopies: [], archiveLogs: [], generationLedger: []};
}
/** v3→v4: keep every existing collection, add an empty journal. */
export function upgradeV3ToV4(data: DataV3): DataV4 {
  validateActionData(data);
  return {...structuredClone(data), version: 4, journalEntries: []};
}
export function emptyWorkspaceData(): DataV4 {return upgradeV3ToV4(upgradeActionData(emptyActionData()));}
/** Stable JSON identity: retain field presence and array order; ignore object key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  throw new WorkspaceFormatError('$', 'expected JSON value');
}
export async function fingerprint(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function backupBytes(data: WorkspaceData): number {
  const dataFormat = data.version === 4 ? 'action-v4' : data.version === 3 ? 'action-v3' : 'action-v2';
  return new TextEncoder().encode(JSON.stringify({format: 'cardgrid', version: data.version, kind: 'backup', dataFormat, data})).length;
}

/** A read-only format boundary. Never use this result as authorization to commit: 2A.4 adds full semantic validation. */
export type WorkspaceInspection =
  | Readonly<{ kind: 'uninitialized'; raw: undefined }>
  | Readonly<{ kind: 'current'; raw: unknown; envelope: unknown; semanticValidationPending: true }>
  | Readonly<{ kind: 'legacy-readonly'; raw: unknown; sourceFormat: LegacyFormat | 'envelope-v2' | 'envelope-v3'; semanticValidationPending: true }>;

export type ImportInspection =
  | Readonly<{kind: 'backup-v4'; raw: unknown; backup: unknown; semanticValidationPending: true}>
  | Readonly<{kind: 'backup-v3'; raw: unknown; backup: unknown; semanticValidationPending: true}>
  | Readonly<{kind: 'config-v3'; raw: unknown; config: unknown; semanticValidationPending: true}>
  | Readonly<{ kind: 'backup-v2'; raw: unknown; backup: unknown; semanticValidationPending: true }>
  | Readonly<{ kind: 'backup-v1'; raw: unknown; backup: unknown; sourceFormat: 'cardgrid-v1-p1a' | 'cardgrid-v1-pre-planner'; semanticValidationPending: true }>
  | Readonly<{ kind: 'config-v2'; raw: unknown; config: unknown; semanticValidationPending: true }>
  | Readonly<{ kind: 'config-v1'; raw: unknown; semanticValidationPending: true }>
  | Readonly<{ kind: 'legacy-archive'; raw: unknown; semanticValidationPending: true }>;

export class WorkspaceFormatError extends Error {
  readonly path: string;
  constructor(path: string, message: string) { super(`${path}: ${message}`); this.path = path; this.name = 'WorkspaceFormatError'; }
}

type RecordValue = Record<string, unknown>;
function fail(path: string, message: string): never { throw new WorkspaceFormatError(path, message); }
function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected object');
  return value as RecordValue;
}
function exact(value: RecordValue, required: readonly string[], optional: readonly string[], path: string): void {
  for (const name of required) if (!Object.hasOwn(value, name)) fail(`${path}.${name}`, 'required field missing');
  for (const name of Object.keys(value)) if (!required.includes(name) && !optional.includes(name)) fail(`${path}.${name}`, 'unknown field');
}
function integer(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path, 'expected non-negative safe integer');
}
function string(value: unknown, path: string): void {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'expected non-empty string');
}
function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected array');
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail(`${path}[${i}]`, '数组不能含空缺项');
  return value;
}
function nullableString(value: unknown, path: string): void { if (value !== null) string(value, path); }
function oneOf(value: unknown, options: readonly unknown[], path: string): void {
  if (!options.includes(value)) fail(path, `expected ${options.join(' or ')}`);
}
function uniqueIds(items: readonly unknown[], path: string): Set<string> {
  const ids = new Set<string>();
  items.forEach((item, i) => {
    const id = record(item, `${path}[${i}]`).id;
    string(id, `${path}[${i}].id`);
    if (ids.has(id as string)) fail(`${path}[${i}].id`, 'duplicate id');
    ids.add(id as string);
  });
  return ids;
}
function checkRef(id: unknown, ids: Set<string>, path: string): void {
  string(id, path);
  if (!ids.has(id as string)) fail(path, 'unresolved reference');
}
function isLegacyRef(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (value as RecordValue).kind === 'legacy';
}
function legacyRef(value: unknown, sources: Set<string>, path: string): void {
  const ref = record(value, path);
  exact(ref, ['kind', 'sourceId', 'path'], [], path);
  oneOf(ref.kind, ['legacy'], `${path}.kind`);
  checkRef(ref.sourceId, sources, `${path}.sourceId`);
  string(ref.path, `${path}.path`);
  // Source path resolution and target type are checked by the 2A.4 semantic validator.
}

/** Checks version and required shape without defaults, cloning, migration, or writes. */
export function inspectEnvelope(raw: unknown): WorkspaceInspection {
  if (raw === undefined) return { kind: 'uninitialized', raw };
  const env = record(raw, '$');
  if (!Object.hasOwn(env, 'schemaVersion')) fail('$.schemaVersion', 'required field missing');
  if (env.schemaVersion === 4) {
    exact(env, ['schemaVersion', 'epoch', 'revision', 'mode', 'dataFormat', 'data', 'lifecycleReceipt'], [], '$');
    string(env.epoch, '$.epoch'); integer(env.revision, '$.revision');
    if (env.lifecycleReceipt !== null) {
      const receipt = record(env.lifecycleReceipt, '$.lifecycleReceipt');
      exact(receipt, ['commandId', 'payloadFingerprint', 'previousToken', 'resultToken', 'type'], [], '$.lifecycleReceipt');
      string(receipt.commandId, '$.lifecycleReceipt.commandId');
      string(receipt.payloadFingerprint, '$.lifecycleReceipt.payloadFingerprint');
      oneOf(receipt.type, ['RestoreWorkspace', 'ClearWorkspace', 'CommitMigration'], '$.lifecycleReceipt.type');
      for (const key of ['previousToken', 'resultToken']) {
        const token = record(receipt[key], `$.lifecycleReceipt.${key}`);
        exact(token, ['epoch', 'revision'], [], `$.lifecycleReceipt.${key}`);
        string(token.epoch, `$.lifecycleReceipt.${key}.epoch`);
        integer(token.revision, `$.lifecycleReceipt.${key}.revision`);
      }
    }
    if (env.mode === 'current') {
      oneOf(env.dataFormat, ['action-v2', 'action-v3', 'action-v4'], '$.dataFormat');
      inspectActionData(env.data, '$.data', env.dataFormat === 'action-v4' ? 4 : env.dataFormat === 'action-v3' ? 3 : 2);
      return { kind: 'current', raw, envelope: env, semanticValidationPending: true };
    }
    oneOf(env.mode, ['legacy-readonly'], '$.mode');
    oneOf(env.dataFormat, ['cardgrid-v1-p1a', 'cardgrid-v1-pre-planner', 'envelope-v1'], '$.dataFormat');
    if (env.dataFormat === 'envelope-v1') inspectLegacyEnvelopeV1(env.data, '$.data');
    else inspectLegacyData(env.data, '$.data', env.dataFormat as 'cardgrid-v1-p1a' | 'cardgrid-v1-pre-planner');
    return { kind: 'legacy-readonly', raw, sourceFormat: env.dataFormat as LegacyFormat, semanticValidationPending: true };
  }
  if (env.schemaVersion === 1) {
    inspectLegacyEnvelopeV1(raw, '$');
    return { kind: 'legacy-readonly', raw, sourceFormat: 'envelope-v1', semanticValidationPending: true };
  }
  if (env.schemaVersion === 2 || env.schemaVersion === 3) {
    exact(env, ['schemaVersion', 'revision', 'data'], [], '$');
    integer(env.revision, '$.revision');
    inspectLegacyData(env.data, '$.data');
    return { kind: 'legacy-readonly', raw, sourceFormat: env.schemaVersion === 2 ? 'envelope-v2' : 'envelope-v3', semanticValidationPending: true };
  }
  fail('$.schemaVersion', 'unsupported envelope version');
}

function inspectLegacyEnvelopeV1(raw: unknown, path: string): void {
  const env = record(raw, path);
  exact(env, ['schemaVersion', 'revision', 'config'], [], path);
  oneOf(env.schemaVersion, [1], `${path}.schemaVersion`);
  integer(env.revision, `${path}.revision`);
  inspectLegacyConfig(env.config, `${path}.config`);
}
function inspectLegacyConfig(raw: unknown, path: string): void {
  const config = record(raw, path);
  exact(config, ['preferences', 'categories', 'cards', 'schedules'], [], path);
  const preferences = record(config.preferences, `${path}.preferences`);
  exact(preferences, ['theme', 'density', 'startHour', 'endHour', 'defaultMinutes'], [], `${path}.preferences`);
  oneOf(preferences.theme, ['paper', 'night'], `${path}.preferences.theme`);
  oneOf(preferences.density, ['comfortable', 'compact'], `${path}.preferences.density`);
  for (const name of ['startHour', 'endHour', 'defaultMinutes']) integer(preferences[name], `${path}.preferences.${name}`);
  for (const name of ['categories', 'cards', 'schedules']) array(config[name], `${path}.${name}`);
}
function inspectLegacyData(raw: unknown, path: string, expected?: 'cardgrid-v1-p1a' | 'cardgrid-v1-pre-planner'): 'cardgrid-v1-p1a' | 'cardgrid-v1-pre-planner' {
  const data = record(raw, path);
  const p1a = Object.hasOwn(data, 'planner');
  if (expected && (expected === 'cardgrid-v1-p1a') !== p1a) fail(`${path}.planner`, 'data format does not match declared version');
  exact(data, ['config', 'legacyArchives'], ['projects', 'inbox', 'routines', 'occurrences', 'days', 'events', ...(p1a ? ['planner'] : [])], path);
  inspectLegacyConfig(data.config, `${path}.config`);
  for (const name of ['legacyArchives', 'projects', 'inbox', 'routines', 'occurrences', 'days', 'events']) {
    if (Object.hasOwn(data, name)) array(data[name], `${path}.${name}`);
  }
  if (p1a) {
    const planner = record(data.planner, `${path}.planner`);
    exact(planner, ['version', 'tasks', 'rules', 'occurrences', 'templates', 'days', 'captures', 'history', 'refs', 'goals', 'legacyImported'], [], `${path}.planner`);
    oneOf(planner.version, [1], `${path}.planner.version`);
    if (typeof planner.legacyImported !== 'boolean') fail(`${path}.planner.legacyImported`, 'expected boolean');
    for (const name of ['tasks', 'rules', 'occurrences', 'templates', 'captures', 'days', 'history', 'refs', 'goals']) {
      array(planner[name], `${path}.planner.${name}`);
    }
  }
  return p1a ? 'cardgrid-v1-p1a' : 'cardgrid-v1-pre-planner';
}

/** Structural checks and the core cross-record references needed for safe format recognition. */
export function inspectDataV2(raw: unknown, path = '$'): void {
  inspectActionData(raw, path, 2);
}
function inspectActionData(raw: unknown, path: string, version: 2 | 3 | 4): void {
  const data = record(raw, path);
  const additions = [
    ...(version >= 3 ? ['actionCards', 'bookEntries', 'pools', 'generationRules', 'dailyCopies', 'archiveLogs', 'generationLedger'] : []),
    ...(version === 4 ? ['journalEntries'] : []),
  ];
  exact(data, ['version', 'settings', 'planner', 'legacySources', 'migrationBindings', 'commandReceipts', ...additions], [], path);
  oneOf(data.version, [version], `${path}.version`);
  additions.forEach(name => array(data[name], `${path}.${name}`));
  const settings = record(data.settings, `${path}.settings`);
  exact(settings, ['zone', 'preferences', 'categories'], [], `${path}.settings`);
  nullableString(settings.zone, `${path}.settings.zone`);
  record(settings.preferences, `${path}.settings.preferences`);
  const categories = array(settings.categories, `${path}.settings.categories`);
  uniqueIds(categories, `${path}.settings.categories`);
  const planner = record(data.planner, `${path}.planner`);
  const names = ['definitions', 'instances', 'handOrder', 'plans', 'facts', 'annotations', 'fixed', 'templates', 'days', 'rules', 'occurrences', 'captures', 'refs', 'goals', 'history'] as const;
  exact(planner, ['version', ...names], [], `${path}.planner`);
  oneOf(planner.version, [2], `${path}.planner.version`);
  const lists = Object.fromEntries(names.map(name => [name, array(planner[name], `${path}.planner.${name}`)])) as Record<(typeof names)[number], readonly unknown[]>;
  const ids = Object.fromEntries(names.filter(name => name !== 'handOrder' && name !== 'days').map(name => [name, uniqueIds(lists[name], `${path}.planner.${name}`)])) as Record<string, Set<string>>;
  const sources = uniqueIds(array(data.legacySources, `${path}.legacySources`), `${path}.legacySources`);
  const bindings = array(data.migrationBindings, `${path}.migrationBindings`);
  array(data.commandReceipts, `${path}.commandReceipts`);
  const hand = new Set<string>();
  lists.handOrder.forEach((id, i) => {
    checkRef(id, ids.instances, `${path}.planner.handOrder[${i}]`);
    if (hand.has(id as string)) fail(`${path}.planner.handOrder[${i}]`, 'duplicate instance');
    hand.add(id as string);
  });
  lists.plans.forEach((item, i) => checkRef(record(item, `${path}.planner.plans[${i}]`).instanceId, ids.instances, `${path}.planner.plans[${i}].instanceId`));
  lists.facts.forEach((item, i) => checkRef(record(item, `${path}.planner.facts[${i}]`).instanceId, ids.instances, `${path}.planner.facts[${i}].instanceId`));
  lists.annotations.forEach((item, i) => checkRef(record(item, `${path}.planner.annotations[${i}]`).factId, ids.facts, `${path}.planner.annotations[${i}].factId`));
  lists.occurrences.forEach((item, i) => {
    const occurrence = record(item, `${path}.planner.occurrences[${i}]`);
    checkRef(occurrence.ruleId, ids.rules, `${path}.planner.occurrences[${i}].ruleId`);
    checkRef(occurrence.instanceId, ids.instances, `${path}.planner.occurrences[${i}].instanceId`);
  });
  lists.days.forEach((item, i) => {
    const day = record(item, `${path}.planner.days[${i}]`);
    array(day.top3, `${path}.planner.days[${i}].top3`).forEach((ref, j) => {
      const at = `${path}.planner.days[${i}].top3[${j}]`;
      if (isLegacyRef(ref)) legacyRef(ref, sources, at);
      else { const itemRef = record(ref, at); oneOf(itemRef.kind, ['instance'], `${at}.kind`); checkRef(itemRef.id, ids.instances, `${at}.id`); }
    });
  });
  bindings.forEach((item, i) => {
    const at = `${path}.migrationBindings[${i}]`;
    const binding = record(item, at);
    checkRef(binding.sourceId, sources, `${at}.sourceId`);
    string(binding.path, `${at}.path`);
  });
}

export function inspectImport(raw: unknown): ImportInspection {
  const pack = record(raw, '$');
  if (pack.format === 'cardgrid' && pack.version === 4 && pack.kind === 'backup') {
    exact(pack, ['format', 'version', 'kind', 'dataFormat', 'data'], [], '$');
    oneOf(pack.dataFormat, ['action-v4'], '$.dataFormat'); inspectActionData(pack.data, '$.data', 4);
    return {kind: 'backup-v4', raw, backup: pack, semanticValidationPending: true};
  }
  if (pack.format === 'cardgrid' && pack.version === 3 && pack.kind === 'backup') {
    exact(pack, ['format', 'version', 'kind', 'dataFormat', 'data'], [], '$');
    oneOf(pack.dataFormat, ['action-v3'], '$.dataFormat'); inspectActionData(pack.data, '$.data', 3);
    return {kind: 'backup-v3', raw, backup: pack, semanticValidationPending: true};
  }
  if (pack.format === 'cardgrid' && pack.version === 3 && pack.kind === 'config') {
    exact(pack, ['format', 'version', 'kind', 'config'], [], '$');
    const config = record(pack.config, '$.config');
    exact(config, ['settings', 'definitions', 'templates', 'rules', 'actionCards', 'bookEntries', 'pools', 'generationRules'], [], '$.config');
    record(config.settings, '$.config.settings');
    for (const name of ['definitions', 'templates', 'rules', 'actionCards', 'bookEntries', 'pools', 'generationRules']) array(config[name], `$.config.${name}`);
    return {kind: 'config-v3', raw, config: pack, semanticValidationPending: true};
  }
  if (pack.format !== 'cardgrid') {
    if (pack.version === 2 && Object.hasOwn(pack, 'days') && Object.hasOwn(pack, 'daily') && Object.hasOwn(pack, 'customTemplates'))
      return { kind: 'legacy-archive', raw, semanticValidationPending: true };
    if (typeof pack.date === 'string' && Array.isArray(pack.enabled) && Array.isArray(pack.done))
      return { kind: 'legacy-archive', raw, semanticValidationPending: true };
    fail('$.format', 'unknown file format');
  }
  oneOf(pack.kind, ['backup', 'config'], '$.kind');
  if (pack.version === 2 && pack.kind === 'backup') {
    exact(pack, ['format', 'version', 'kind', 'dataFormat', 'data'], [], '$');
    if (pack.dataFormat === 'action-v2') inspectDataV2(pack.data, '$.data');
    else if (pack.dataFormat === 'envelope-v1') inspectLegacyEnvelopeV1(pack.data, '$.data');
    else fail('$.dataFormat', 'unsupported backup data format');
    return { kind: 'backup-v2', raw, backup: pack, semanticValidationPending: true };
  }
  if (pack.version === 1 && pack.kind === 'backup') {
    exact(pack, ['format', 'version', 'kind', 'data'], [], '$');
    const sourceFormat = inspectLegacyData(pack.data, '$.data');
    return { kind: 'backup-v1', raw, backup: pack, sourceFormat, semanticValidationPending: true };
  }
  if (pack.version === 2 && pack.kind === 'config') {
    exact(pack, ['format', 'version', 'kind', 'config'], [], '$');
    const config = record(pack.config, '$.config');
    exact(config, ['settings', 'definitions', 'templates', 'rules'], [], '$.config');
    record(config.settings, '$.config.settings');
    for (const name of ['definitions', 'templates', 'rules']) array(config[name], `$.config.${name}`);
    return { kind: 'config-v2', raw, config: pack, semanticValidationPending: true };
  }
  if (pack.version === 1 && pack.kind === 'config') {
    exact(pack, ['format', 'version', 'kind', 'config'], [], '$');
    inspectLegacyConfig(pack.config, '$.config');
    return { kind: 'config-v1', raw, semanticValidationPending: true };
  }
  fail('$.version', 'unsupported or mismatched package version');
}

/** Parsing has the same read-only semantics as inspection; the original text remains available on failure. */
export function inspectImportText(text: string): ImportInspection {
  if (new TextEncoder().encode(text).length > 5 * 1024 * 1024) fail('$', 'input exceeds 5 MiB');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { fail('$', 'invalid JSON'); }
  return inspectImport(raw);
}

/** Reads an already-open database; opening or upgrading the database belongs to a later lifecycle step. */
export function readWorkspaceSnapshot(db: IDBDatabase): Promise<WorkspaceInspection> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = db.transaction('workspace', 'readonly'); }
    catch (error) { reject(error); return; }
    const request = transaction.objectStore('workspace').get('current');
    request.onsuccess = () => {
      try { resolve(inspectEnvelope(request.result)); }
      catch (error) { reject(error); }
    };
    request.onerror = () => reject(request.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Read transaction aborted'));
  });
}

// Strict schemas supplement the intentionally partial 2A.1 inspectors. No defaults are applied.
type Check = (value: unknown, path: string) => void;
const textValue: Check = (v, p) => { if (typeof v !== 'string') fail(p, '需要文本'); };
const nonempty: Check = string;
const booleanValue: Check = (v, p) => { if (typeof v !== 'boolean') fail(p, '需要布尔值'); };
const literal = (...values: readonly unknown[]): Check => (v, p) => oneOf(v, values, p);
const numberWithin = (min: number, max: number): Check => (v, p) => { if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) fail(p, `需要 ${min}—${max} 的整数`); };
const nullable = (check: Check): Check => (v, p) => { if (v !== null) check(v, p); };
const items = (check: Check): Check => (v, p) => array(v, p).forEach((item, i) => check(item, `${p}[${i}]`));
const shape = (fields: Record<string, Check>, optional: readonly string[] = []): Check => (v, p) => {
  const object = record(v, p); exact(object, Object.keys(fields).filter(key => !optional.includes(key)), optional, p);
  for (const [key, check] of Object.entries(fields)) if (Object.hasOwn(object, key)) check(object[key], `${p}.${key}`);
};
const checked = (fn: (v: string) => void): Check => (v, p) => { textValue(v, p); try { fn(v as string); } catch (error) { fail(p, (error as Error).message); } };
const dateValue = checked(assertDate), instantValue = checked(assertInstant), zoneValue = checked(assertZone);
const versionValue = numberWithin(1, Number.MAX_SAFE_INTEGER);
const clockValue: Check = (v, p) => { textValue(v, p); if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v as string)) fail(p, '需要 HH:mm'); };
const colorValue: Check = (v, p) => { textValue(v, p); if (!/^#[\da-f]{6}$/i.test(v as string)) fail(p, '需要六位颜色'); };
const jsonValue: Check = (v, p) => { try { canonicalJson(v); } catch { fail(p, '需要可无损保存的 JSON'); } };
const weekdays: Check = (v, p) => { items(numberWithin(0, 6))(v, p); if (new Set(v as number[]).size !== (v as number[]).length) fail(p, '星期重复'); };
const versionRef = shape({ id: nonempty, version: versionValue });
const legacyRefShape = shape({ kind: literal('legacy'), sourceId: nonempty, path: nonempty });
const sourceRef: Check = (v, p) => {
  const source = record(v, p);
  if (source.kind === 'legacy') legacyRefShape(v, p);
  else if (source.kind === 'manual') shape({ kind: literal('manual') })(v, p);
  else shape({ kind: literal('definition', 'capture', 'occurrence', 'makeup'), id: nonempty })(v, p);
};
const sourceRefV3: Check = (v, p) => {if (record(v, p).kind === 'daily-copy') shape({kind: literal('daily-copy'), id: nonempty})(v, p); else sourceRef(v, p);};
const entityRef: Check = (v, p) => {
  if (record(v, p).kind === 'legacy') legacyRefShape(v, p);
  else shape({ kind: literal('definition', 'instance', 'plan', 'fact', 'annotation', 'fixed', 'template', 'rule', 'occurrence', 'capture', 'project', 'goal', 'day', 'settings'), id: nonempty })(v, p);
};
const entityRefV3: Check = (v, p) => {
  const kind = record(v, p).kind;
  if (['action-card', 'book-entry', 'pool', 'generation-rule', 'daily-copy', 'archive-log', 'journal-entry'].includes(kind as string))
    shape({kind: literal('action-card', 'book-entry', 'pool', 'generation-rule', 'daily-copy', 'archive-log', 'journal-entry'), id: nonempty})(v, p);
  else entityRef(v, p);
};
const instanceRef: Check = (v, p) => { if (record(v, p).kind === 'legacy') legacyRefShape(v, p); else shape({ kind: literal('instance'), id: nonempty })(v, p); };
const makeupRef: Check = (v, p) => { if (record(v, p).kind === 'legacy') legacyRefShape(v, p); else shape({ kind: literal('occurrence'), id: nonempty })(v, p); };
const labels = items(shape({ id: nonempty, label: textValue }));
const contentShape = shape({ title: nonempty, criteria: textValue, presetMinutes: nullable(numberWithin(5, 1440)), color: colorValue, categoryId: nullable(nonempty), categoryLabel: nullable(textValue), minimum: booleanValue,
  projectIds: items(nonempty), goalIds: items(nonempty), projectLabels: labels, goalLabels: labels });
const recordedRangeShape = shape({ startAt: instantValue, endAt: instantValue, zone: zoneValue, localStart: nonempty, localEnd: nonempty, startOffset: nonempty, endOffset: nonempty });
const preferencesShape = shape({ theme: literal('paper', 'night'), density: literal('comfortable', 'compact'), startHour: numberWithin(0, 23), endHour: numberWithin(1, 24), defaultMinutes: numberWithin(1, 1440) });
const settingsShape = shape({ zone: nullable(zoneValue), preferences: preferencesShape, categories: items(shape({ id: nonempty, name: nonempty, color: colorValue })) });
const definitionShape = shape({ id: nonempty, version: versionValue, content: contentShape, enabled: booleanValue, parentDefinitionId: nullable(nonempty), source: sourceRef });
const templateShape = shape({ id: nonempty, version: versionValue, name: nonempty, weekdays, entries: items(shape({ id: nonempty, title: nonempty, start: clockValue, elapsedMinutes: numberWithin(5, 1440), definitionId: nullable(nonempty) })), source: sourceRef });
const ruleShape = shape({ id: nonempty, version: versionValue, name: nonempty, definitionId: nonempty, weekdays, startDate: dateValue, zone: zoneValue, status: literal('active', 'paused', 'archived'), source: sourceRef });
const instanceFields = {id: nonempty, version: versionValue, definition: nullable(versionRef), creationSnapshot: contentShape, currentContent: contentShape, source: sourceRef, createdAt: instantValue,
  targetDate: nullable(dateValue), state: literal('open', 'withdrawn'), occurrenceId: nullable(nonempty), makeupOf: nullable(makeupRef)};
const instanceShape = shape(instanceFields);
const bookShape: Check = (v, p) => {const result = validateWorkshopEntity('bookEntries', v); if (!result.ok) fail(p, result.issues.map(i => i.message).join('; '));};
const slotSelectionShape = shape({slotId: nonempty, entryId: nonempty, entrySnapshot: bookShape, selectedAt: instantValue});
const dailyAcceptanceShape = shape({copyId: nonempty, sourceDate: dateValue, slotSelections: items(slotSelectionShape)});
const instanceShapeV3 = shape({...instanceFields, source: sourceRefV3, daily: nullable(dailyAcceptanceShape)}, ['daily']);
const slotSpecShape = shape({id: nonempty, label: nonempty, poolId: nonempty, required: booleanValue, valueKind: literal('entry')});
const dailyCopyShape = shape({id: nonempty, version: versionValue, ruleId: nonempty, ruleVersion: versionValue, actionCard: versionRef, sourceDate: dateValue, generatedAt: instantValue,
  contentSnapshot: contentShape, slotSpecSnapshot: items(slotSpecShape), status: literal('active'), acceptedInstanceIds: items(nonempty)});
const archiveLogShape = shape({id: nonempty, version: versionValue, copyId: nonempty, ruleId: nonempty, actionCard: versionRef, sourceDate: dateValue, contentSnapshot: contentShape,
  slotSelectionsSnapshot: items(slotSelectionShape), acceptedInstanceIds: items(nonempty), disposition: literal('accepted', 'none-accepted'), archivedAt: instantValue});
const generationLedgerShape = shape({ruleId: nonempty, sourceDate: dateValue, copyId: nonempty, at: instantValue});
const journalEntryShape = shape({id: nonempty, version: versionValue, date: dateValue, zone: zoneValue,
  text: textValue, createdAt: instantValue, updatedAt: instantValue});
const planShape = shape({ id: nonempty, version: versionValue, instanceId: nonempty, range: recordedRangeShape, contentSnapshot: contentShape, status: literal('active', 'retracted', 'confirmed'), createdAt: instantValue, changedAt: instantValue });
const factFields = {id: nonempty, instanceId: nonempty, contentSnapshot: contentShape, actualRange: recordedRangeShape,
  plannedSnapshot: nullable(shape({planId: nonempty, planVersion: versionValue, range: recordedRangeShape, content: contentShape})), confirmedAt: instantValue, source: sourceRef};
const factShape = shape(factFields), factShapeV3 = shape({...factFields, source: sourceRefV3});
const fixedShape = shape({ id: nonempty, version: versionValue, title: nonempty, range: recordedRangeShape, cancelled: booleanValue, ownerDate: dateValue,
  template: nullable(versionRef), templateEntryId: nullable(nonempty), manuallyOverridden: booleanValue, source: sourceRef });
const dayShape = shape({ date: dateValue, zone: zoneValue, version: versionValue, name: textValue, template: nullable(versionRef), minimum: booleanValue, top3: items(instanceRef),
  overrides: items(shape({ entryId: nonempty, fixedId: nullable(nonempty), kind: literal('edited', 'cancelled'), at: instantValue })) });
const plannerFields = {version: literal(2), definitions: items(definitionShape), instances: items(instanceShape), handOrder: items(nonempty), plans: items(planShape), facts: items(factShape),
  annotations: items(shape({ id: nonempty, factId: nonempty, text: nonempty, createdAt: instantValue })), fixed: items(fixedShape), templates: items(templateShape), days: items(dayShape), rules: items(ruleShape),
  occurrences: items(shape({ id: nonempty, ruleId: nonempty, date: dateValue, instanceId: nonempty, disposition: literal('generated', 'skipped', 'missed', 'cancelled') })),
  captures: items(shape({ id: nonempty, version: versionValue, text: nonempty, createdAt: instantValue, source: textValue, status: literal('unprocessed', 'resolved', 'archived', 'discarded'), target: nullable(instanceRef) })),
  refs: items(shape({ id: nonempty, name: nonempty, status: literal('active', 'paused', 'archived', 'completed') })), goals: items(shape({ id: nonempty, name: nonempty })),
  history: items(shape({id: nonempty, commandId: nonempty, at: instantValue, date: dateValue, type: nonempty, entity: entityRef, before: jsonValue, after: jsonValue}))};
const plannerShape = shape(plannerFields);
const plannerShapeV3 = shape({...plannerFields, instances: items(instanceShapeV3), facts: items(factShapeV3),
  history: items(shape({id: nonempty, commandId: nonempty, at: instantValue, date: dateValue, type: nonempty, entity: entityRefV3, before: jsonValue, after: jsonValue}))});

/** Keyed source paths: /planner/days/@YYYY-MM-DD/blocks/@id. Root is '/'. */
export function resolveLegacyPath(raw: unknown, path: string): unknown {
  if (path === '/') return raw;
  if (!path.startsWith('/')) fail(path, '来源路径必须为绝对路径');
  let current: unknown = raw;
  for (const part of path.slice(1).split('/').map(v => v.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (Array.isArray(current)) {
      if (!part.startsWith('@')) fail(path, '集合路径须使用原始 ID/日期');
      const matches = current.filter(value => value && typeof value === 'object' && ((value as RecordValue).id ?? (value as RecordValue).date) === part.slice(1));
      if (matches.length !== 1) fail(path, '来源对象不存在或不唯一'); current = matches[0];
    } else {
      const value = record(current, path);
      if (!Object.hasOwn(value, part)) fail(path, '来源字段不存在'); current = value[part];
    }
  }
  return current;
}
export const sourcePathPart = (id: string): string => '@' + id.replace(/~/g, '~0').replace(/\//g, '~1');
export function validateActionData(raw: unknown, path = '$'): asserts raw is WorkspaceData {
  const version = record(raw, path).version as 2 | 3 | 4;
  if (version !== 2 && version !== 3 && version !== 4) fail(path, '不支持的数据版本');
  inspectActionData(raw, path, version);
  const additions: Record<string, Check> = version >= 3 ? {
    actionCards: items((v, p) => {const result = validateWorkshopEntity('actionCards', v); if (!result.ok) fail(p, result.issues.map(i => i.message).join('; '));}),
    bookEntries: items(bookShape), pools: items((v, p) => {const result = validateWorkshopEntity('pools', v); if (!result.ok) fail(p, result.issues.map(i => i.message).join('; '));}),
    generationRules: items((v, p) => {const result = validateWorkshopEntity('generationRules', v); if (!result.ok) fail(p, result.issues.map(i => i.message).join('; '));}),
    dailyCopies: items(dailyCopyShape), archiveLogs: items(archiveLogShape), generationLedger: items(generationLedgerShape),
    ...(version === 4 ? {journalEntries: items(journalEntryShape)} : {}),
  } : {};
  shape({version: literal(version), settings: settingsShape, planner: version >= 3 ? plannerShapeV3 : plannerShape,
    legacySources: items(shape({ id: nonempty, format: literal('cardgrid-v1-p1a', 'cardgrid-v1-pre-planner', 'envelope-v1', 'legacy-archive'), fingerprint: nonempty, importedAt: instantValue, raw: jsonValue })),
    migrationBindings: items(shape({ sourceId: nonempty, path: nonempty, sourceFingerprint: nonempty, mappingVersion: literal(1), target: version >= 3 ? entityRefV3 : entityRef, disposition: literal('converted', 'readonly') })),
    commandReceipts: items(shape({commandId: nonempty, type: nonempty, payloadFingerprint: nonempty, resultRefs: items(version >= 3 ? entityRefV3 : entityRef)})), ...additions})(raw, path);
  const data = raw as WorkspaceData, p = data.planner;
  data.legacySources.forEach((source, i) => {
    const at = `${path}.legacySources[${i}].raw`;
    if (source.format === 'envelope-v1') validateLegacyEnvelope(source.raw, at);
    else if (source.format === 'legacy-archive') validateLegacyArchive(source.raw, at);
    else { validateLegacyData(source.raw, at); if (inspectLegacyData(source.raw, at) !== source.format) fail(at, '来源格式标记不匹配'); }
  });
  if (data.settings.preferences.endHour <= data.settings.preferences.startHour) fail(`${path}.settings.preferences.endHour`, '结束小时必须晚于开始');
  const collections: Record<string, readonly {id: string}[]> = { definition: p.definitions, instance: p.instances, plan: p.plans, fact: p.facts, annotation: p.annotations, fixed: p.fixed,
    template: p.templates, rule: p.rules, occurrence: p.occurrences, capture: p.captures, project: p.refs, goal: p.goals, day: p.days.map(d => ({ id: d.date })), settings: [{ id: 'workspace' }] };
  if (data.version === 3 || data.version === 4) Object.assign(collections, {'action-card': data.actionCards, 'book-entry': data.bookEntries, pool: data.pools,
    'generation-rule': data.generationRules, 'daily-copy': data.generationLedger.map(l => ({id: l.copyId})), 'archive-log': data.archiveLogs});
  if (data.version === 4) collections['journal-entry'] = data.journalEntries;
  const legacy = (ref: LegacyRef, at: string, allowed?: RegExp) => {
    const source = data.legacySources.find(s => s.id === ref.sourceId);
    if (!source) fail(at, '旧来源不存在');
    if (allowed && !allowed.test(ref.path)) fail(at, '旧引用指向错误类型');
    try { const target = resolveLegacyPath(source.raw, ref.path); if (target === null || typeof target !== 'object') fail(at, '旧引用须指向对象'); }
    catch (error) { fail(at, (error as Error).message); }
  };
  const refCheck = (ref: EntityRef, at: string) => {
    if (ref.kind === 'legacy') legacy(ref, at);
    else if (!collections[ref.kind]?.some(item => item.id === ref.id)) fail(at, '引用对象不存在');
  };
  const sourceCheck = (ref: DataV2['planner']['instances'][number]['source'], at: string) => {
    if (ref.kind === 'manual') return;
    if (ref.kind === 'legacy') legacy(ref, at);
    else refCheck({ kind: ref.kind === 'makeup' ? 'occurrence' : ref.kind, id: ref.id }, at);
  };
  for (const [name, objects] of Object.entries({ definitions: p.definitions, instances: p.instances, facts: p.facts, fixed: p.fixed, templates: p.templates, rules: p.rules }))
    objects.forEach((item, i) => sourceCheck(item.source, `${path}.planner.${name}[${i}].source`));
  if (data.version === 3 || data.version === 4) for (const name of ['actionCards', 'bookEntries', 'pools', 'generationRules'] as const)
    data[name].forEach((item, i) => sourceCheck(item.source, `${path}.${name}[${i}].source`));
  p.rules.forEach((rule, i) => refCheck({ kind: 'definition', id: rule.definitionId }, `${path}.planner.rules[${i}].definitionId`));
  p.templates.forEach((template, i) => {
    uniqueIds(template.entries, `${path}.planner.templates[${i}].entries`);
    template.entries.forEach((entry, j) => {
      const startMinuteOfDay = Number(entry.start.slice(0, 2)) * 60 + Number(entry.start.slice(3));
      if (startMinuteOfDay % 5) fail(`${path}.planner.templates[${i}].entries[${j}].start`, '起点须落在 5 分钟网格');
      if (entry.elapsedMinutes % 5) fail(`${path}.planner.templates[${i}].entries[${j}].elapsedMinutes`, '时长须为五分钟倍数');
      if (entry.definitionId) refCheck({ kind: 'definition', id: entry.definitionId }, `${path}.planner.templates[${i}].entries[${j}].definitionId`);
    });
  });
  for (const item of [...p.days, ...p.fixed]) if (item.template) {
    const target = p.templates.find(t => t.id === item.template!.id);
    if (!target || target.version < item.template.version) fail(path + '.planner', '模板版本引用无效');
  }
  p.days.forEach((day, i) => {
    day.top3.forEach((ref, j) => ref.kind === 'legacy' ? legacy(ref, `${path}.planner.days[${i}].top3[${j}]`, /^\/(planner\/tasks|config\/cards)\/@/) : refCheck(ref, path));
    day.overrides.forEach(override => { if (override.fixedId) refCheck({ kind: 'fixed', id: override.fixedId }, path); });
  });
  p.instances.forEach((instance, i) => { if (instance.makeupOf?.kind === 'legacy') legacy(instance.makeupOf, `${path}.planner.instances[${i}].makeupOf`, /^\/(planner\/)?occurrences\/@/); });
  p.captures.forEach((capture, i) => {
    if (capture.status === 'resolved' && !capture.target) fail(`${path}.planner.captures[${i}].target`, '已转换捕获缺少目标');
    if (capture.target?.kind === 'legacy') legacy(capture.target, `${path}.planner.captures[${i}].target`, /^\/(planner\/tasks|config\/cards)\/@/);
    else if (capture.target) refCheck(capture.target, path);
  });
  p.history.forEach((history, i) => refCheck(history.entity, `${path}.planner.history[${i}].entity`));
  const bindingKeys = new Set<string>();
  data.migrationBindings.forEach((binding, i) => {
    const at = `${path}.migrationBindings[${i}]`, key = JSON.stringify([binding.sourceId, binding.path]);
    if (bindingKeys.has(key)) fail(at, '来源映射重复'); bindingKeys.add(key);
    const source = data.legacySources.find(s => s.id === binding.sourceId)!;
    legacy({ kind: 'legacy', sourceId: binding.sourceId, path: binding.path }, at);
    if (binding.sourceFingerprint !== source.fingerprint) fail(at, '来源指纹不匹配');
    refCheck(binding.target, at);
    if (binding.disposition === 'readonly' && !sameValue(binding.target, { kind: 'legacy', sourceId: binding.sourceId, path: binding.path })) fail(at, '只读映射必须指向原文自身');
  });
  const commandIds = new Set<string>();
  data.commandReceipts.forEach((receipt, i) => {
    if (commandIds.has(receipt.commandId)) fail(`${path}.commandReceipts[${i}]`, '回执请求标识重复'); commandIds.add(receipt.commandId);
    receipt.resultRefs.forEach(ref => refCheck(ref, `${path}.commandReceipts[${i}].resultRefs`));
  });
  try { assertActionState(data); } catch (error) { fail(path, (error as Error).message); }
  if (data.version >= 3) try {assertV3State(data as DataV3);} catch (error) {fail(path, (error as Error).message);}
  if (data.version === 4) try {assertV4State(data);} catch (error) {fail(path, (error as Error).message);}
}
export async function validateSourceFingerprints(data: WorkspaceData): Promise<void> {
  for (const [i, source] of data.legacySources.entries()) if (await fingerprint(source.raw) !== source.fingerprint) fail(`$.legacySources[${i}].fingerprint`, '原文摘要不匹配');
}
export function validateDefinitionConfig(raw: unknown): asserts raw is ConfigV2 | ConfigV3 {
  if (record(raw, '$').version === 3) {
    shape({format: literal('cardgrid'), version: literal(3), kind: literal('config'), config: shape({settings: settingsShape, definitions: items(definitionShape),
      templates: items(templateShape), rules: items(ruleShape), actionCards: items(jsonValue), bookEntries: items(jsonValue), pools: items(jsonValue), generationRules: items(jsonValue)})})(raw, '$');
    const pack = raw as ConfigV3, config = pack.config;
    validateDefinitionConfig({format: 'cardgrid', version: 2, kind: 'config', config: {settings: config.settings, definitions: config.definitions, templates: config.templates, rules: config.rules}});
    const result = validateWorkshopCatalog({actionCards: config.actionCards, bookEntries: config.bookEntries, pools: config.pools, generationRules: config.generationRules});
    if (!result.ok) fail('$.config', result.issues.map(i => `${i.path}: ${i.message}`).join('; '));
    config.pools.forEach((pool, index) => {
      const capacity = poolCapacityIssue(pool, `$.config.pools[${index}]`);
      if (capacity) fail(capacity.path, capacity.message);
    });
    return;
  }
  shape({ format: literal('cardgrid'), version: literal(2), kind: literal('config'), config: shape({ settings: settingsShape, definitions: items(definitionShape), templates: items(templateShape), rules: items(ruleShape) }) })(raw, '$');
  const pack = raw as ConfigV2, blank = emptyActionData();
  // Sources and project/goal snapshots can refer to the destination workspace. Import checks those after merging.
  const definitions = pack.config.definitions.map(d => ({ ...d, source: { kind: 'manual' as const } }));
  const templates = pack.config.templates.map(d => ({ ...d, source: { kind: 'manual' as const } }));
  const rules = pack.config.rules.map(d => ({ ...d, source: { kind: 'manual' as const } }));
  validateActionData({ ...blank, settings: pack.config.settings, planner: { ...blank.planner, definitions, templates, rules } });
}

const legacyTimestamp = checked(value => { legacyInstant(value); });
const optionalDate: Check = (v, p) => { if (v !== '') dateValue(v, p); };
const legacyCardShape = shape({ id: nonempty, title: nonempty, kind: literal('habit', 'temporary', 'increment'), minutes: numberWithin(1, 1440), categoryId: nullable(nonempty), parentId: nullable(nonempty), steps: textValue, enabled: booleanValue });
const legacyConfigShape = shape({ preferences: preferencesShape, categories: items(shape({ id: nonempty, name: nonempty, color: colorValue })), cards: items(legacyCardShape), schedules: items(shape({ id: nonempty, name: nonempty,
  entries: items(shape({ cardId: nonempty, start: clockValue, minutes: numberWithin(1, 1440) })), source: shape({ workbook: nonempty, sheet: nonempty, range: nonempty }) }, ['source'])) });
export function validateLegacyConfig(raw: unknown, path = '$'): asserts raw is Config {
  legacyConfigShape(raw, path); const config = raw as Config;
  if (config.preferences.endHour <= config.preferences.startHour) fail(path, '旧偏好时间范围无效');
  const cards = uniqueIds(config.cards, `${path}.cards`), categories = uniqueIds(config.categories, `${path}.categories`); uniqueIds(config.schedules, `${path}.schedules`);
  for (const [i, card] of config.cards.entries()) {
    if (card.categoryId !== null) checkRef(card.categoryId, categories, `${path}.cards[${i}].categoryId`);
    if (card.kind === 'increment') { if (!card.parentId) fail(`${path}.cards[${i}].parentId`, '增量卡缺少原卡'); }
    else if (card.parentId !== null) fail(`${path}.cards[${i}].parentId`, '普通卡不能包含原卡');
    const seen = new Set<string>([card.id]); let parent = card.parentId;
    while (parent !== null) {
      checkRef(parent, cards, `${path}.cards[${i}].parentId`); if (seen.has(parent)) fail(`${path}.cards[${i}].parentId`, '原卡形成循环');
      seen.add(parent); parent = config.cards.find(c => c.id === parent)!.parentId;
    }
  }
  for (const [i, schedule] of config.schedules.entries()) for (const [j, entry] of schedule.entries.entries()) {
    checkRef(entry.cardId, cards, `${path}.schedules[${i}].entries[${j}].cardId`);
    const [h, m] = entry.start.split(':').map(Number);
    if (h * 60 + m + entry.minutes > 1440) fail(`${path}.schedules[${i}].entries[${j}]`, '旧模板超过当天范围');
  }
}
const legacyBlockShape = shape({ id: nonempty, title: nonempty, start: numberWithin(0, 1439), end: numberWithin(1, 1440), kind: literal('fixed', 'flexible'), task: textValue, cancelled: booleanValue });
const legacyProjectShape = shape({ id: nonempty, name: nonempty, status: literal('active', 'paused', 'archived', 'completed') });
const legacyPlannerShape = shape({ version: literal(1), legacyImported: booleanValue,
  tasks: items(shape({ id: nonempty, title: nonempty, date: optionalDate, status: literal('inbox', 'planned', 'doing', 'done', 'skipped', 'cancelled'), criteria: textValue, minimum: booleanValue,
    goals: items(nonempty), projects: items(nonempty), source: textValue, occurrence: textValue, makeupOf: textValue })),
  rules: items(shape({ id: nonempty, name: nonempty, title: nonempty, weekdays, status: literal('active', 'paused', 'archived'), start: dateValue, criteria: textValue, minimum: booleanValue, goals: items(nonempty), projects: items(nonempty) })),
  occurrences: items(shape({ id: nonempty, rule: nonempty, date: dateValue, task: nonempty, status: literal('generated', 'completed', 'skipped', 'missed', 'cancelled') })),
  templates: items(shape({ id: nonempty, name: nonempty, weekdays, blocks: items(legacyBlockShape) })),
  days: items(shape({ date: dateValue, template: textValue, name: textValue, blocks: items(legacyBlockShape), top3: items(nonempty), minimum: booleanValue, overrides: items(shape({ type: textValue, at: legacyTimestamp, block: textValue })) })),
  captures: items(shape({ id: nonempty, text: nonempty, at: legacyTimestamp, source: textValue, status: literal('unprocessed', 'resolved', 'archived', 'discarded'), target: textValue })),
  history: items(shape({ id: nonempty, at: legacyTimestamp, date: dateValue, type: nonempty, entity: textValue, before: jsonValue, after: jsonValue })),
  refs: items(legacyProjectShape), goals: items(shape({ id: nonempty, name: nonempty })) });
export function validateLegacyPlanner(raw: unknown, path: string): asserts raw is Planner {
  legacyPlannerShape(raw, path); const p = raw as Planner;
  const ids: Record<string, Set<string>> = {};
  for (const key of ['tasks', 'rules', 'occurrences', 'templates', 'captures', 'history', 'refs', 'goals'] as const) ids[key] = uniqueIds(p[key], `${path}.${key}`);
  if (new Set(p.days.map(d => d.date)).size !== p.days.length) fail(path + '.days', '旧日期重复');
  if (p.refs.filter(r => r.status === 'active').length > 3) fail(path + '.refs', '旧项目超过 WIP 上限');
  for (const [key, objects] of [['tasks', p.tasks], ['rules', p.rules]] as const) objects.forEach((item, i) => {
    for (const target of item.goals) checkRef(target, ids.goals, `${path}.${key}[${i}].goals`);
    for (const target of item.projects) checkRef(target, ids.refs, `${path}.${key}[${i}].projects`);
  });
  p.tasks.forEach((task, i) => {
    if (task.occurrence && !p.occurrences.some(o => o.id === task.occurrence && o.task === task.id)) fail(`${path}.tasks[${i}].occurrence`, '旧例行引用无效');
    if (task.makeupOf) checkRef(task.makeupOf, ids.occurrences, `${path}.tasks[${i}].makeupOf`);
  });
  p.occurrences.forEach((o, i) => { checkRef(o.rule, ids.rules, `${path}.occurrences[${i}].rule`); if (!p.tasks.some(t => t.id === o.task && t.occurrence === o.id)) fail(`${path}.occurrences[${i}].task`, '旧例行任务引用无效'); });
  if (new Set(p.occurrences.map(o => o.rule + '/' + o.date)).size !== p.occurrences.length) fail(path + '.occurrences', '同日旧例行重复');
  const makeups = p.tasks.filter(t => t.makeupOf); if (new Set(makeups.map(t => t.makeupOf)).size !== makeups.length) fail(path + '.tasks', '旧补做来源重复');
  for (const [key, values] of [['templates', p.templates], ['days', p.days]] as const) values.forEach((item, i) => {
    uniqueIds(item.blocks, `${path}.${key}[${i}].blocks`);
    item.blocks.forEach((block, j) => { if (block.end <= block.start) fail(`${path}.${key}[${i}].blocks[${j}]`, '旧区间无效'); if (key === 'days' && block.task) checkRef(block.task, ids.tasks, `${path}.${key}[${i}].blocks[${j}].task`); });
  });
  p.days.forEach((day, i) => {
    if (day.top3.length > 3 || new Set(day.top3).size !== day.top3.length) fail(`${path}.days[${i}].top3`, '旧 Top3 超限或重复');
    day.top3.forEach(id => checkRef(id, ids.tasks, `${path}.days[${i}].top3`));
  });
  p.captures.forEach((c, i) => { if (c.status === 'resolved') checkRef(c.target, ids.tasks, `${path}.captures[${i}].target`); });
}
export function validateLegacyArchive(raw: unknown, path = '$'): void {
  const value = record(raw, path); jsonValue(value, path);
  if (value.version === 2) {
    const days = record(value.days, path + '.days'); array(value.daily, path + '.daily'); array(value.customTemplates, path + '.customTemplates');
    for (const [date, day] of Object.entries(days)) { dateValue(date, path + '.days'); array(record(day, path + '.days.' + date).items, path + '.days.' + date + '.items'); }
  } else { dateValue(value.date, path + '.date'); array(value.enabled, path + '.enabled'); array(value.done, path + '.done'); }
}
export function validateLegacyData(raw: unknown, path = '$'): void {
  inspectLegacyData(raw, path); const d = raw as Omit<Data, 'planner'> & { planner?: Planner };
  validateLegacyConfig(d.config, path + '.config');
  const dictionary: Check = (v, p) => { for (const [key, value] of Object.entries(record(v, p))) shape({ start: clockValue, minutes: numberWithin(1, 1440) })(value, p + '.' + key); };
  shape({ config: legacyConfigShape, legacyArchives: items(shape({ id: nonempty, importedAt: legacyTimestamp, payload: validateLegacyArchive })),
    projects: items(legacyProjectShape), inbox: items(shape({ id: nonempty, text: nonempty, createdAt: legacyTimestamp, status: literal('inbox', 'converted', 'discarded'), targetId: nonempty }, ['targetId'])),
    routines: items(shape({ id: nonempty, title: nonempty, cardId: nonempty, weekdays, enabled: booleanValue })),
    occurrences: items(shape({ id: nonempty, routineId: nonempty, cardId: nonempty, plannedDate: dateValue, status: literal('pending', 'done', 'skipped', 'missed'), completedAt: legacyTimestamp, makeupOf: nonempty }, ['completedAt', 'makeupOf'])),
    days: items(shape({ date: dateValue, top3: items(nonempty), minimumMode: booleanValue, scheduleId: nonempty, overrides: dictionary }, ['top3', 'minimumMode', 'scheduleId', 'overrides'])),
    events: items(shape({ id: nonempty, type: nonempty, entityId: nonempty, at: legacyTimestamp, date: dateValue, details: (v, p) => { record(v, p); jsonValue(v, p); } }, ['details'])),
    planner: validateLegacyPlanner }, ['projects', 'inbox', 'routines', 'occurrences', 'days', 'events', 'planner'])(raw, path);
  for (const name of ['legacyArchives', 'projects', 'inbox', 'routines', 'occurrences', 'events'] as const) if (d[name]) uniqueIds(d[name], `${path}.${name}`);
  const cards = new Set(d.config.cards.map(c => c.id)), rules = new Set((d.routines ?? []).map(r => r.id)), occurrences = new Set((d.occurrences ?? []).map(o => o.id));
  (d.routines ?? []).forEach((r, i) => checkRef(r.cardId, cards, `${path}.routines[${i}].cardId`));
  (d.occurrences ?? []).forEach((o, i) => { checkRef(o.cardId, cards, `${path}.occurrences[${i}].cardId`); checkRef(o.routineId, rules, `${path}.occurrences[${i}].routineId`); if (o.makeupOf) checkRef(o.makeupOf, occurrences, `${path}.occurrences[${i}].makeupOf`); });
  (d.inbox ?? []).forEach((c, i) => { if (c.status === 'converted') checkRef(c.targetId, cards, `${path}.inbox[${i}].targetId`); });
  (d.days ?? []).forEach((day, i) => { if ((day.top3 ?? []).length > 3) fail(`${path}.days[${i}].top3`, '旧 Top3 超限'); (day.top3 ?? []).forEach(id => checkRef(id, cards, `${path}.days[${i}].top3`)); if (day.scheduleId && !d.config.schedules.some(s => s.id === day.scheduleId)) fail(`${path}.days[${i}].scheduleId`, '旧模板引用不存在'); });
}
export function validateLegacyEnvelope(raw: unknown, path = '$'): void {
  inspectLegacyEnvelopeV1(raw, path); validateLegacyConfig((raw as { config: unknown }).config, path + '.config');
}

export function validateWorkspace(raw: unknown): void {
  const inspection = inspectEnvelope(raw);
  if (inspection.kind === 'uninitialized') return;
  const value = raw as EnvelopeV4 | { schemaVersion: number; data: unknown };
  if (value.schemaVersion === 4) {
    const envelope = value as EnvelopeV4;
    if (envelope.mode === 'current') validateActionData(envelope.data);
    else if (envelope.dataFormat === 'envelope-v1') validateLegacyEnvelope(envelope.data);
    else validateLegacyData(envelope.data);
  } else if (value.schemaVersion === 1) validateLegacyEnvelope(raw);
  else validateLegacyData(value.data);
}
export type RestoreTarget = Pick<Extract<EnvelopeV4, { mode: 'current' }>, 'mode' | 'dataFormat' | 'data'> | Pick<Extract<EnvelopeV4, { mode: 'legacy-readonly' }>, 'mode' | 'dataFormat' | 'data'>;
export function parseRestore(text: string): RestoreTarget {
  const inspected = inspectImportText(text), pack = inspected.raw as BackupV2 | BackupV3 | BackupV4 | LegacyBackupV1;
  if (inspected.kind === 'backup-v4') {
    const backup = pack as BackupV4; validateActionData(backup.data);
    return {mode: 'current', dataFormat: 'action-v4', data: structuredClone(backup.data)};
  }
  if (inspected.kind === 'backup-v3') {
    const backup = pack as BackupV3; validateActionData(backup.data);
    return {mode: 'current', dataFormat: 'action-v3', data: structuredClone(backup.data)};
  }
  if (inspected.kind === 'backup-v2') {
    const backup = pack as BackupV2;
    if (backup.dataFormat === 'action-v2') { validateActionData(backup.data); return { mode: 'current', dataFormat: 'action-v2', data: structuredClone(backup.data) }; }
    validateLegacyEnvelope(backup.data); return { mode: 'legacy-readonly', dataFormat: 'envelope-v1', data: structuredClone(backup.data) };
  }
  if (inspected.kind === 'backup-v1') { validateLegacyData(pack.data); return { mode: 'legacy-readonly', dataFormat: inspected.sourceFormat, data: structuredClone(pack.data) as Json }; }
  fail('$.kind', '此文件不是完整工作区备份，请使用定义或旧档案导入');
}
export function exportWorkspace(raw: unknown): BackupV2 | BackupV3 | BackupV4 | LegacyBackupV1 {
  validateWorkspace(raw);
  if (raw === undefined) return {format: 'cardgrid', version: 4, kind: 'backup', dataFormat: 'action-v4', data: emptyWorkspaceData()};
  const envelope = raw as EnvelopeV4 | { schemaVersion: 1; revision: number; config: unknown } | { schemaVersion: 2 | 3; data: Json };
  if (envelope.schemaVersion === 1) return { format: 'cardgrid', version: 2, kind: 'backup', dataFormat: 'envelope-v1', data: structuredClone(raw) as Json };
  if (envelope.schemaVersion !== 4) return { format: 'cardgrid', version: 1, kind: 'backup', data: structuredClone(envelope.data) };
  if (envelope.dataFormat === 'action-v4') return {format: 'cardgrid', version: 4, kind: 'backup', dataFormat: 'action-v4', data: structuredClone(envelope.data)};
  if (envelope.dataFormat === 'action-v3') return {format: 'cardgrid', version: 3, kind: 'backup', dataFormat: 'action-v3', data: structuredClone(envelope.data)};
  if (envelope.dataFormat === 'action-v2') return { format: 'cardgrid', version: 2, kind: 'backup', dataFormat: 'action-v2', data: structuredClone(envelope.data) };
  if (envelope.dataFormat === 'envelope-v1') return { format: 'cardgrid', version: 2, kind: 'backup', dataFormat: 'envelope-v1', data: structuredClone(envelope.data) };
  return { format: 'cardgrid', version: 1, kind: 'backup', data: structuredClone(envelope.data) };
}

/** The same field checks serve form commands and JSON imports, without filling defaults. */
export function validateCommandPayload(command: Command): void {
  const backup = shape({ token: shape({ epoch: nonempty, revision: numberWithin(0, Number.MAX_SAFE_INTEGER) }), dataFingerprint: nonempty, fileSavedConfirmed: literal(true) });
  const acknowledgement = nullable(nonempty);
  const checks: Record<Command['type'], Check> = {
    SaveActionCard: shape({actionCard: (v, p) => {const r = validateWorkshopEntity('actionCards', v); if (!r.ok) fail(p, r.issues.map(i => i.message).join('; '));}, expectedVersion: nullable(versionValue)}),
    SaveBookEntry: shape({bookEntry: bookShape, expectedVersion: nullable(versionValue)}),
    SavePool: shape({pool: (v, p) => {const r = validateWorkshopEntity('pools', v); if (!r.ok) fail(p, r.issues.map(i => i.message).join('; '));}, expectedVersion: nullable(versionValue)}),
    SaveGenerationRule: shape({generationRule: (v, p) => {const r = validateWorkshopEntity('generationRules', v); if (!r.ok) fail(p, r.issues.map(i => i.message).join('; '));}, expectedVersion: nullable(versionValue)}),
    GenerateDailyCopies: shape({target: (v, p) => {if (v !== 'current') shape({ruleId: nonempty, date: dateValue})(v, p);}}),
    ArchiveDueCopies: shape({}),
    AcceptDailyCopy: shape({copy: versionRef, selections: items(slotSelectionShape), composedText: nonempty}),
    SaveSettings: shape({ settings: settingsShape }), CreateCapture: shape({ text: nonempty, source: textValue }), SetCaptureStatus: shape({ capture: versionRef, status: literal('archived', 'discarded') }),
    UpdateDay: shape({ date: dateValue, version: versionValue, minimum: booleanValue, top3: items(instanceRef) }), SaveTemplate: shape({ template: templateShape, expectedVersion: nullable(versionValue) }), SaveRule: shape({ rule: ruleShape, expectedVersion: nullable(versionValue) }), SaveProject: shape({ project: legacyProjectShape }), SaveGoal: shape({ goal: shape({ id: nonempty, name: nonempty }) }),
    SaveDefinition: shape({ id: nullable(nonempty), expectedVersion: nullable(versionValue), content: contentShape, enabled: booleanValue, parentDefinitionId: nullable(nonempty) }), ArchiveDefinition: shape({ definition: versionRef }), AcceptOffer: shape({ definition: versionRef, targetDate: nullable(dateValue) }),
    ResolveCaptureToAction: shape({ capture: versionRef, content: contentShape, targetDate: nullable(dateValue) }), UpdateOpenInstance: shape({ instance: versionRef, content: contentShape, targetDate: nullable(dateValue), placementPreviewId: nullable(nonempty), acknowledgedOverlap: acknowledgement }),
    ReorderHand: shape({ instanceIds: items(nonempty) }), WithdrawInstance: shape({ instance: versionRef }), ReturnWithdrawnToHand: shape({ instance: versionRef }),
    CommitPlacement: shape({ previewId: nonempty, candidateId: nonempty, acknowledgedOverlap: acknowledgement }), RetractPlan: shape({ planId: nonempty, version: versionValue }), CancelFixed: shape({ commitment: versionRef, unlockId: nonempty }),
    ApplyDayTemplate: shape({ previewId: nonempty, acknowledgedOverlap: acknowledgement }), ConfirmActual: shape({ previewId: nonempty, acknowledgedOverlap: acknowledgement }), AppendAnnotation: shape({ factId: nonempty, text: nonempty }),
    PrepareDay: shape({ date: dateValue, zone: zoneValue, templateId: nullable(nonempty) }), CreateMakeup: shape({ occurrence: makeupRef, targetDate: dateValue }),
    ImportDefinitions: shape({ previewId: nonempty, mode: literal('merge', 'replace'), backup }), RestoreWorkspace: shape({ previewId: nonempty, backup, discardDraftsConfirmed: literal(true) }), ClearWorkspace: shape({ backup, discardDraftsConfirmed: literal(true) }), CommitMigration: shape({ previewId: nonempty, backup, discardDraftsConfirmed: literal(true) }),
    SaveJournalEntry: shape({ date: dateValue, zone: zoneValue, text: textValue })
  };
  checks[command.type](command.payload, '$.payload');
}
