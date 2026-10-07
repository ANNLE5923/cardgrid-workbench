// A3 three-slot synthesis bench (contract 5.4, P06/P07). Slot 1 takes an
// available action/composite material, slot 2 an available same-owner answer;
// slot 3 previews the composite. Previewing never consumes; only an explicit
// confirm atomically replaces the two inputs with one composite (in-memory host
// in this milestone; the formal rule/command ship in B2/B4).
import { useEffect, useState } from 'react';
import type {
  FieldResolution,
  HandCard,
  Scalar,
  SynthesisPreview,
} from '../../../workspace/v06.ts';
import type { Id } from '../../../workspace/index.ts';
import type { CatalogEditorHost } from '../../catalog-editor.ts';

type ActionMaterialCard = Extract<HandCard, { kind: 'action' | 'composite' }>;
type AnswerMaterialCard = Extract<HandCard, { kind: 'answer' }>;

export const cardLabel = (c: HandCard): string => {
  if (c.kind === 'action' || c.kind === 'composite') return `行动：${c.contentSnapshot.title}`;
  if (c.kind === 'answer') return `答案：${c.answer.entry.title}`;
  return `条目：${c.entrySnapshot.title}`;
};
const scalarText = (v: Scalar): string => {
  if (v === null) return '（空）';
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
};

export function SynthesisBenchV06(
  props: Readonly<{
    host: CatalogEditorHost;
    onHandChanged: () => Promise<void>;
    onExit: () => void;
  }>,
) {
  const { host } = props;
  const [cards, setCards] = useState<readonly HandCard[]>([]);
  const [slotA, setSlotA] = useState<Id | ''>('');
  const [slotB, setSlotB] = useState<Id | ''>('');
  const [resolutions, setResolutions] = useState<readonly FieldResolution[]>([]);
  const [preview, setPreview] = useState<SynthesisPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const reloadHand = async () => {
    const r = await host.readHand();
    if (r.ok) setCards(r.value.data.map((i) => i.card));
  };
  useEffect(() => {
    reloadHand();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const actionCards = cards.filter(
    (c): c is ActionMaterialCard =>
      (c.kind === 'action' || c.kind === 'composite') && c.state === 'available',
  );
  const answerCards = cards.filter(
    (c): c is AnswerMaterialCard => c.kind === 'answer' && c.state === 'available',
  );

  // Recompute the preview whenever slots or resolutions change.
  useEffect(() => {
    let cancelled = false;
    if (!slotA || !slotB) {
      setPreview(null);
      return;
    }
    const a = cards.find((c) => c.id === slotA);
    const b = cards.find((c) => c.id === slotB);
    if (!a || !b) return;
    setBusy(true);
    setError('');
    host
      .previewSynthesis({
        inputs: [
          { id: a.id, version: a.version },
          { id: b.id, version: b.version },
        ],
        resolutions,
      })
      .then((r) => {
        if (cancelled) return;
        setBusy(false);
        if (r.ok) setPreview(r.value);
        else setError(`（${r.code}）${r.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [slotA, slotB, resolutions, cards, host]);

  const pick = (which: 'a' | 'b', id: Id | '') => {
    setError('');
    setDone('');
    setPreview(null);
    setResolutions([]);
    if (which === 'a') setSlotA(id);
    else setSlotB(id);
  };
  const chooseResolution = (fieldId: Id, choice: 'keep' | 'replace') => {
    setError('');
    setDone('');
    setResolutions((prev) => [...prev.filter((r) => r.fieldId !== fieldId), { fieldId, choice }]);
  };
  const reset = () => {
    setSlotA('');
    setSlotB('');
    setResolutions([]);
    setPreview(null);
    setError('');
    setDone('');
  };

  const confirm = async () => {
    if (!preview || !preview.ready || busy) return;
    setBusy(true);
    setError('');
    setDone('');
    const r = await host.confirmSynthesis({ previewId: preview.previewId });
    setBusy(false);
    if (!r.ok) {
      setError(`（${r.code}）${r.message}`);
      return;
    }
    await reloadHand();
    await props.onHandChanged();
    setDone('合成完成：两张素材已被一张成品替代；工坊原卡保留，可再次拿牌或继续分步合成。');
    setSlotA('');
    setSlotB('');
    setResolutions([]);
    setPreview(null);
  };

  const actionChosen = cards.find((c) => c.id === slotA);
  const fieldLabel = (fieldId: Id): string =>
    actionChosen && (actionChosen.kind === 'action' || actionChosen.kind === 'composite')
      ? (actionChosen.fieldSpecs.find((s) => s.id === fieldId)?.label ?? fieldId)
      : fieldId;
  const choiceOf = (fieldId: Id): 'keep' | 'replace' | '' =>
    resolutions.find((r) => r.fieldId === fieldId)?.choice ?? '';

  const hasMaterials = actionCards.length > 0 || answerCards.length > 0;

  const renderSlotSelect = (
    label: string,
    chosen: Id | '',
    options: readonly HandCard[],
    empty: string,
    onChange: (id: Id | '') => void,
  ) => (
    <div className="we3-slot-wrap">
      <span className="we3-slot-label">{label}</span>
      <div className={`we3-slot${chosen ? ' is-filled' : ''}`}>
        {chosen ? (
          <div className="we3-slot-card">
            <strong>
              {cards.find((c) => c.id === chosen)
                ? cardLabel(cards.find((c) => c.id === chosen)!)
                : ''}
            </strong>
          </div>
        ) : (
          <span className="we3-slot-empty">空槽</span>
        )}
      </div>
      <select
        aria-label={label}
        value={chosen}
        onChange={(e) => onChange(e.target.value as Id | '')}
      >
        <option value="">{options.length ? '选择本次素材…' : empty}</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {cardLabel(c)}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="we3">
      {!hasMaterials ? (
        <div className="we3-empty panel">
          <p>手牌中还没有可合成的本次素材。</p>
          <p className="we2-muted">
            请先在矩阵“直接拿牌”得到行动素材，并接受一张同归属的答案素材，再开始合成。
          </p>
        </div>
      ) : null}

      <div className="we3-bench">
        {renderSlotSelect('槽 1 · 本次行动', slotA, actionCards, '暂无行动素材', (id) =>
          pick('a', id),
        )}
        <span className="we3-op">＋</span>
        {renderSlotSelect('槽 2 · 本次答案', slotB, answerCards, '暂无答案素材', (id) =>
          pick('b', id),
        )}
        <span className="we3-op">＝</span>
        <div className="we3-slot-wrap">
          <span className="we3-slot-label">槽 3 · 预览成品</span>
          <div className={`we3-slot we3-result${preview && preview.ready ? ' is-filled' : ''}`}>
            {preview ? (
              <div className="we3-slot-card">
                <strong>{cardLabel(preview.output)}</strong>
                <small>{preview.ready ? '可确认' : '待补全'}</small>
              </div>
            ) : (
              <span className="we3-slot-empty">放入两张素材后预览</span>
            )}
          </div>
          <span className="we3-slot-placeholder" />
        </div>
      </div>

      {preview ? (
        <div className="we3-preview panel">
          <h2>成品预览（尚未写入，预览不消耗素材）</h2>
          <ul className="we3-fields">
            {preview.output.fieldValues.map((f) => (
              <li key={f.fieldId} className={f.value === null ? 'is-null' : ''}>
                <span>{fieldLabel(f.fieldId)}</span>
                <b>{scalarText(f.value)}</b>
              </li>
            ))}
          </ul>

          {preview.conflicts.length ? (
            <div className="we3-conflicts">
              <h3>同字段冲突：请逐字段明确选择（默认不静默覆盖）</h3>
              {preview.conflicts.map((c) => (
                <div key={c.fieldId} className="we3-conflict-row">
                  <div className="we3-conflict-head">
                    <strong>{fieldLabel(c.fieldId)}</strong>
                    <span>
                      原值 {scalarText(c.previous)} ｜ 新值 {scalarText(c.incoming)}
                    </span>
                  </div>
                  <label className="we3-radio">
                    <input
                      type="radio"
                      name={`conflict-${c.fieldId}`}
                      checked={choiceOf(c.fieldId) === 'keep'}
                      onChange={() => chooseResolution(c.fieldId, 'keep')}
                    />{' '}
                    保留原值
                  </label>
                  <label className="we3-radio">
                    <input
                      type="radio"
                      name={`conflict-${c.fieldId}`}
                      checked={choiceOf(c.fieldId) === 'replace'}
                      onChange={() => chooseResolution(c.fieldId, 'replace')}
                    />{' '}
                    采用新值
                  </label>
                </div>
              ))}
            </div>
          ) : null}

          {preview.missingFieldIds.length ? (
            <div className="we3-missing" role="alert">
              待补全：必填字段{' '}
              {preview.missingFieldIds.map((id) => `「${fieldLabel(id)}」`).join('、')} 仍为空。
              该中间结果不能在 Today 打出；可保留手牌，后续分步补全。
            </div>
          ) : null}

          <p className="we3-source-line">
            来源素材：{preview.output.inputIds.length ? preview.output.inputIds.join('、') : '—'}
            ；到期：{preview.output.expiresAt ?? '无（常驻）'}
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="we3-error" role="alert">
          {error}
        </div>
      ) : null}
      {done ? (
        <div className="we3-done" role="status">
          {done}
        </div>
      ) : null}

      <div className="we3-actions toolbar">
        <button
          type="button"
          className="primary"
          onClick={confirm}
          disabled={!preview || !preview.ready || busy}
        >
          {busy ? '处理中…' : '确认合成'}
        </button>
        <button type="button" onClick={reset} disabled={busy}>
          取消／清空（保留素材）
        </button>
        <button type="button" onClick={props.onExit} disabled={busy}>
          返回矩阵
        </button>
      </div>
    </div>
  );
}
