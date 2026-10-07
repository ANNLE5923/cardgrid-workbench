/** Portable configuration changes preserve runtime records and creation provenance. */
import type { ConfigV4, DataV5, V06History } from './contracts-v06.ts';
import { canonicalJson, inspectImportText, validateDefinitionConfig } from './format.ts';
import { parseConfigV4, MAX_INPUT_BYTES } from './v5-format.ts';
import { V06ContractError } from './v06-validation.ts';
import { migrateAction, migrateEntry, migrateDeck, legacyDecisionId } from './v5-catalog.ts';
import type { ConfigV3 } from './contracts-v3.ts';
import { dateAt } from '../daily/time.ts';
export function readConfiguration(text: string) {
  if (new TextEncoder().encode(text).length > MAX_INPUT_BYTES)
    throw new V06ContractError('DATA_TOO_LARGE', '$', '配置输入超过 64 MiB');
  const raw = JSON.parse(text);
  if (raw?.format !== 'cardgrid' || raw?.kind !== 'config' || raw?.version !== 3)
    return { pack: parseConfigV4(text), legacyMapping: null };
  // The established parser bounds bytes and validates old references before any mapping.
  const inspected = inspectImportText(text);
  if (inspected.kind !== 'config-v3') throw Error('不是旧 v3 配置');
  const old = inspected.raw as ConfigV3;
  validateDefinitionConfig(old);
  const config = old.config,
    pack: ConfigV4 = {
      format: 'cardgrid',
      version: 4,
      kind: 'config',
      config: {
        settings: config.settings,
        definitions: config.definitions,
        templates: config.templates,
        rules: config.rules,
        generationRules: config.generationRules,
        actionCards: config.actionCards.map(migrateAction),
        catalogEntries: config.bookEntries.map(migrateEntry),
        decks: config.pools.map(migrateDeck),
        decisionCards: config.actionCards.flatMap((action) =>
          action.slots.map((slot) => ({
            id: legacyDecisionId(action.id, slot.id),
            version: action.version,
            question: slot.label,
            ownerActionId: action.id,
            deckIds: [slot.poolId],
            mappings: [{ fieldId: slot.id, entryPath: 'title' }],
            status: action.status,
            source: action.source,
          })),
        ),
      },
    };
  parseConfigV4(JSON.stringify(pack));
  return {
    pack,
    legacyMapping: {
      sourceVersion: 3 as const,
      decisions: pack.config.decisionCards.map((d) => ({
        id: d.id,
        question: d.question,
        ownerActionId: d.ownerActionId,
      })),
      fields: pack.config.actionCards.map((a) => ({ actionId: a.id, fields: a.fields })),
    },
  };
}
export function exportConfigV4(data: DataV5): ConfigV4 {
  const manual = <T extends { source: unknown }>(items: readonly T[]) =>
    items.map((i) => ({ ...structuredClone(i), source: { kind: 'manual' as const } }));
  return {
    format: 'cardgrid',
    version: 4,
    kind: 'config',
    config: {
      settings: structuredClone(data.settings),
      definitions: manual(data.planner.definitions),
      templates: manual(data.planner.templates),
      rules: manual(data.planner.rules),
      generationRules: manual(data.generationRules),
      actionCards: manual(data.actionCards),
      catalogEntries: manual(data.catalogEntries),
      decks: manual(data.decks),
      decisionCards: manual(data.decisionCards),
    },
  };
}
export function applyPlannerConfig(
  data: DataV5,
  config: ConfigV4['config'],
  mode: 'merge' | 'replace',
  commandId: string,
  at: string,
): DataV5 {
  const next = structuredClone(data) as any,
    history: V06History[] = [];
  const log = (kind: any, id: string, before: any, after: any) =>
    history.push({
      id: `${commandId}:config:${history.length}`,
      commandId,
      type: 'ImportCatalogV4',
      at,
      date: dateAt(at, data.settings.zone ?? 'UTC'),
      entity: { kind, id },
      before,
      after,
    });
  const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
  if (!equal(data.settings, config.settings)) {
    next.settings = structuredClone(config.settings);
    log('settings', 'workspace', data.settings, next.settings);
  }
  for (const [key, kind] of [
    ['definitions', 'definition'],
    ['templates', 'template'],
    ['rules', 'rule'],
    ['generationRules', 'generation-rule'],
  ] as const) {
    const old: any[] =
      key === 'generationRules' ? [...data.generationRules] : [...data.planner[key]];
    const incoming: any[] = config[key] as any;
    const result = old.map((value) => {
      if (mode !== 'replace' || incoming.some((i) => i.id === value.id)) return value;
      const retired =
        key === 'definitions'
          ? { ...value, enabled: false }
          : key === 'templates'
            ? { ...value, weekdays: [] }
            : { ...value, status: 'archived' };
      if (equal(value, retired)) return value;
      const after = { ...retired, version: value.version + 1 };
      log(kind, value.id, value, after);
      return after;
    });
    for (const item of incoming) {
      const index = result.findIndex((i) => i.id === item.id),
        previous = result[index];
      const value = {
        ...structuredClone(item),
        version: previous?.version ?? 1,
        source: previous?.source ?? { kind: 'manual' },
      };
      if (previous && equal(previous, value)) continue;
      const after = { ...value, version: previous ? previous.version + 1 : 1 };
      if (index < 0) result.push(after);
      else result[index] = after;
      log(kind, item.id, previous ?? null, after);
    }
    if (key === 'generationRules') next[key] = result;
    else next.planner[key] = result;
  }
  next.planner.history.push(...history);
  return next;
}
