import type {
  LastTextSuccess,
  OutputKey,
  TextSourceVersion,
  TextWriteIntent,
} from '../workspace/v06.ts';
import { V06ContractError } from '../workspace/v06.ts';
import { canonicalJson } from '../workspace/codec.ts';
import { assertDate, assertZone } from '../daily/time.ts';

export type TextDocument = Readonly<{ text: string; sha256: string; source: TextSourceVersion }>;
export async function hashTextBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function hashText(text: string): Promise<string> {
  if (typeof text !== 'string') throw new V06ContractError('INVALID_INPUT', 'text', '输出需要文本');
  return hashTextBytes(new TextEncoder().encode(text));
}
function validateSource(source: TextSourceVersion): void {
  const epoch = source.kind === 'journal' ? source.token.epoch : source.epoch;
  const revision = source.kind === 'journal' ? source.token.revision : source.dayRevision;
  if (
    !['journal', 'maintenance'].includes(source.kind) ||
    typeof epoch !== 'string' ||
    !epoch.trim() ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !/^[a-f\d]{64}$/.test(source.inputFingerprint)
  )
    throw new V06ContractError('INVALID_INPUT', 'source', '输出源版本或指纹无效');
}
export async function prepareTextDocument(
  text: string,
  source: TextSourceVersion,
): Promise<TextDocument> {
  if (typeof text !== 'string' || text.includes('\r'))
    throw new V06ContractError('INVALID_INPUT', 'text', '生成文本须为 LF 换行');
  validateSource(source);
  return { text, sha256: await hashText(text), source: structuredClone(source) };
}
export type TextStep =
  | Readonly<{ kind: 'preserve-external'; bytes: Uint8Array }>
  | Readonly<{ kind: 'restore-last-success'; text: string }>
  | Readonly<{ kind: 'write-latest'; document: TextDocument }>
  | Readonly<{ kind: 'record-reconciled'; intentId: string | null; document: TextDocument }>;
export type TextReconcilePlan = Readonly<{
  kind: 'current' | 'update' | 'external-change' | 'missing' | 'initialize' | 'reconcile' | 'stale';
  steps: readonly TextStep[];
  externalChange: boolean;
  errorCode: 'WORKSPACE_REPLACED' | 'SOURCE_STALE' | null;
}>;
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function sourceCompatible(
  older: TextSourceVersion,
  current: TextSourceVersion,
  epoch: string,
): boolean {
  if (older.kind !== current.kind) return false;
  if (older.kind === 'journal' && current.kind === 'journal')
    return (
      older.token.epoch === epoch &&
      current.token.epoch === epoch &&
      older.token.revision <= current.token.revision &&
      (older.token.revision < current.token.revision ||
        older.inputFingerprint === current.inputFingerprint)
    );
  return (
    older.kind === 'maintenance' &&
    current.kind === 'maintenance' &&
    older.epoch === epoch &&
    current.epoch === epoch &&
    older.dayRevision <= current.dayRevision &&
    (older.dayRevision < current.dayRevision || older.inputFingerprint === current.inputFingerprint)
  );
}
/** Ordered IO intentions only. Each step must succeed before B9 proceeds; never reports synced. */
export async function planTextReconciliation(
  input: Readonly<{
    key: OutputKey;
    currentKey: OutputKey;
    lastSuccess: LastTextSuccess | null;
    intent: TextWriteIntent | null;
    latest: TextDocument;
    diskBytes: Uint8Array | null;
  }>,
): Promise<TextReconcilePlan> {
  if (!equal(input.key, input.currentKey))
    return {
      kind: 'stale',
      steps: [],
      externalChange: false,
      errorCode: input.key.epoch !== input.currentKey.epoch ? 'WORKSPACE_REPLACED' : 'SOURCE_STALE',
    };
  assertDate(input.key.date);
  assertZone(input.key.zone);
  const { lastSuccess, intent, latest, diskBytes } = input;
  for (const value of [lastSuccess, intent, latest]) if (value) validateSource(value.source);
  if (
    intent &&
    (!intent.intentId.trim() || !['prepared', 'closed', 'verified'].includes(intent.stage))
  )
    throw new V06ContractError('INVALID_INPUT', 'intent', '写入意图身份或阶段无效');
  if (
    latest.source.kind !== input.key.kind ||
    !sourceCompatible(latest.source, latest.source, input.key.epoch)
  )
    return { kind: 'stale', steps: [], externalChange: false, errorCode: 'SOURCE_STALE' };
  for (const value of [lastSuccess, intent, latest])
    if (value && (await hashText(value.text)) !== value.sha256)
      throw new V06ContractError('INVALID_INPUT', 'sha256', '输出状态指纹与 UTF-8 实际内容不符');
  if (
    (intent && !sourceCompatible(intent.source, latest.source, input.key.epoch)) ||
    (lastSuccess && !sourceCompatible(lastSuccess.source, latest.source, input.key.epoch))
  )
    return { kind: 'stale', steps: [], externalChange: false, errorCode: 'SOURCE_STALE' };
  const diskHash = diskBytes === null ? null : await hashTextBytes(diskBytes);
  if (intent && diskHash === intent.sha256) {
    const document: TextDocument = {
      text: intent.text,
      sha256: intent.sha256,
      source: structuredClone(intent.source),
    };
    const steps: TextStep[] = [{ kind: 'record-reconciled', intentId: intent.intentId, document }];
    if (intent.sha256 !== latest.sha256)
      steps.push({ kind: 'write-latest', document: structuredClone(latest) });
    else if (!equal(intent.source, latest.source))
      steps.push({ kind: 'record-reconciled', intentId: null, document: structuredClone(latest) });
    return { kind: 'reconcile', steps, externalChange: false, errorCode: null };
  }
  if (lastSuccess && diskHash === lastSuccess.sha256) {
    const steps: TextStep[] =
      diskHash !== latest.sha256
        ? [{ kind: 'write-latest', document: structuredClone(latest) }]
        : equal(lastSuccess.source, latest.source)
          ? []
          : [{ kind: 'record-reconciled', intentId: null, document: structuredClone(latest) }];
    return {
      kind: diskHash === latest.sha256 ? 'current' : 'update',
      steps,
      externalChange: false,
      errorCode: null,
    };
  }
  const steps: TextStep[] = [];
  if (diskBytes !== null)
    steps.push({ kind: 'preserve-external', bytes: new Uint8Array(diskBytes) });
  if (lastSuccess) steps.push({ kind: 'restore-last-success', text: lastSuccess.text });
  if (!lastSuccess || latest.sha256 !== lastSuccess.sha256)
    steps.push({ kind: 'write-latest', document: structuredClone(latest) });
  else steps.push({ kind: 'record-reconciled', intentId: null, document: structuredClone(latest) });
  return {
    kind: lastSuccess ? (diskBytes === null ? 'missing' : 'external-change') : 'initialize',
    steps,
    externalChange: diskBytes !== null,
    errorCode: null,
  };
}
