/** P0 boundary checks only. No candidate selection, synthesis, archive clearing or IO. */
import type {
  ActionCardV5,
  AnswerSnapshot,
  CapacityPolicy,
  CatalogEntry,
  DecisionCard,
  Deck,
  JournalNote,
  MonthlyArchiveManifest,
  V06ErrorCode,
  V06PortStamp,
} from './contracts-v06.ts';
import type { V06Command } from './ports-v06.ts';
import { assertDate, assertInstant, assertZone } from '../daily/time.ts';

export class V06ContractError extends Error {
  readonly code: V06ErrorCode;
  readonly field: string;
  constructor(code: V06ErrorCode, field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'V06ContractError';
    this.code = code;
    this.field = field;
  }
}
type Check = (value: unknown, path: string) => void;
const fail = (path: string, message: string): never => {
  throw new V06ContractError('INVALID_INPUT', path, message);
};
const object = (value: unknown, path: string): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(path, 'expected object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    fail(path, 'expected plain JSON object');
  return value as Record<string, unknown>;
};
const text: Check = (v, p) => {
  if (typeof v !== 'string') fail(p, 'expected text');
};
const nonempty: Check = (v, p) => {
  text(v, p);
  if (!(v as string).trim()) fail(p, 'expected non-empty text');
};
const bool: Check = (v, p) => {
  if (typeof v !== 'boolean') fail(p, 'expected boolean');
};
const integer =
  (min: number): Check =>
  (v, p) => {
    if (!Number.isSafeInteger(v) || (v as number) < min) fail(p, `expected integer >= ${min}`);
  };
const oneOf =
  (...values: readonly unknown[]): Check =>
  (v, p) => {
    if (!values.includes(v)) fail(p, 'unsupported value');
  };
const nullable =
  (check: Check): Check =>
  (v, p) => {
    if (v !== null) check(v, p);
  };
const list =
  (check: Check, maximum = Infinity): Check =>
  (v, p) => {
    if (!Array.isArray(v)) fail(p, 'expected array');
    const items = v as unknown[];
    if (items.length > maximum)
      throw new V06ContractError('POOL_CAPACITY_EXCEEDED', p, `最多 ${maximum} 个直接成员`);
    for (let i = 0; i < items.length; i++) {
      if (!Object.hasOwn(items, i)) fail(`${p}[${i}]`, 'array hole');
      check(items[i], `${p}[${i}]`);
    }
  };
const shape =
  (fields: Record<string, Check>, optional: readonly string[] = []): Check =>
  (v, p) => {
    const value = object(v, p);
    for (const key of Object.keys(value))
      if (!Object.hasOwn(fields, key)) fail(`${p}.${key}`, 'unknown field');
    for (const [key, check] of Object.entries(fields)) {
      if (!Object.hasOwn(value, key)) {
        if (!optional.includes(key)) fail(`${p}.${key}`, 'required field');
      } else check(value[key], `${p}.${key}`);
    }
  };
const checked =
  (fn: (v: string) => void): Check =>
  (v, p) => {
    text(v, p);
    try {
      fn(v as string);
    } catch (e) {
      fail(p, (e as Error).message);
    }
  };
const date = checked(assertDate),
  instant = checked(assertInstant),
  zone = checked(assertZone);
const token = shape({ epoch: nonempty, revision: integer(0) });
const versionRef = shape({ id: nonempty, version: integer(1) });
const source: Check = (v, p) => {
  const value = object(v, p);
  if (value.kind === 'manual') shape({ kind: oneOf('manual') })(v, p);
  else if (value.kind === 'legacy')
    shape({ kind: oneOf('legacy'), sourceId: nonempty, path: nonempty })(v, p);
  else
    shape({
      kind: oneOf('definition', 'capture', 'occurrence', 'makeup', 'daily-copy'),
      id: nonempty,
    })(v, p);
};
const scalar: Check = (v, p) => {
  if (
    v !== null &&
    typeof v !== 'string' &&
    typeof v !== 'boolean' &&
    !(typeof v === 'number' && Number.isFinite(v))
  )
    fail(p, 'expected finite JSON scalar');
};
const attributes: Check = (v, p) => {
  for (const [key, value] of Object.entries(object(v, p))) {
    if (!key.trim() || ['__proto__', 'constructor', 'prototype'].includes(key))
      fail(`${p}.${key}`, 'invalid attribute key');
    scalar(value, `${p}.${key}`);
  }
};
const uniqueStrings: Check = (v, p) => {
  list(nonempty)(v, p);
  if (new Set(v as string[]).size !== (v as string[]).length) fail(p, 'duplicate ID');
};
const content = shape({
  title: nonempty,
  criteria: text,
  presetMinutes: nullable(integer(1)),
  color: (v, p) => {
    text(v, p);
    if (!/^#[a-f\d]{6}$/i.test(v as string)) fail(p, 'expected color');
  },
  categoryId: nullable(nonempty),
  categoryLabel: nullable(text),
  minimum: bool,
  projectIds: uniqueStrings,
  goalIds: uniqueStrings,
  projectLabels: list(shape({ id: nonempty, label: text })),
  goalLabels: list(shape({ id: nonempty, label: text })),
});
const field = shape({
  id: nonempty,
  label: nonempty,
  valueType: oneOf('text', 'number', 'boolean'),
  required: bool,
});
const mapping = shape({
  fieldId: nonempty,
  entryPath: (v, p) => {
    nonempty(v, p);
    const value = v as string;
    if (value !== 'title' && !/^attributes\.[^\.]+$/.test(value))
      fail(p, 'only title or a flat attribute path is allowed');
    if (['__proto__', 'constructor', 'prototype'].includes(value.slice('attributes.'.length)))
      fail(p, 'invalid attribute path');
  },
});
const entry = shape({
  id: nonempty,
  version: integer(1),
  title: nonempty,
  attributes,
  url: nullable((v, p) => {
    nonempty(v, p);
    try {
      const url = new URL(v as string);
      if (!['http:', 'https:'].includes(url.protocol)) fail(p, 'only http/https URLs');
    } catch {
      fail(p, 'invalid http/https URL');
    }
  }),
  status: oneOf('active', 'archived'),
  source,
});
const deck = shape({
  id: nonempty,
  version: integer(1),
  name: nonempty,
  deckKind: oneOf('action', 'decision', 'entry'),
  parentDeckId: nullable(nonempty),
  memberIds: (v, p) => {
    list(nonempty, 100)(v, p);
    uniqueStrings(v, p);
  },
  source,
});
const action = shape({
  id: nonempty,
  version: integer(1),
  kind: oneOf('action'),
  content,
  fields: list(field),
  status: oneOf('active', 'paused', 'archived'),
  parentId: nullable(nonempty),
  source,
});
const decision = shape({
  id: nonempty,
  version: integer(1),
  question: nonempty,
  ownerActionId: nonempty,
  deckIds: uniqueStrings,
  mappings: list(mapping),
  status: oneOf('active', 'paused', 'archived'),
  source,
});
const answer = shape({
  decision: versionRef,
  question: nonempty,
  ownerAction: versionRef,
  entry,
  sourceDecks: list(versionRef),
  mappings: list(mapping),
  fieldValues: list(shape({ fieldId: nonempty, value: scalar })),
  selectedAt: instant,
});
const note = shape({
  id: nonempty,
  version: integer(1),
  kind: oneOf('reflection'),
  date,
  zone,
  recordedAt: instant,
  createdAt: instant,
  updatedAt: instant,
  text,
});
export type V06DtoMap = {
  entry: CatalogEntry;
  deck: Deck;
  action: ActionCardV5;
  decision: DecisionCard;
  answer: AnswerSnapshot;
  note: JournalNote;
};
const dtoChecks: Record<keyof V06DtoMap, Check> = { entry, deck, action, decision, answer, note };
export function validateV06Dto<K extends keyof V06DtoMap>(
  kind: K,
  value: unknown,
): asserts value is V06DtoMap[K] {
  dtoChecks[kind](value, '$');
}

export function validateV06PortStamp(value: unknown): asserts value is V06PortStamp {
  shape({
    contractVersion: oneOf('v06-p0-1'),
    backend: oneOf('test-adapter', 'formal'),
    release: oneOf('draft', 'frozen'),
  })(value, '$');
  const stamp = value as V06PortStamp;
  if (stamp.backend === 'formal' && stamp.release !== 'frozen')
    fail('$.release', 'formal ports require a frozen contract');
}

const expectedVersion = nullable(integer(1));
const commandChecks: Record<V06Command['type'], Check> = {
  SaveCatalogEntry: shape({ entry, expectedVersion }),
  SaveDeck: shape({ deck, expectedVersion }),
  SaveActionCardV5: shape({ actionCard: action, expectedVersion }),
  SaveDecisionCard: shape({ decision, expectedVersion }),
  MoveDeckMember: shape({
    entry: versionRef,
    from: versionRef,
    to: versionRef,
    targetIndex: integer(0),
  }),
  TakeActionMaterial: shape({ action: versionRef }),
  TakeEntryMaterial: shape({ entry: versionRef }),
  AcceptDecisionAnswer: shape({ selectionId: nonempty, alsoTakeAction: bool }),
  ConfirmSynthesis: shape({ previewId: nonempty }),
  ReorderUnifiedHand: shape({ cardIds: uniqueStrings }),
  CommitReferencePlacement: shape({ previewId: nonempty }),
  RetractReference: shape({ reference: versionRef }),
  SaveJournalNote: shape({ id: nullable(nonempty), expectedVersion, date, zone, text }),
  SaveLegacyJournalBlock: shape({ entry: versionRef, text }),
  ImportCatalogV4: shape({
    previewId: nonempty,
    mode: oneOf('merge', 'replace'),
    backupEvidenceId: nonempty,
  }),
  CommitMonthlyArchive: shape({
    previewId: nonempty,
    verificationId: nonempty,
    clearPreviewId: nonempty,
    removalConfirmed: oneOf(true),
  }),
};
export function validateV06CommandInput(value: unknown): asserts value is V06Command {
  shape({
    contractVersion: oneOf('v06-p0-1'),
    commandId: nonempty,
    expected: token,
    type: nonempty,
    payload: (v, p) => {
      object(v, p);
    },
  })(value, '$');
  const command = value as V06Command;
  if (!Object.hasOwn(commandChecks, command.type)) fail('$.type', 'unsupported P0 command');
  commandChecks[command.type](command.payload, '$.payload');
  if (command.type === 'SaveJournalNote') {
    if ((command.payload.id === null) !== (command.payload.expectedVersion === null))
      fail(
        '$.payload.expectedVersion',
        'creation needs null ID and null version; updates need both',
      );
  }
}

const sha256: Check = (v, p) => {
  text(v, p);
  if (!/^[a-f\d]{64}$/.test(v as string)) fail(p, 'expected lowercase SHA-256');
};
const month: Check = (v, p) => {
  text(v, p);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(v as string)) fail(p, 'expected YYYY-MM');
  date(`${v}-01`, p);
};
const recordCollections = [
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
const counts: Check = (v, p) => {
  for (const [key, value] of Object.entries(object(v, p))) {
    if (!recordCollections.includes(key)) fail(`${p}.${key}`, 'unknown record collection');
    integer(0)(value, `${p}.${key}`);
  }
};
export function validateMonthlyArchiveManifest(
  value: unknown,
): asserts value is MonthlyArchiveManifest {
  try {
    shape({
      format: oneOf('cardgrid-monthly-archive'),
      version: oneOf(1),
      archiveId: nonempty,
      workspaceId: nonempty,
      month,
      zone,
      createdAt: instant,
      sourceToken: token,
      sourceDataFormat: oneOf('action-v5'),
      closure: oneOf('self-contained'),
      coveredDates: (v, p) => {
        list(date)(v, p);
        uniqueStrings(v, p);
      },
      recordCounts: counts,
      files: (v, p) => {
        list(shape({ path: oneOf('records.json'), sha256, bytes: integer(1) }))(v, p);
        if ((v as unknown[]).length !== 1) fail(p, 'exactly records.json is required');
      },
    })(value, '$');
  } catch (e) {
    if (e instanceof V06ContractError)
      throw new V06ContractError('ARCHIVE_INVALID', e.field, e.message);
    throw e;
  }
}

export function checkV06ByteBudget(
  kind: 'active-backup' | 'input' | 'archive-compressed' | 'archive-expanded',
  bytes: number,
  policy: CapacityPolicy,
): void {
  shape({
    status: oneOf('provisional', 'validated'),
    maxActiveBackupBytes: integer(1),
    maxInputBytes: integer(1),
    maxArchiveCompressedBytes: integer(1),
    maxArchiveExpandedBytes: integer(1),
    maxArchiveEntries: integer(1),
    maxLoadedArchiveMonths: oneOf(1, 2),
  })(policy, '$.policy');
  integer(0)(bytes, '$.bytes');
  if (policy.maxInputBytes < policy.maxActiveBackupBytes)
    fail(
      '$.policy.maxInputBytes',
      'input gate must allow recovery of every accepted active backup',
    );
  const limit = {
    'active-backup': policy.maxActiveBackupBytes,
    input: policy.maxInputBytes,
    'archive-compressed': policy.maxArchiveCompressedBytes,
    'archive-expanded': policy.maxArchiveExpandedBytes,
  }[kind];
  if (bytes > limit)
    throw new V06ContractError(
      kind.startsWith('archive-') ? 'ARCHIVE_BUDGET_EXCEEDED' : 'DATA_TOO_LARGE',
      '$.bytes',
      `${bytes} bytes exceed ${limit}`,
    );
}
