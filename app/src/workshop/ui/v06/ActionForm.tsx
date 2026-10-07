import { useState } from 'react';
import type { ActionCardV5, Deck, FieldSpec } from '../../../workspace/v06.ts';
import type { Id } from '../../../workspace/index.ts';
import { FormActions, genId } from './EditorForms.tsx';

type Props = Readonly<{
  initial?: ActionCardV5;
  decks: readonly Deck[];
  busy: boolean;
  joinPending: boolean;
  onCancel: () => void;
  onSubmit: (draft: ActionCardV5, expectedVersion: number | null, deckId: Id | null) => void;
}>;

export function ActionForm({ initial, decks, busy, joinPending, onCancel, onSubmit }: Props) {
  const [id] = useState(() => initial?.id ?? genId());
  const [title, setTitle] = useState(initial?.content.title ?? '');
  const [criteria, setCriteria] = useState(initial?.content.criteria ?? '');
  const [minutes, setMinutes] = useState(
    initial ? (initial.content.presetMinutes?.toString() ?? '') : '30',
  );
  const [color, setColor] = useState(initial?.content.color ?? '#315e50');
  const [status, setStatus] = useState<ActionCardV5['status']>(initial?.status ?? 'active');
  const [fields, setFields] = useState<readonly FieldSpec[]>(initial?.fields ?? []);
  const [deckId, setDeckId] = useState<Id | null>(null);
  const [error, setError] = useState('');
  const locked = busy || joinPending;
  const changeField = (id: Id, patch: Partial<FieldSpec>) =>
    setFields((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  const submit = () => {
    const presetMinutes = minutes.trim() === '' ? null : Number(minutes);
    if (!title.trim()) {
      setError('请填写行动标题');
      return;
    }
    if (
      presetMinutes !== null &&
      (!Number.isSafeInteger(presetMinutes) ||
        presetMinutes <= 0 ||
        presetMinutes > 1440 ||
        presetMinutes % 5 !== 0)
    ) {
      setError('预设时长须为 5 到 1440 分钟，按 5 分钟递增；也可留空');
      return;
    }
    const normalized = fields.map((field) => ({ ...field, label: field.label.trim() }));
    if (
      normalized.some((field) => !field.label) ||
      new Set(normalized.map((field) => field.label)).size !== normalized.length
    ) {
      setError('预留字段名称不能为空或重复');
      return;
    }
    setError('');
    const content = {
      ...(initial?.content ?? {
        categoryId: null,
        categoryLabel: null,
        minimum: false,
        projectIds: [],
        goalIds: [],
        projectLabels: [],
        goalLabels: [],
      }),
      title: title.trim(),
      criteria,
      presetMinutes,
      color,
    };
    const draft: ActionCardV5 = {
      ...(initial ?? {
        id,
        version: 1,
        kind: 'action',
        parentId: null,
        source: { kind: 'manual' },
      }),
      content,
      fields: normalized,
      status,
    };
    onSubmit(draft, initial?.version ?? null, initial ? null : deckId);
  };
  return (
    <div className="we2-form">
      <h2>{initial ? '编辑行动' : '新建行动'}</h2>
      {error && <p role="alert">{error}</p>}
      <fieldset className="we2-attrs" disabled={locked}>
        <label className="we2-field">
          <span>行动标题</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="we2-field">
          <span>完成标准</span>
          <textarea value={criteria} onChange={(e) => setCriteria(e.target.value)} />
        </label>
        <label className="we2-field">
          <span>预设时长（分钟，可留空）</span>
          <input
            type="number"
            min={5}
            max={1440}
            step={5}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </label>
        <label className="we2-field">
          <span>行动颜色</span>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
        <label className="we2-field">
          <span>行动状态</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="active">启用</option>
            <option value="paused">暂停</option>
            <option value="archived">归档</option>
          </select>
        </label>
        {!initial && (
          <label className="we2-field">
            <span>加入行动牌堆（可选）</span>
            <select value={deckId ?? ''} onChange={(e) => setDeckId(e.target.value || null)}>
              <option value="">（仅创建，暂不加入牌堆）</option>
              {decks
                .filter((d) => d.deckKind === 'action')
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </label>
        )}
      </fieldset>
      <fieldset className="we2-attrs" disabled={locked}>
        <legend>预留字段</legend>
        <p className="we2-hint">
          标题或完成标准中用 {'{字段名称}'} 引用。修改已用于决策的字段时，请保留对应字段。
        </p>
        {fields.map((field, index) => (
          <div className="we2-map-row" key={field.id}>
            <input
              aria-label={`字段 ${index + 1} 名称`}
              value={field.label}
              onChange={(e) => changeField(field.id, { label: e.target.value })}
            />
            <select
              aria-label={`字段 ${index + 1} 类型`}
              value={field.valueType}
              onChange={(e) =>
                changeField(field.id, { valueType: e.target.value as FieldSpec['valueType'] })
              }
            >
              <option value="text">文本</option>
              <option value="number">数字</option>
              <option value="boolean">是非</option>
            </select>
            <label>
              <input
                type="checkbox"
                checked={field.required}
                onChange={(e) => changeField(field.id, { required: e.target.checked })}
              />
              必填
            </label>
            <button
              type="button"
              className="we2-btn tiny"
              onClick={() => setFields((rows) => rows.filter((row) => row.id !== field.id))}
            >
              删除字段
            </button>
          </div>
        ))}
        <button
          type="button"
          className="we2-btn tiny"
          onClick={() =>
            setFields((rows) => [
              ...rows,
              { id: genId(), label: '', valueType: 'text', required: false },
            ])
          }
        >
          ＋ 添加字段
        </button>
      </fieldset>
      <FormActions
        busy={busy}
        submitLabel={initial ? '保存行动' : '创建行动'}
        onCancel={onCancel}
        onSubmit={submit}
      />
    </div>
  );
}
