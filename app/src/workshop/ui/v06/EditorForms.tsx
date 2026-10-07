// A2 editor forms for decks, catalog entries and decision cards.
// Forms only collect drafts and report them; persistence goes through the
// injected host. Draft validation errors are rendered inline (no fake success).
import { useMemo, useState } from 'react';
import type {
  ActionCardV5,
  CatalogEntry,
  DecisionCard,
  Deck,
  FieldMapping,
  Scalar,
} from '../../../workspace/v06.ts';
import type { Id } from '../../../workspace/index.ts';

export const genId = (): Id =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** Parse a free-text attribute cell back into a JSON scalar. */
export const parseAttributeValue = (raw: string): Scalar => {
  const t = raw.trim();
  if (t === '') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t) && Number.isFinite(Number(t))) return Number(t);
  return raw;
};
const toRaw = (value: Scalar): string => (value === null ? '' : String(value));

const fieldCls = (invalid: boolean) => `we2-field${invalid ? ' invalid' : ''}`;

function FieldRow(
  props: Readonly<{ label: string; invalid?: boolean; children: React.ReactNode; hint?: string }>,
) {
  return (
    <label className={fieldCls(props.invalid ?? false)}>
      <span className="we2-label">{props.label}</span>
      {props.children}
      {props.hint ? <small className="we2-hint">{props.hint}</small> : null}
    </label>
  );
}

export const FormActions = (
  props: Readonly<{
    busy: boolean;
    submitLabel: string;
    onCancel: () => void;
    onSubmit: () => void;
  }>,
) => (
  <div className="we2-actions">
    <button
      type="button"
      className="we2-btn primary"
      disabled={props.busy}
      onClick={props.onSubmit}
    >
      {props.submitLabel}
    </button>
    <button type="button" className="we2-btn" disabled={props.busy} onClick={props.onCancel}>
      取消
    </button>
  </div>
);

// --- Deck form --------------------------------------------------------------
export type DeckDraft = Deck;
export function DeckForm(
  props: Readonly<{
    decks: readonly Deck[];
    initial?: Deck;
    busy: boolean;
    onCancel: () => void;
    onSubmit: (draft: Deck, expectedVersion: number | null) => void;
  }>,
) {
  const { initial } = props;
  const [draftId] = useState(() => initial?.id ?? genId());
  const [name, setName] = useState(initial?.name ?? '');
  const [deckKind, setDeckKind] = useState<Deck['deckKind']>(initial?.deckKind ?? 'entry');
  const [parentDeckId, setParentDeckId] = useState<Id | null>(initial?.parentDeckId ?? null);
  const nameInvalid = name.trim() === '';

  const submit = () => {
    if (nameInvalid) return;
    if (initial) props.onSubmit({ ...initial, name: name.trim(), parentDeckId }, initial.version);
    else {
      const draft: Deck = {
        id: draftId,
        version: 1,
        name: name.trim(),
        deckKind,
        parentDeckId,
        memberIds: [],
        source: { kind: 'manual' },
      };
      props.onSubmit(draft, null);
    }
  };

  return (
    <div className="we2-form">
      <h2>{initial ? '编辑牌堆' : '新建牌堆'}</h2>
      <FieldRow label="牌堆名称" invalid={nameInvalid}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：书单待读"
        />
      </FieldRow>
      <FieldRow label="牌堆类型" hint="编辑时类型不可更改（成员按类型解析）">
        <select
          value={deckKind}
          disabled={initial !== undefined}
          onChange={(e) => setDeckKind(e.target.value as Deck['deckKind'])}
        >
          <option value="entry">资源牌堆（条目：书/餐食/网址…）</option>
          <option value="action">行动牌堆（行动原卡）</option>
          <option value="decision">决策牌堆（决策卡）</option>
        </select>
      </FieldRow>
      <FieldRow label="父牌堆（可选）">
        <select
          value={parentDeckId ?? ''}
          onChange={(e) => setParentDeckId(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">（无父牌堆）</option>
          {props.decks
            .filter((d) => d.id !== initial?.id)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
        </select>
      </FieldRow>
      <FormActions
        busy={props.busy}
        submitLabel={initial ? '保存牌堆' : '创建牌堆'}
        onCancel={props.onCancel}
        onSubmit={submit}
      />
    </div>
  );
}

// --- Entry form -------------------------------------------------------------
type AttrRow = { key: string; raw: string };
export function EntryForm(
  props: Readonly<{
    initial?: CatalogEntry;
    decks: readonly Deck[];
    defaultDeckId?: Id | null;
    joinPending?: boolean;
    busy: boolean;
    onCancel: () => void;
    onSubmit: (
      draft: CatalogEntry,
      expectedVersion: number | null,
      targetDeckId: Id | null,
    ) => void;
  }>,
) {
  const { initial } = props;
  const [draftId] = useState(() => initial?.id ?? genId());
  const [title, setTitle] = useState(initial?.title ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [status, setStatus] = useState<CatalogEntry['status']>(initial?.status ?? 'active');
  const [targetDeckId, setTargetDeckId] = useState<Id | null>(props.defaultDeckId ?? null);
  const initialRows = useMemo<AttrRow[]>(
    () =>
      Object.entries(initial?.attributes ?? {}).map(([key, value]) => ({ key, raw: toRaw(value) })),
    [initial],
  );
  const [rows, setRows] = useState<AttrRow[]>(initialRows);
  const titleInvalid = title.trim() === '';
  const urlInvalid = url.trim() !== '' && !/^https?:\/\/.+/i.test(url.trim());

  const updateRow = (i: number, patch: Partial<AttrRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = () => {
    if (titleInvalid || urlInvalid) return;
    const attributes: Record<string, Scalar> = {};
    for (const row of rows) {
      const key = row.key.trim();
      if (key) attributes[key] = parseAttributeValue(row.raw);
    }
    if (initial) {
      const draft: CatalogEntry = {
        ...initial,
        title: title.trim(),
        attributes,
        url: url.trim() ? url.trim() : null,
        status,
      };
      props.onSubmit(draft, initial.version, null);
    } else {
      const draft: CatalogEntry = {
        id: draftId,
        version: 1,
        title: title.trim(),
        attributes,
        url: url.trim() ? url.trim() : null,
        status,
        source: { kind: 'manual' },
      };
      props.onSubmit(draft, null, targetDeckId);
    }
  };

  return (
    <div className="we2-form">
      <h2>{initial ? '编辑条目' : '新建条目'}</h2>
      <FieldRow label="标题" invalid={titleInvalid}>
        <input
          disabled={props.busy || props.joinPending}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：原子习惯"
        />
      </FieldRow>
      <FieldRow label="网址（可选）" invalid={urlInvalid} hint="仅允许 http:// 或 https://">
        <input
          disabled={props.busy || props.joinPending}
          value={url ?? ''}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
        />
      </FieldRow>
      <FieldRow label="状态">
        <select
          disabled={props.busy || props.joinPending}
          value={status}
          onChange={(e) => setStatus(e.target.value as CatalogEntry['status'])}
        >
          <option value="active">启用</option>
          <option value="archived">归档</option>
        </select>
      </FieldRow>

      <fieldset className="we2-attrs" disabled={props.busy || props.joinPending}>
        <legend>属性（字段映射可读取这些值）</legend>
        {rows.length === 0 ? <p className="we2-empty">暂无属性。</p> : null}
        {rows.map((row, i) => (
          <div className="we2-attr-row" key={i}>
            <input
              className="we2-attr-key"
              value={row.key}
              placeholder="属性名"
              onChange={(e) => updateRow(i, { key: e.target.value })}
            />
            <span className="we2-eq">=</span>
            <input
              className="we2-attr-val"
              value={row.raw}
              placeholder="值（true/false/数字/文本）"
              onChange={(e) => updateRow(i, { raw: e.target.value })}
            />
            <button
              type="button"
              className="we2-btn tiny"
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
            >
              删除
            </button>
          </div>
        ))}
        <button
          type="button"
          className="we2-btn tiny"
          onClick={() => setRows((rs) => [...rs, { key: '', raw: '' }])}
        >
          ＋ 添加属性
        </button>
      </fieldset>

      {initial ? null : (
        <FieldRow label="加入牌堆（可选）">
          <select
            disabled={props.busy || props.joinPending}
            value={targetDeckId ?? ''}
            onChange={(e) => setTargetDeckId(e.target.value === '' ? null : e.target.value)}
          >
            <option value="">（仅创建，暂不加入牌堆）</option>
            {props.decks
              .filter((d) => d.deckKind === 'entry')
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
        </FieldRow>
      )}
      <FormActions
        busy={props.busy}
        submitLabel={initial ? '保存条目' : '创建条目'}
        onCancel={props.onCancel}
        onSubmit={submit}
      />
    </div>
  );
}

// --- Decision form ----------------------------------------------------------
export function DecisionForm(
  props: Readonly<{
    actions: readonly ActionCardV5[];
    decks: readonly Deck[];
    initial?: DecisionCard;
    busy: boolean;
    onCancel: () => void;
    onSubmit: (draft: DecisionCard, expectedVersion: number | null) => void;
  }>,
) {
  const { initial } = props;
  const [draftId] = useState(() => initial?.id ?? genId());
  const [question, setQuestion] = useState(initial?.question ?? '');
  const [ownerActionId, setOwnerActionId] = useState<Id>(
    initial?.ownerActionId ?? props.actions[0]?.id ?? '',
  );
  const [deckIdSet, setDeckIdSet] = useState<Set<Id>>(new Set(initial?.deckIds ?? []));
  const [status, setStatus] = useState<DecisionCard['status']>(initial?.status ?? 'active');
  const [mappings, setMappings] = useState<FieldMapping[]>(initial ? [...initial.mappings] : []);
  const questionInvalid = question.trim() === '';
  const owner = props.actions.find((a) => a.id === ownerActionId);
  const entryDecks = props.decks.filter((d) => d.deckKind === 'entry');

  const toggleDeck = (id: Id) =>
    setDeckIdSet((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const changeOwner = (id: Id) => {
    setOwnerActionId(id);
    const action = props.actions.find((a) => a.id === id);
    // Drop mappings whose field no longer exists on the new owner.
    if (action)
      setMappings((ms) => ms.filter((m) => action.fields.some((f) => f.id === m.fieldId)));
  };
  const updateMapping = (i: number, patch: Partial<FieldMapping>) =>
    setMappings((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  const submit = () => {
    if (questionInvalid || !owner) return;
    const deckIds = entryDecks.filter((d) => deckIdSet.has(d.id)).map((d) => d.id);
    if (initial) {
      const draft: DecisionCard = {
        ...initial,
        question: question.trim(),
        ownerActionId,
        deckIds,
        mappings,
        status,
      };
      props.onSubmit(draft, initial.version);
    } else {
      const draft: DecisionCard = {
        id: draftId,
        version: 1,
        question: question.trim(),
        ownerActionId,
        deckIds,
        mappings,
        status,
        source: { kind: 'manual' },
      };
      props.onSubmit(draft, null);
    }
  };

  return (
    <div className="we2-form">
      <h2>{initial ? '编辑决策' : '新建决策'}</h2>
      <FieldRow label="决策问题" invalid={questionInvalid}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="例如：这餐吃什么？"
        />
      </FieldRow>
      <FieldRow label="归属行动" hint="一个决策只归属一个行动；多个决策可服务同一行动">
        <select value={ownerActionId} onChange={(e) => changeOwner(e.target.value as Id)}>
          {props.actions.map((a) => (
            <option key={a.id} value={a.id}>
              {a.content.title}
            </option>
          ))}
        </select>
      </FieldRow>

      <fieldset className="we2-attrs">
        <legend>候选资源牌堆（可多选、可与其他决策共享）</legend>
        {entryDecks.length === 0 ? <p className="we2-empty">还没有资源牌堆，请先创建。</p> : null}
        {entryDecks.map((d) => (
          <label key={d.id} className="we2-check">
            <input
              type="checkbox"
              checked={deckIdSet.has(d.id)}
              onChange={() => toggleDeck(d.id)}
            />
            {d.name} <small>（{d.memberIds.length} 个成员）</small>
          </label>
        ))}
      </fieldset>

      <fieldset className="we2-attrs">
        <legend>字段映射（可选）</legend>
        {mappings.length === 0 ? <p className="we2-empty">暂无映射，答案将只记录标题。</p> : null}
        {mappings.map((mapping, i) => (
          <div className="we2-map-row" key={i}>
            <select
              value={mapping.fieldId}
              onChange={(e) => updateMapping(i, { fieldId: e.target.value as Id })}
            >
              {(owner?.fields ?? []).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}（{f.id}·{f.valueType}）
                </option>
              ))}
            </select>
            <span className="we2-eq">←</span>
            <input
              value={mapping.entryPath}
              placeholder="title 或 attributes.属性名"
              onChange={(e) =>
                updateMapping(i, { entryPath: e.target.value as FieldMapping['entryPath'] })
              }
            />
            <button
              type="button"
              className="we2-btn tiny"
              onClick={() => setMappings((ms) => ms.filter((_, j) => j !== i))}
            >
              删除
            </button>
          </div>
        ))}
        {owner && owner.fields.length > 0 ? (
          <button
            type="button"
            className="we2-btn tiny"
            onClick={() =>
              setMappings((ms) => [...ms, { fieldId: owner.fields[0].id, entryPath: 'title' }])
            }
          >
            ＋ 添加映射
          </button>
        ) : null}
      </fieldset>

      <FieldRow label="状态">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as DecisionCard['status'])}
        >
          <option value="active">启用</option>
          <option value="paused">暂停</option>
          <option value="archived">归档</option>
        </select>
      </FieldRow>
      <FormActions
        busy={props.busy}
        submitLabel={initial ? '保存决策' : '创建决策'}
        onCancel={props.onCancel}
        onSubmit={submit}
      />
    </div>
  );
}
