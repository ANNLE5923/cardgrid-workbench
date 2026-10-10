/**
 * Safe recovery parsing (v0.6.2, Excalidraw restore-on-read precedent).
 *
 * Pure, never throws, never writes. It walks the raw envelope best-effort and
 * reports what could be extracted. Extracted strings are raw and unvalidated;
 * they must never be turned into editable business data.
 */

export type SafeProblem = Readonly<{ path: string; message: string }>;
export type SafeEntry = Readonly<{ index: number; id: string; label: string }>;
export type SafeCollection = Readonly<{
  key: string;
  kind: 'array' | 'object' | 'scalar';
  total: number;
  readable: number;
  malformed: number;
  entries: readonly SafeEntry[];
}>;
export type SafeOuter = Readonly<{
  schemaVersion: string;
  epoch: string;
  revision: string;
  mode: string;
  dataFormat: string;
}>;
export type SafeRecoveryReport = Readonly<{
  outer: SafeOuter;
  collections: readonly SafeCollection[];
  problems: readonly SafeProblem[];
  totals: Readonly<{
    arrayCollections: number;
    entries: number;
    readable: number;
    malformed: number;
  }>;
}>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const truncate = (v: string, max = 80): string => (v.length > max ? `${v.slice(0, max)}…` : v);

function primitiveText(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** Best-effort human label; only reads raw strings, never invents one. */
function extractLabel(e: Record<string, unknown>): string {
  const candidates = [
    e.title,
    e.name,
    e.headline,
    e.label,
    isRecord(e.content) ? e.content.title : undefined,
    isRecord(e.content) ? e.content.name : undefined,
    e.text,
  ];
  for (const c of candidates) {
    const t = primitiveText(c);
    if (t) return truncate(t);
  }
  return '（无标题）';
}

function extractId(e: Record<string, unknown>): string {
  return primitiveText(e.id) || primitiveText(e.key) || '';
}

const FRIENDLY: Readonly<Record<string, string>> = {
  actionCards: '行动卡',
  bookEntries: '手册条目',
  pools: '牌池',
  definitions: '行动定义',
  templates: '日程模板',
  rules: '生成规则',
  generationRules: '生成规则',
  instances: '行动实例',
  plans: '排期计划',
  facts: '已确认事实',
  annotations: '批注',
  handCards: '手牌',
  journalNotes: '感想日记',
  referencePlacements: '引用排期',
  factReferenceSnapshots: '事实引用快照',
  catalogAliases: '目录别名',
  archiveIndex: '归档索引',
  commandReceipts: '命令收据',
  dailyCopies: '每日副本',
  archiveLogs: '归档日志',
};

export function friendlyCollectionName(key: string): string {
  return FRIENDLY[key] ?? key;
}

function outerField(env: Record<string, unknown>, key: string): string {
  const t = primitiveText(env[key]);
  return t || '未知';
}

export function parseSafeRecovery(raw: unknown): SafeRecoveryReport {
  const problems: SafeProblem[] = [];
  const collections: SafeCollection[] = [];
  const env = isRecord(raw) ? raw : {};

  if (!isRecord(raw)) {
    problems.push({ path: '(envelope)', message: '信封不是一个对象，无法识别外层结构' });
  }

  const outer: SafeOuter = {
    schemaVersion: outerField(env, 'schemaVersion'),
    epoch: outerField(env, 'epoch'),
    revision: outerField(env, 'revision'),
    mode: outerField(env, 'mode'),
    dataFormat: outerField(env, 'dataFormat'),
  };

  const data = env.data;
  if (!isRecord(data)) {
    problems.push({ path: 'data', message: 'data 字段缺失或不是对象，无法列出集合' });
  } else {
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (Array.isArray(value)) {
        const entries: SafeEntry[] = [];
        let malformed = 0;
        value.forEach((element, index) => {
          if (isRecord(element)) {
            entries.push({ index, id: extractId(element), label: extractLabel(element) });
          } else {
            malformed += 1;
          }
        });
        if (malformed > 0) {
          problems.push({
            path: `data.${key}`,
            message: `${malformed} 个条目不是对象，无法读取`,
          });
        }
        collections.push({
          key,
          kind: 'array',
          total: value.length,
          readable: entries.length,
          malformed,
          entries,
        });
      } else if (isRecord(value)) {
        collections.push({
          key,
          kind: 'object',
          total: 0,
          readable: 0,
          malformed: 0,
          entries: [],
        });
      } else {
        collections.push({
          key,
          kind: 'scalar',
          total: 0,
          readable: 0,
          malformed: 0,
          entries: [],
        });
      }
    }
  }

  const arrayCollections = collections.filter((c) => c.kind === 'array');
  const totals = {
    arrayCollections: arrayCollections.length,
    entries: arrayCollections.reduce((n, c) => n + c.total, 0),
    readable: arrayCollections.reduce((n, c) => n + c.readable, 0),
    malformed: arrayCollections.reduce((n, c) => n + c.malformed, 0),
  };

  return { outer, collections, problems, totals };
}
