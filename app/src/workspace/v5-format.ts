/** B4 strict format boundary. Legacy records are validated by their original v4 validator. */
import type { DataV4 } from './contracts-v4.ts';
import type {
  BackupV5,
  CatalogV06,
  ConfigV4,
  DataV5,
  HandCard,
  V06EntityRef,
  V06History,
} from './contracts-v06.ts';
import {
  canonicalJson,
  emptyWorkspaceData,
  fingerprint,
  MAX_BACKUP_BYTES,
  MAX_INPUT_BYTES,
  parseRestore,
  validateActionData,
  validateDefinitionConfig,
  validateSourceFingerprints,
  WorkspaceFormatError,
} from './format.ts';
import { validateV06Dto, V06ContractError } from './v06-validation.ts';
import { validateCatalogV06, validateWorkshopEntity } from '../workshop/model.ts';
import {
  dayRange,
  nextDate,
  dateAt,
  weekday,
  compareInstants,
  assertDate,
  assertInstant,
  assertZone,
  resolveLocal,
} from '../daily/time.ts';
import { renderActionContent, createAnswerMaterial } from '../decision/model.ts';
import { legacyDecisionId, migrateAction, migrateEntry, migrateDeck } from './v5-catalog.ts';
import { archivedEntityKeys } from './archive-ledger.ts';

export const v5CatalogKeys = ['actionCards', 'catalogEntries', 'decks', 'decisionCards'] as const;
export const v5Kinds = {
  actionCards: 'action-card',
  catalogEntries: 'catalog-entry',
  decks: 'deck',
  decisionCards: 'decision-card',
} as const;
const legacyKinds = {
  actionCards: 'action-card',
  bookEntries: 'book-entry',
  pools: 'pool',
  generationRules: 'generation-rule',
} as const;
export function formatNeed(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) throw new WorkspaceFormatError(path, message);
}
export function exactRecord(
  value: unknown,
  fields: readonly string[],
  path = '$',
): asserts value is Record<string, any> {
  formatNeed(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    path,
    'expected JSON object',
  );
  formatNeed(
    Object.keys(value).sort().join(',') === [...fields].sort().join(','),
    path,
    'missing or unknown fields',
  );
}
const nonempty = (v: unknown, p: string) =>
  formatNeed(typeof v === 'string' && !!v.trim(), p, 'expected nonempty string');
const version = (v: unknown, p: string) =>
  formatNeed(Number.isSafeInteger(v) && (v as number) > 0, p, 'expected positive version');
const array = (v: unknown, p: string): readonly any[] => {
  formatNeed(Array.isArray(v), p, 'expected array');
  for (let i = 0; i < v.length; i++) formatNeed(Object.hasOwn(v, i), p, 'array hole');
  return v;
};
function unique(items: readonly { id: string }[], p: string) {
  const ids = new Set<string>();
  for (const item of items) {
    formatNeed(item !== null && typeof item === 'object', p, 'expected record');
    nonempty(item.id, p);
    formatNeed(!ids.has(item.id), p, 'duplicate ID');
    ids.add(item.id);
  }
}
function ref(v: unknown, p: string) {
  exactRecord(v, ['id', 'version'], p);
  nonempty(v.id, p);
  version(v.version, p);
}
const jsonEqual = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export function catalogOf(data: CatalogV06): CatalogV06 {
  return Object.fromEntries(v5CatalogKeys.map((k) => [k, data[k]])) as CatalogV06;
}

/** An oversized migrated deck is legal only with its unchanged migration snapshot. */
export function validateV5Catalog(
  catalog: CatalogV06,
  history: readonly V06History[] = [],
  allowGrandfather = false,
): void {
  for (const key of v5CatalogKeys) {
    array(catalog[key], key);
    unique(catalog[key], key);
    for (const item of catalog[key]) {
      if (key === 'decks' && (item as any).memberIds?.length > 100) {
        formatNeed(
          allowGrandfather &&
            history.some(
              (h) =>
                h.type === 'MigrateCatalogV5' &&
                h.entity.kind === 'deck' &&
                jsonEqual(h.after, item),
            ),
          key,
          'oversized deck must retain its exact migration snapshot',
        );
        validateV06Dto('deck', { ...item, memberIds: [] });
      } else
        validateV06Dto(
          key === 'actionCards'
            ? 'action'
            : key === 'catalogEntries'
              ? 'entry'
              : key === 'decks'
                ? 'deck'
                : 'decision',
          item,
        );
    }
  }
  const checked = validateCatalogV06(catalog);
  const issues = checked.issues.filter(
    (i) => !(allowGrandfather && i.code === 'CAPACITY_EXCEEDED'),
  );
  formatNeed(!issues.length, '$.catalog', issues.map((i) => `${i.path}: ${i.message}`).join('; '));
  for (const action of catalog.actionCards) {
    unique(action.fields, 'fields');
    formatNeed(
      new Set(action.fields.map((f) => f.label)).size === action.fields.length,
      'fields',
      'ambiguous field label',
    );
    const seen = new Set([action.id]);
    let parent = action.parentId;
    while (parent !== null) {
      const next = catalog.actionCards.find((c) => c.id === parent);
      formatNeed(next && !seen.has(parent), 'parentId', 'missing parent or cycle');
      seen.add(parent);
      parent = next.parentId;
    }
  }
}

/** Old catalog heads come from unchanged append-only old histories, never guessed from new fields. */
export function legacyValidationView(data: DataV5): DataV4 {
  const old = emptyWorkspaceData();
  const archived = archivedEntityKeys(data),
    isArchived = (ref: any) => 'id' in ref && archived.has(JSON.stringify([ref.kind, ref.id]));
  const oldCopies = new Set([
    ...data.dailyCopies.filter((c) => !('format' in c)).map((c) => c.id),
    ...data.archiveLogs.filter((c) => !('format' in c)).map((c) => c.copyId),
  ]);
  const oldHistory = data.planner.history.filter(
    (h) =>
      !(h.entity.kind === 'daily-copy' && 'id' in h.entity && !oldCopies.has(h.entity.id)) &&
      !(h.entity.kind === 'archive-log' && (h.after as any)?.format === 'v5') &&
      ![
        'catalog-entry',
        'deck',
        'decision-card',
        'hand-card',
        'reference-placement',
        'journal-note',
        'archive',
      ].includes(h.entity.kind) &&
      !(
        h.entity.kind === 'action-card' &&
        ((h.after as any)?.fields !== undefined || h.type === 'MigrateCatalogV5')
      ),
  );
  for (const [key, kind] of Object.entries(legacyKinds) as [keyof typeof legacyKinds, string][]) {
    const heads = new Map<string, any>();
    for (const h of oldHistory)
      if (h.entity.kind === kind && 'id' in h.entity) heads.set(h.entity.id, h.after);
    (old as any)[key] = [...heads.values()];
  }
  const legacyRuleIds = new Set(
    data.generationRules
      .filter((r) => old.actionCards.some((a) => a.id === r.actionCardId))
      .map((r) => r.id),
  );
  return {
    ...old,
    settings: data.settings,
    planner: {
      ...data.planner,
      history: oldHistory.filter(
        (h) =>
          h.entity.kind !== 'generation-rule' ||
          ('id' in h.entity && legacyRuleIds.has(h.entity.id)),
      ) as DataV4['planner']['history'],
    },
    legacySources: data.legacySources,
    migrationBindings: data.migrationBindings,
    journalEntries: data.journalEntries,
    generationRules: data.generationRules.filter((r) => legacyRuleIds.has(r.id)),
    dailyCopies: data.dailyCopies.filter((c) => 'slotSpecSnapshot' in c),
    archiveLogs: data.archiveLogs.filter((c) => 'slotSelectionsSnapshot' in c),
    generationLedger: data.generationLedger.filter(
      (l) =>
        data.dailyCopies.some((c) => c.id === l.copyId && !('format' in c)) ||
        data.archiveLogs.some((c) => c.copyId === l.copyId && !('format' in c)),
    ),
    commandReceipts: data.commandReceipts.filter(
      (r) =>
        !r.resultRefs.some(isArchived) &&
        !r.resultRefs.some(
          (ref) =>
            (ref.kind === 'daily-copy' && 'id' in ref && !oldCopies.has(ref.id)) ||
            (ref.kind === 'archive-log' &&
              'id' in ref &&
              !data.archiveLogs.some((a) => a.id === ref.id && !('format' in a))),
        ) &&
        r.type !== 'SaveActionCardV5' &&
        !r.resultRefs.some((ref) =>
          [
            'catalog-entry',
            'deck',
            'decision-card',
            'hand-card',
            'reference-placement',
            'journal-note',
            'archive',
          ].includes(ref.kind),
        ),
    ) as DataV4['commandReceipts'],
  };
}

export function validateHandCard(card: HandCard): void {
  const base = [
    'id',
    'version',
    'kind',
    'state',
    'createdAt',
    'provenance',
    'inputIds',
    'expiresAt',
    'consumedBy',
  ];
  exactRecord(card, [
    ...base,
    ...(card.kind === 'action' || card.kind === 'composite'
      ? ['actionInstanceId', 'ownerAction', 'contentSnapshot', 'fieldSpecs', 'fieldValues']
      : card.kind === 'answer'
        ? ['answer']
        : ['entrySnapshot']),
  ]);
  nonempty(card.id, 'id');
  version(card.version, 'version');
  assertInstant(card.createdAt);
  formatNeed(
    ['action', 'composite', 'answer', 'entry'].includes(card.kind),
    'kind',
    'unknown material',
  );
  formatNeed(
    ['available', 'consumed', 'expired', 'withdrawn'].includes(card.state),
    'state',
    'unknown state',
  );
  formatNeed(
    (card.state === 'consumed') === (card.consumedBy !== null),
    'consumedBy',
    'consumption state mismatch',
  );
  if (card.consumedBy !== null) nonempty(card.consumedBy, 'consumedBy');
  if (card.expiresAt !== null) {
    assertInstant(card.expiresAt);
    formatNeed(
      compareInstants(card.createdAt, card.expiresAt) < 0,
      'expiresAt',
      'material born expired',
    );
  }
  const inputIds = array(card.inputIds, 'inputIds');
  inputIds.forEach((i) => nonempty(i, 'inputIds'));
  formatNeed(new Set(inputIds).size === inputIds.length, 'inputIds', 'duplicate input');
  for (const origin of array(card.provenance, 'provenance')) {
    if (origin.kind === 'manual') {
      exactRecord(origin, ['kind', 'source']);
      ref(origin.source, 'source');
    } else if (origin.kind === 'answer') {
      exactRecord(origin, ['kind', 'snapshot']);
      validateV06Dto('answer', origin.snapshot);
    } else {
      exactRecord(origin, ['kind', 'copy', 'sourceDate', 'zone', 'expiresAt']);
      formatNeed(origin.kind === 'daily-copy', 'kind', 'unknown provenance');
      ref(origin.copy, 'copy');
      assertDate(origin.sourceDate);
      assertZone(origin.zone);
      assertInstant(origin.expiresAt);
    }
  }
  formatNeed(card.provenance.length > 0, 'provenance', 'missing material source');
  if (card.kind === 'action' || card.kind === 'composite') {
    if (card.actionInstanceId !== null) nonempty(card.actionInstanceId, 'actionInstanceId');
    ref(card.ownerAction, 'ownerAction');
    validateV06Dto('action', {
      ...card.ownerAction,
      kind: 'action',
      content: card.contentSnapshot,
      fields: card.fieldSpecs,
      status: 'active',
      parentId: null,
      source: { kind: 'manual' },
    });
    const values = array(card.fieldValues, 'fieldValues');
    values.forEach((v) => exactRecord(v, ['fieldId', 'value']));
    // Shared renderer validates flat scalars, field IDs and field types.
    renderActionContent(card.contentSnapshot, card.fieldSpecs, card.fieldValues);
  } else if (card.kind === 'answer') validateV06Dto('answer', card.answer);
  else validateV06Dto('entry', card.entrySnapshot);
}

export function validateDataV5(raw: unknown): asserts raw is DataV5 {
  canonicalJson(raw); // Reject undefined, nonfinite values and non-JSON extensions.
  exactRecord(raw, [
    'version',
    'workspaceId',
    'settings',
    'planner',
    'legacySources',
    'migrationBindings',
    'commandReceipts',
    ...v5CatalogKeys,
    'generationRules',
    'dailyCopies',
    'archiveLogs',
    'generationLedger',
    'journalEntries',
    'handCards',
    'referencePlacements',
    'factReferenceSnapshots',
    'journalNotes',
    'catalogAliases',
    'archiveIndex',
  ]);
  const data = raw as unknown as DataV5;
  formatNeed(data.version === 5, 'version', 'expected Data v5');
  nonempty(data.workspaceId, 'workspaceId');
  for (const key of [
    'legacySources',
    'migrationBindings',
    'journalEntries',
    'generationRules',
    'handCards',
    'referencePlacements',
    'journalNotes',
    'catalogAliases',
    'archiveIndex',
    'factReferenceSnapshots',
    'dailyCopies',
    'archiveLogs',
    'generationLedger',
    'commandReceipts',
  ] as const)
    array(data[key], key);
  exactRecord(data.planner, Object.keys(emptyWorkspaceData().planner), '$.planner');
  const archived = archivedEntityKeys(data);
  for (const [key, value] of Object.entries(data.planner))
    if (key !== 'version') array(value, `$.planner.${key}`);
  for (const h of data.planner.history) {
    exactRecord(h, ['id', 'commandId', 'at', 'date', 'type', 'entity', 'before', 'after']);
    formatNeed(
      h.entity !== null && typeof h.entity === 'object' && typeof h.entity.kind === 'string',
      'history.entity',
      'expected entity reference',
    );
  }
  validateV5Catalog(data, data.planner.history, true);
  unique(data.generationRules, 'generationRules');
  for (const rule of data.generationRules) {
    formatNeed(
      validateWorkshopEntity('generationRules', rule).ok &&
        data.actionCards.some((a) => a.id === rule.actionCardId),
      'generationRules',
      'invalid rule or owner',
    );
  }
  validateActionData(legacyValidationView(data));
  unique(data.handCards, 'handCards');
  data.handCards.forEach(validateHandCard);
  unique(data.referencePlacements, 'referencePlacements');
  unique(data.journalNotes, 'journalNotes');
  for (const note of data.journalNotes) {
    validateV06Dto('note', note);
    formatNeed(
      note.recordedAt === note.createdAt && compareInstants(note.updatedAt, note.createdAt) >= 0,
      'note',
      'invalid timestamps',
    );
  }
  const collections: Record<string, readonly { id: string }[]> = {
    'hand-card': data.handCards,
    'reference-placement': data.referencePlacements,
    'journal-note': data.journalNotes,
    'catalog-entry': data.catalogEntries,
    deck: data.decks,
    'decision-card': data.decisionCards,
    'action-card': data.actionCards,
    archive: data.archiveIndex.map((x) => ({ id: x.archiveId })),
  };
  const allHistory = data.planner.history;
  unique(allHistory, 'history');
  const receipts = new Set<string>();
  const entityKey = (kind: string, id: string) => JSON.stringify([kind, id]);
  const histories = new Map<string, V06History[]>(),
    sources = new Map<string, any>(),
    originals = new Set<string>();
  for (const h of allHistory)
    if ('id' in h.entity) {
      const key = entityKey(h.entity.kind, h.entity.id),
        logs = histories.get(key) ?? [];
      logs.push(h);
      histories.set(key, logs);
      const after = h.after as any;
      if (
        v5CatalogKeys.some((k) => v5Kinds[k] === h.entity.kind) &&
        after?.version &&
        (h.entity.kind !== 'action-card' || after.fields !== undefined)
      )
        sources.set(JSON.stringify([h.entity.kind, h.entity.id, after.version]), after);
      if (
        h.entity.kind === 'book-entry' ||
        h.entity.kind === 'pool' ||
        (h.entity.kind === 'action-card' && after?.slots !== undefined)
      )
        originals.add(JSON.stringify([h.entity.kind, canonicalJson(h.after)]));
    }
  for (const h of allHistory) {
    exactRecord(h, ['id', 'commandId', 'at', 'date', 'type', 'entity', 'before', 'after']);
    nonempty(h.id, 'history.id');
    nonempty(h.commandId, 'commandId');
    nonempty(h.type, 'type');
    assertInstant(h.at);
    assertDate(h.date);
    if (Object.hasOwn(collections, h.entity.kind)) {
      exactRecord(h.entity, ['kind', 'id']);
      formatNeed(
        collections[h.entity.kind].some((e) => e.id === ('id' in h.entity ? h.entity.id : '')),
        'history.entity',
        'dangling entity',
      );
    }
  }
  // Every new catalog head has a continuous, source-preserving history chain.
  for (const key of v5CatalogKeys)
    for (const item of data[key]) {
      const logs = (histories.get(entityKey(v5Kinds[key], item.id)) ?? []).filter(
        (h) => key !== 'actionCards' || (h.after as any)?.fields !== undefined,
      );
      let head: any = null;
      for (const log of logs) {
        const next = log.after as any;
        if (log.type === 'MigrateCatalogV5') {
          const previous = log.before as any,
            oldKind =
              key === 'catalogEntries' ? 'book-entry' : key === 'decks' ? 'pool' : 'action-card';
          formatNeed(
            originals.has(JSON.stringify([oldKind, canonicalJson(previous)])),
            'history',
            'missing original migration source',
          );
          const converted =
            key === 'actionCards'
              ? migrateAction(previous)
              : key === 'catalogEntries'
                ? migrateEntry(previous)
                : key === 'decks'
                  ? migrateDeck(previous)
                  : previous.slots
                      .map((s: any) => ({
                        id: legacyDecisionId(previous.id, s.id),
                        version: previous.version,
                        question: s.label,
                        ownerActionId: previous.id,
                        deckIds: [s.poolId],
                        mappings: [{ fieldId: s.id, entryPath: 'title' }],
                        status: previous.status,
                        source: previous.source,
                      }))
                      .find((d: any) => d.id === next.id);
          formatNeed(
            converted && jsonEqual(converted, next),
            'history',
            'migration snapshot changed original content',
          );
          formatNeed(
            next.version === previous.version &&
              (head === null || next.version === head.version + 1),
            'history',
            'invalid migration seed',
          );
        } else
          formatNeed(
            head === null
              ? log.before === null && next.version === 1
              : jsonEqual(log.before, head) &&
                  next.version === head.version + 1 &&
                  jsonEqual(next.source, head.source),
            'history',
            'broken catalog version chain',
          );
        head = next;
      }
      formatNeed(head && jsonEqual(head, item), 'history', 'missing catalog head');
    }
  for (const r of data.commandReceipts) {
    exactRecord(r, ['commandId', 'type', 'payloadFingerprint', 'resultRefs']);
    nonempty(r.commandId, 'commandId');
    nonempty(r.type, 'type');
    nonempty(r.payloadFingerprint, 'payloadFingerprint');
    array(r.resultRefs, 'resultRefs');
    formatNeed(!receipts.has(r.commandId), 'commandReceipts', 'duplicate command');
    receipts.add(r.commandId);
    for (const entity of r.resultRefs) {
      formatNeed(
        entity &&
          typeof entity === 'object' &&
          [
            'legacy',
            'definition',
            'instance',
            'plan',
            'fact',
            'annotation',
            'fixed',
            'template',
            'rule',
            'occurrence',
            'capture',
            'project',
            'goal',
            'day',
            'settings',
            'action-card',
            'book-entry',
            'pool',
            'generation-rule',
            'daily-copy',
            'archive-log',
            'journal-entry',
            ...Object.keys(collections),
          ].includes(entity.kind),
        'resultRefs',
        'unknown entity kind',
      );
      if (entity.kind !== 'legacy') {
        exactRecord(entity, ['kind', 'id']);
        nonempty(entity.id, 'resultRefs.id');
      }
      if (Object.hasOwn(collections, entity.kind))
        formatNeed(
          collections[entity.kind].some((e) => e.id === ('id' in entity ? entity.id : '')) ||
            ('id' in entity && archived.has(JSON.stringify([entity.kind, entity.id]))),
          'resultRefs',
          'dangling entity',
        );
    }
  }
  const frozen = (kind: string, id: string, ver: number) =>
    sources.get(JSON.stringify([kind, id, ver]));
  const receiptById = new Map(data.commandReceipts.map((r) => [r.commandId, r]));
  const verifyAnswer = (a: any) => {
    createAnswerMaterial({ id: 'format-answer-check', at: a.selectedAt, answer: a });
    const d = frozen('decision-card', a.decision.id, a.decision.version),
      owner = frozen('action-card', a.ownerAction.id, a.ownerAction.version),
      entry = frozen('catalog-entry', a.entry.id, a.entry.version);
    formatNeed(
      d &&
        owner &&
        entry &&
        d.status === 'active' &&
        owner.status === 'active' &&
        entry.status === 'active' &&
        d.ownerActionId === owner.id &&
        d.question === a.question &&
        jsonEqual(d.mappings, a.mappings) &&
        jsonEqual(entry, a.entry),
      'answer',
      'forged source snapshot',
    );
    for (const source of a.sourceDecks) {
      const deck = frozen('deck', source.id, source.version);
      formatNeed(
        deck &&
          d.deckIds.includes(deck.id) &&
          deck.deckKind === 'entry' &&
          deck.memberIds.includes(a.entry.id),
        'answer.sourceDecks',
        'invalid candidate source',
      );
    }
    formatNeed(a.sourceDecks.length > 0, 'answer.sourceDecks', 'missing candidate deck');
    renderActionContent(owner.content, owner.fields, a.fieldValues);
  };
  // Durable entity heads must agree with the append-only histories and committed receipts.
  for (const [kind, records] of [
    ['hand-card', data.handCards],
    ['reference-placement', data.referencePlacements],
    ['journal-note', data.journalNotes],
  ] as const)
    for (const item of records) {
      const logs = (histories.get(entityKey(kind, item.id)) ?? []).filter(
        (h) => h.type !== 'ReorderUnifiedHand',
      );
      let head: any = null;
      for (const log of logs) {
        const after = log.after as any;
        formatNeed(after && after.id === item.id, 'history', 'invalid entity snapshot');
        formatNeed(
          head === null
            ? log.before === null && after.version === 1
            : jsonEqual(log.before, head) && after.version === head.version + 1,
          'history',
          'broken entity version chain',
        );
        if (head) {
          const mutable =
            kind === 'hand-card'
              ? ['version', 'state', 'consumedBy']
              : kind === 'reference-placement'
                ? ['version', 'state', 'changedAt']
                : ['version', 'text', 'updatedAt'];
          const stable = (v: any) =>
            Object.fromEntries(Object.entries(v).filter(([key]) => !mutable.includes(key)));
          formatNeed(
            jsonEqual(stable(head), stable(after)),
            'history',
            'immutable creation metadata changed',
          );
        }
        if (!log.type.startsWith('Migrate')) {
          const receipt = receiptById.get(log.commandId);
          formatNeed(
            receipt &&
              receipt.type === log.type &&
              receipt.resultRefs.some(
                (ref) => ref.kind === kind && 'id' in ref && ref.id === item.id,
              ),
            'history',
            'missing committed receipt',
          );
        }
        head = after;
      }
      formatNeed(head && jsonEqual(head, item), 'history', 'missing entity head');
    }
  for (const card of data.handCards) {
    const deadlines = [
      ...card.provenance.flatMap((p) => (p.kind === 'daily-copy' ? [p.expiresAt] : [])),
      ...card.inputIds.flatMap((id) => {
        const c = data.handCards.find((c) => c.id === id);
        return c?.expiresAt ? [c.expiresAt] : [];
      }),
    ].sort((a, b) => compareInstants(a, b));
    formatNeed(
      card.expiresAt === (deadlines[0] ?? null),
      'expiresAt',
      'material expiry must follow its earliest source',
    );
    for (const id of card.inputIds)
      formatNeed(
        data.handCards.some(
          (c) => c.id === id && c.state === 'consumed' && c.consumedBy === card.id,
        ),
        'inputIds',
        'missing consumed input',
      );
    if (card.consumedBy !== null)
      formatNeed(
        data.handCards.some((c) => c.id === card.consumedBy && c.inputIds.includes(card.id)),
        'consumedBy',
        'missing output lineage',
      );
    if (card.kind === 'action' || card.kind === 'composite') {
      if (card.actionInstanceId !== null) {
        const instance = data.planner.instances.find((i) => i.id === card.actionInstanceId);
        formatNeed(instance, 'actionInstanceId', 'missing instance');
        formatNeed(
          card.state !== 'consumed' || instance.state === 'withdrawn',
          'actionInstanceId',
          'consumed instance must be retired',
        );
      }
      const original = frozen('action-card', card.ownerAction.id, card.ownerAction.version);
      formatNeed(original, 'ownerAction', 'missing frozen action version');
      formatNeed(
        jsonEqual((original as any).fields, card.fieldSpecs),
        'fieldSpecs',
        'frozen fields mismatch',
      );
      const rendered =
        card.kind === 'action'
          ? (original as any).content
          : renderActionContent((original as any).content, card.fieldSpecs, card.fieldValues)
              .content;
      formatNeed(
        jsonEqual(rendered, card.contentSnapshot),
        'contentSnapshot',
        'frozen rendered content mismatch',
      );
    }
    if (card.kind === 'answer') verifyAnswer(card.answer);
    if (card.kind === 'entry')
      formatNeed(
        jsonEqual(
          frozen('catalog-entry', card.entrySnapshot.id, card.entrySnapshot.version),
          card.entrySnapshot,
        ),
        'entrySnapshot',
        'forged entry',
      );
    for (const p of card.provenance) if (p.kind === 'answer') verifyAnswer(p.snapshot);
  }
  const activeAnswers = new Set<string>();
  for (const placement of data.referencePlacements) {
    exactRecord(placement, [
      'id',
      'version',
      'answerId',
      'createdAt',
      'changedAt',
      'state',
      'mode',
      ...(placement.mode === 'point' ? ['point'] : ['targetInstanceId']),
    ]);
    version(placement.version, 'version');
    assertInstant(placement.createdAt);
    assertInstant(placement.changedAt);
    formatNeed(
      compareInstants(placement.changedAt, placement.createdAt) >= 0,
      'changedAt',
      'time moved backwards',
    );
    formatNeed(
      ['active', 'returned', 'expired'].includes(placement.state),
      'state',
      'unknown reference state',
    );
    const material = data.handCards.find((c) => c.id === placement.answerId);
    formatNeed(material?.kind === 'answer', 'answerId', 'reference requires frozen answer');
    if (placement.mode === 'point') {
      exactRecord(placement.point, ['at', 'zone', 'localTime', 'offset']);
      const point = placement.point;
      formatNeed(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(point.localTime),
        'point',
        'invalid local point',
      );
      const resolved = resolveLocal({
        date: point.localTime.slice(0, 10),
        time: point.localTime.slice(11),
        zone: point.zone,
        offset: point.offset,
      });
      formatNeed(
        compareInstants(resolved.instant, point.at) === 0 &&
          Number(point.localTime.slice(-2)) % 5 === 0,
        'point',
        'invalid grid or offset',
      );
    } else {
      const owner = data.handCards.find(
        (c) =>
          (c.kind === 'action' || c.kind === 'composite') &&
          c.actionInstanceId === placement.targetInstanceId,
      );
      formatNeed(
        owner &&
          (owner.kind === 'action' || owner.kind === 'composite') &&
          material.kind === 'answer' &&
          jsonEqual(owner.ownerAction, material.answer.ownerAction),
        'reference',
        'attached answer owner mismatch',
      );
      formatNeed(placement.mode === 'attached', 'mode', 'unknown mode');
      formatNeed(
        data.planner.instances.some((i) => i.id === placement.targetInstanceId),
        'targetInstanceId',
        'missing target',
      );
    }
    if (placement.state === 'active') {
      formatNeed(
        material.state === 'available' && !activeAnswers.has(placement.answerId),
        'reference',
        'duplicate or unusable reference',
      );
      activeAnswers.add(placement.answerId);
      formatNeed(
        placement.mode === 'point' ||
          data.planner.plans.some(
            (p) => p.instanceId === placement.targetInstanceId && p.status === 'active',
          ) ||
          data.planner.facts.some((f) => f.instanceId === placement.targetInstanceId),
        'reference',
        'attached reference lost target',
      );
    }
  }
  const factIds = new Set<string>();
  for (const s of data.factReferenceSnapshots) {
    exactRecord(s, ['factId', 'answers']);
    formatNeed(
      !factIds.has(s.factId) && data.planner.facts.some((f) => f.id === s.factId),
      'factId',
      'invalid fact reference',
    );
    factIds.add(s.factId);
    array(s.answers, 'answers').forEach((a) => {
      validateV06Dto('answer', a);
      verifyAnswer(a);
    });
  }
  for (const fact of data.planner.facts) {
    const index = data.planner.history.findIndex(
      (h) =>
        h.entity.kind === 'fact' &&
        'id' in h.entity &&
        h.entity.id === fact.id &&
        (h.after as any)?.id === fact.id,
    );
    const heads = new Map<string, any>();
    for (const h of data.planner.history.slice(0, index < 0 ? 0 : index))
      if (h.entity.kind === 'reference-placement' && 'id' in h.entity)
        heads.set(h.entity.id, h.after);
    const expected = [...heads.values()]
      .filter(
        (r) =>
          r.state === 'active' && r.mode === 'attached' && r.targetInstanceId === fact.instanceId,
      )
      .map((r) => {
        const a = data.handCards.find((c) => c.id === r.answerId);
        formatNeed(a?.kind === 'answer', 'factReferences', 'missing answer');
        return a.answer;
      });
    const saved = data.factReferenceSnapshots.find((s) => s.factId === fact.id);
    formatNeed(
      jsonEqual(saved?.answers ?? [], expected),
      'factReferences',
      'fact references must equal the original confirmation sources',
    );
  }
  const aliases = new Set<string>();
  for (const a of data.catalogAliases) {
    exactRecord(a, ['sourceKind', 'sourceId', 'targetKind', 'targetId']);
    formatNeed(
      ['book-entry', 'pool', 'action-card', 'slot'].includes(a.sourceKind) &&
        ['catalog-entry', 'deck', 'action-card', 'decision-card'].includes(a.targetKind),
      'catalogAliases',
      'invalid kind',
    );
    nonempty(a.sourceId, 'sourceId');
    nonempty(a.targetId, 'targetId');
    const k = JSON.stringify([a.sourceKind, a.sourceId]);
    formatNeed(!aliases.has(k), 'catalogAliases', 'ambiguous alias');
    aliases.add(k);
    formatNeed(
      collections[a.targetKind]?.some((e) => e.id === a.targetId),
      'catalogAliases',
      'missing target',
    );
  }
  // New-copy runtime and archive closure validation belong to B7/B11, not a permissive package parser.
  validateGenericDaily(data, frozen, receiptById);
  for (const [kind, items] of Object.entries(collections))
    for (const item of items)
      formatNeed(
        !archived.has(JSON.stringify([kind, item.id])),
        'archiveIndex',
        'archived ID must not remain executable',
      );
}

export function backupV5(data: DataV5): BackupV5 {
  return {
    format: 'cardgrid',
    version: 5,
    kind: 'backup',
    dataFormat: 'action-v5',
    coverage: 'active-plus-archives',
    requiredArchives: data.archiveIndex.map(
      ({ archiveId, workspaceId, manifestSha256, recordsSha256 }) => ({
        archiveId,
        workspaceId,
        manifestSha256,
        recordsSha256,
      }),
    ),
    data: structuredClone(data),
  };
}
export function activeBytes(data: DataV5): number {
  return new TextEncoder().encode(JSON.stringify(backupV5(data))).length;
}
export function assertActiveCapacity(data: DataV5) {
  if (activeBytes(data) > MAX_BACKUP_BYTES)
    throw new V06ContractError(
      'DATA_TOO_LARGE',
      '$.bytes',
      `active backup exceeds ${MAX_BACKUP_BYTES} bytes`,
    );
}
function parseJSON(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkspaceFormatError('$', 'invalid JSON');
  }
}
export function parseV06Restore(text: string) {
  formatNeed(
    new TextEncoder().encode(text).length <= MAX_INPUT_BYTES,
    '$.bytes',
    `input exceeds ${MAX_INPUT_BYTES} bytes`,
  );
  const raw = parseJSON(text);
  if (raw?.format === 'cardgrid' && raw.version === 5 && raw.kind === 'backup') {
    exactRecord(raw, [
      'format',
      'version',
      'kind',
      'dataFormat',
      'coverage',
      'requiredArchives',
      'data',
    ]);
    formatNeed(
      raw.dataFormat === 'action-v5' && raw.coverage === 'active-plus-archives',
      'dataFormat',
      'invalid v5 tag',
    );
    validateDataV5(raw.data);
    formatNeed(
      jsonEqual(raw.requiredArchives, backupV5(raw.data).requiredArchives),
      'requiredArchives',
      'coverage mismatch',
    );
    return {
      mode: 'current' as const,
      dataFormat: 'action-v5' as const,
      data: structuredClone(raw.data) as DataV5,
    };
  }
  return parseRestore(text);
}
export function parseConfigV4(text: string): ConfigV4 {
  formatNeed(
    new TextEncoder().encode(text).length <= MAX_INPUT_BYTES,
    '$.bytes',
    'config input too large',
  );
  const raw = parseJSON(text);
  exactRecord(raw, ['format', 'version', 'kind', 'config']);
  formatNeed(
    raw.format === 'cardgrid' && raw.version === 4 && raw.kind === 'config',
    'format',
    'expected config v4',
  );
  exactRecord(raw.config, [
    ...v5CatalogKeys,
    'settings',
    'definitions',
    'templates',
    'rules',
    'generationRules',
  ]);
  validateV5Catalog(raw.config as CatalogV06);
  validateDefinitionConfig({
    format: 'cardgrid',
    version: 2,
    kind: 'config',
    config: {
      settings: raw.config.settings,
      definitions: raw.config.definitions,
      templates: raw.config.templates,
      rules: raw.config.rules,
    },
  });
  // GenerationRule shape and owner checks retain the existing contract.
  for (const rule of array(raw.config.generationRules, 'generationRules')) {
    const checked = validateWorkshopEntity('generationRules', rule);
    formatNeed(checked.ok, 'generationRules', 'invalid generation rule');
    formatNeed(
      raw.config.actionCards.some((a: any) => a.id === rule.actionCardId),
      'generationRules',
      'missing owner action',
    );
  }
  unique(raw.config.generationRules, 'generationRules');
  return structuredClone(raw) as ConfigV4;
}

function validateGenericDaily(
  data: DataV5,
  frozen: (kind: string, id: string, version: number) => any,
  receipts: Map<string, DataV5['commandReceipts'][number]>,
) {
  const copies = data.dailyCopies.filter((c) => 'format' in c),
    archives = data.archiveLogs.filter((c) => 'format' in c);
  unique(data.dailyCopies, 'dailyCopies');
  unique(data.archiveLogs, 'archiveLogs');
  const ledgerKeys = new Set<string>();
  for (const l of data.generationLedger) {
    exactRecord(l, ['ruleId', 'sourceDate', 'copyId', 'at']);
    assertDate(l.sourceDate);
    assertInstant(l.at);
    const key = JSON.stringify([l.ruleId, l.sourceDate]);
    formatNeed(!ledgerKeys.has(key), 'ledger', 'duplicate source date');
    ledgerKeys.add(key);
  }
  for (const item of [...copies, ...archives]) {
    const isCopy = 'fieldSpecsSnapshot' in item,
      copyId = isCopy ? item.id : item.copyId;
    exactRecord(
      item,
      isCopy
        ? [
            'format',
            'id',
            'version',
            'ruleId',
            'ruleVersion',
            'actionCard',
            'sourceDate',
            'generatedAt',
            'contentSnapshot',
            'fieldSpecsSnapshot',
            'decisionCardsSnapshot',
            'status',
            'acceptedInstanceIds',
          ]
        : [
            'format',
            'id',
            'version',
            'copyId',
            'ruleId',
            'actionCard',
            'sourceDate',
            'contentSnapshot',
            'acceptedFieldValuesSnapshot',
            'acceptedInstanceIds',
            'disposition',
            'archivedAt',
          ],
    );
    formatNeed(item.format === 'v5', 'format', 'unknown daily format');
    assertDate(item.sourceDate);
    version(item.version, 'version');
    ref(item.actionCard, 'actionCard');
    const source = data.planner.history.find(
      (h) =>
        h.type === 'GenerateDailyCopies' &&
        h.entity.kind === 'daily-copy' &&
        'id' in h.entity &&
        h.entity.id === copyId,
    )?.after as any;
    formatNeed(
      source?.format === 'v5' && source.version === 1,
      'daily',
      'missing original copy snapshot',
    );
    exactRecord(source, [
      'format',
      'id',
      'version',
      'ruleId',
      'ruleVersion',
      'actionCard',
      'sourceDate',
      'generatedAt',
      'contentSnapshot',
      'fieldSpecsSnapshot',
      'decisionCardsSnapshot',
      'status',
      'acceptedInstanceIds',
    ]);
    const action = frozen('action-card', source.actionCard.id, source.actionCard.version);
    formatNeed(
      action &&
        jsonEqual(action.content, source.contentSnapshot) &&
        jsonEqual(action.fields, source.fieldSpecsSnapshot),
      'daily',
      'invalid frozen action',
    );
    const rule = data.planner.history.find(
      (h) =>
        h.entity.kind === 'generation-rule' &&
        (h.after as any)?.id === source.ruleId &&
        (h.after as any)?.version === source.ruleVersion,
    )?.after as any;
    formatNeed(
      rule &&
        rule.actionCardId === action.id &&
        source.sourceDate >= rule.startDate &&
        rule.status === 'active',
      'daily',
      'missing rule snapshot',
    );
    assertInstant(source.generatedAt);
    formatNeed(source.sourceDate <= dateAt(source.generatedAt, rule.zone), 'daily', 'future copy');
    const boundary = dayRange(nextDate(source.sourceDate), rule.zone).startAt;
    const effective = (kind: string, key: string) =>
      data.planner.history
        .filter(
          (h) =>
            h.entity.kind === kind &&
            'id' in h.entity &&
            h.entity.id === key &&
            compareInstants(h.at, boundary) < 0 &&
            compareInstants(h.at, source.generatedAt) <= 0 &&
            (kind !== 'action-card' || (h.after as any)?.fields !== undefined),
        )
        .at(-1)?.after;
    formatNeed(
      jsonEqual(effective('generation-rule', source.ruleId), rule) &&
        jsonEqual(effective('action-card', source.actionCard.id), action),
      'daily',
      'source version was not effective on source date',
    );
    formatNeed(
      action.status === 'active' &&
        source.sourceDate >= nextDate(dateAt(source.generatedAt, rule.zone), -6) &&
        (rule.schedule.mode !== 'weekdays' ||
          rule.schedule.weekdays.includes(weekday(source.sourceDate))),
      'daily',
      'source day is ineligible',
    );
    const expectedDecisions = data.decisionCards
      .map((d) => effective('decision-card', d.id))
      .filter((d: any) => d && d.status === 'active' && d.ownerActionId === action.id);
    formatNeed(
      jsonEqual(source.decisionCardsSnapshot, expectedDecisions),
      'daily',
      'decision snapshot was not effective on source date',
    );
    for (const d of array(source.decisionCardsSnapshot, 'decisionCardsSnapshot'))
      formatNeed(
        jsonEqual(frozen('decision-card', d.id, d.version), d) && d.ownerActionId === action.id,
        'daily',
        'forged decision snapshot',
      );
    formatNeed(
      data.generationLedger.some(
        (l) =>
          l.copyId === copyId &&
          l.ruleId === source.ruleId &&
          l.sourceDate === source.sourceDate &&
          l.at === source.generatedAt,
      ),
      'ledger',
      'missing source ledger',
    );
    const logs = data.planner.history.filter(
      (h) => h.entity.kind === 'daily-copy' && 'id' in h.entity && h.entity.id === copyId,
    );
    let head: any = null;
    for (const h of logs) {
      const a = h.after as any;
      formatNeed(
        head === null
          ? h.before === null && a.version === 1
          : jsonEqual(h.before, head) && a.version === head.version + 1,
        'daily',
        'broken copy chain',
      );
      const receipt = receipts.get(h.commandId);
      formatNeed(
        receipt &&
          receipt.type === h.type &&
          receipt.resultRefs.some((r) => r.kind === 'daily-copy' && 'id' in r && r.id === copyId),
        'daily',
        'missing receipt',
      );
      if (head)
        formatNeed(
          jsonEqual(
            { ...a, version: head.version, acceptedInstanceIds: head.acceptedInstanceIds },
            head,
          ),
          'daily',
          'changed frozen source',
        );
      head = a;
    }
    if (isCopy)
      formatNeed(jsonEqual(head, item) && item.status === 'active', 'daily', 'missing copy head');
    else {
      assertInstant(item.archivedAt);
      formatNeed(
        compareInstants(
          item.archivedAt,
          dayRange(nextDate(source.sourceDate, 7), rule.zone).startAt,
        ) >= 0,
        'daily',
        'early archive',
      );
      formatNeed(
        jsonEqual(item.acceptedInstanceIds, head.acceptedInstanceIds) &&
          jsonEqual(item.actionCard, source.actionCard) &&
          jsonEqual(item.contentSnapshot, source.contentSnapshot) &&
          item.sourceDate === source.sourceDate &&
          item.ruleId === source.ruleId &&
          item.disposition === (item.acceptedInstanceIds.length ? 'accepted' : 'none-accepted'),
        'daily',
        'archive source mismatch',
      );
      formatNeed(
        jsonEqual(
          item.acceptedFieldValuesSnapshot,
          data.handCards.flatMap((c) =>
            (c.kind === 'action' || c.kind === 'composite') &&
            item.acceptedInstanceIds.includes(c.actionInstanceId ?? '')
              ? c.fieldValues
              : [],
          ),
        ),
        'archive',
        'forged accepted fields',
      );
      formatNeed(
        data.planner.history.some(
          (h) =>
            h.entity.kind === 'archive-log' &&
            'id' in h.entity &&
            h.entity.id === item.id &&
            jsonEqual(h.before, head) &&
            jsonEqual(h.after, item),
        ),
        'daily',
        'missing archive history',
      );
    }
    formatNeed(
      new Set(item.acceptedInstanceIds).size === item.acceptedInstanceIds.length,
      'daily',
      'duplicate acceptance',
    );
    for (const i of item.acceptedInstanceIds)
      formatNeed(
        data.planner.instances.some((x) => x.id === i) &&
          data.handCards.some(
            (c) =>
              (c.kind === 'action' || c.kind === 'composite') &&
              c.actionInstanceId === i &&
              c.provenance.some((p) => p.kind === 'daily-copy' && p.copy.id === copyId),
          ),
        'daily',
        'missing accepted material',
      );
  }
  for (const card of data.handCards)
    for (const p of card.provenance)
      if (p.kind === 'daily-copy') {
        const source = data.planner.history.find(
          (h) => h.entity.kind === 'daily-copy' && 'id' in h.entity && h.entity.id === p.copy.id,
        )?.after as any;
        formatNeed(
          source && p.copy.version === 1 && source.sourceDate === p.sourceDate,
          'provenance',
          'invalid source copy',
        );
        const rule = data.generationRules.find((r) => r.id === source.ruleId);
        formatNeed(
          rule &&
            rule.zone === p.zone &&
            p.expiresAt === dayRange(nextDate(p.sourceDate, 7), p.zone).startAt,
          'provenance',
          'invalid expiry',
        );
      }
}

export async function validateV5Fingerprints(data: DataV5) {
  await validateSourceFingerprints(legacyValidationView(data));
}
export { MAX_BACKUP_BYTES, MAX_INPUT_BYTES, fingerprint };
