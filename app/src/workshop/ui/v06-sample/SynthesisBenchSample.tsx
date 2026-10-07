// A0 三槽合成台样稿（P06/P07，合同 5.4）：两张本次素材入槽，第三槽预览成品。
// 预览不消耗；确认才用一张成品替代两张本次牌，工坊原卡保留。演示字段冲突、取消与失败重试。
import { useEffect, useState } from 'react';
import type { SynthesisMaterial } from './synthesis-types.ts';
import './synthesis-sample.css';

export type { SynthesisMaterial, SynthesisProduct } from './synthesis-types.ts';

export type SynthesisBenchSampleProps = Readonly<{
  materials: readonly SynthesisMaterial[];
  onCommit?: (product: import('./synthesis-types.ts').SynthesisProduct) => void;
  onPrepareSamples?: () => void;
}>;

type SlotKind = 'action' | 'answer';

export function SynthesisBenchSample(props: SynthesisBenchSampleProps) {
  const { materials, onCommit, onPrepareSamples } = props;
  const [slots, setSlots] = useState<Readonly<Record<SlotKind, string | null>>>({
    action: null,
    answer: null,
  });
  const [conflict, setConflict] = useState(false);
  const [failNext, setFailNext] = useState(false);
  const [error, setError] = useState('');
  const [committed, setCommitted] = useState(false);

  // 浮窗中的素材被移除（如已被合成）时，清空对应槽位。
  useEffect(() => {
    const ids = new Set(materials.map((m) => m.instanceId));
    setSlots((prev) => ({
      action: prev.action && ids.has(prev.action) ? prev.action : null,
      answer: prev.answer && ids.has(prev.answer) ? prev.answer : null,
    }));
  }, [materials]);

  const findMaterial = (instanceId: string | null) =>
    instanceId ? (materials.find((m) => m.instanceId === instanceId) ?? null) : null;
  const actionMaterial = findMaterial(slots.action);
  const answerMaterial = findMaterial(slots.answer);
  const ready = actionMaterial !== null && answerMaterial !== null;

  const actionFields = actionMaterial?.fields ?? [];
  const answerFields = answerMaterial?.fields ?? [];
  // 同名字段冲突（合同 8：默认拒绝歧义）。
  const overlappingKeys = actionFields
    .map((f) => f.key)
    .filter((key) => answerFields.some((f) => f.key === key) || (conflict && key === '地点'));
  const blocked = ready && (overlappingKeys.length > 0 || conflict);

  const mergedFields = ready
    ? [
        ...actionFields.filter((f) => !overlappingKeys.includes(f.key)),
        ...answerFields.filter((f) => !overlappingKeys.includes(f.key)),
      ]
    : [];

  const pickSlot = (kind: SlotKind, instanceId: string) => {
    setError('');
    setCommitted(false);
    setSlots((prev) => ({ ...prev, [kind]: instanceId || null }));
  };
  const reset = () => {
    setSlots({ action: null, answer: null });
    setError('');
    setCommitted(false);
    setConflict(false);
    setFailNext(false);
  };

  const confirm = () => {
    if (!ready || blocked) return;
    if (failNext) {
      setFailNext(false);
      setError('写入未完成：本次操作已保留，可直接重试（样稿模拟）。');
      return;
    }
    onCommit?.({
      name: `${actionMaterial!.name} · ${answerMaterial!.name}`,
      source: `${actionMaterial!.source}；${answerMaterial!.source}`,
      fields: mergedFields,
      consumed: [actionMaterial!.instanceId, answerMaterial!.instanceId],
    });
    setCommitted(true);
    setError('');
  };

  const renderSlot = (kind: SlotKind, label: string, chosen: SynthesisMaterial | null) => {
    const pool = materials.filter((m) => m.kind === kind);
    return (
      <div className="syn6-slot-wrap">
        <span className="syn6-slot-label">{label}</span>
        <div className={`syn6-slot${chosen ? ' is-filled' : ''}`}>
          {chosen ? (
            <div className="syn6-slot-card">
              <strong>{chosen.name}</strong>
              <small>{chosen.source}</small>
            </div>
          ) : (
            <span className="syn6-slot-empty">空槽</span>
          )}
        </div>
        <select
          aria-label={label}
          value={chosen?.instanceId ?? ''}
          onChange={(e) => pickSlot(kind, e.target.value)}
        >
          <option value="">{pool.length ? '选择本次素材…' : '暂无可用素材'}</option>
          {pool.map((m) => (
            <option key={m.instanceId} value={m.instanceId}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
    );
  };

  const hasAnyMaterial = materials.length > 0;

  return (
    <div className="syn6">
      {!hasAnyMaterial ? (
        <div className="syn6-empty panel">
          <p>手牌中还没有可合成的本次素材。</p>
          <p className="ws6-muted">
            请先到工坊“直接拿牌”，或在决策页接受答案；也可一键准备样稿素材。
          </p>
          <button type="button" className="primary" onClick={onPrepareSamples}>
            一键准备两张样稿素材
          </button>
        </div>
      ) : null}

      <div className="syn6-bench">
        {renderSlot('action', '槽 1 · 本次行动', actionMaterial)}
        <span className="syn6-plus">＋</span>
        {renderSlot('answer', '槽 2 · 本次答案', answerMaterial)}
        <span className="syn6-equals">＝</span>
        <div className="syn6-slot-wrap">
          <span className="syn6-slot-label">槽 3 · 预览成品</span>
          <div className={`syn6-slot syn6-result${ready && !blocked ? ' is-filled' : ''}`}>
            {ready && !blocked ? (
              <div className="syn6-slot-card">
                <strong>
                  {actionMaterial!.name} · {answerMaterial!.name}
                </strong>
                <small>字段与来源见下方预览</small>
              </div>
            ) : (
              <span className="syn6-slot-empty">放入两张素材后预览</span>
            )}
          </div>
          <span className="syn6-slot-placeholder" />
        </div>
      </div>

      {ready ? (
        <div className="syn6-preview panel">
          <h2>成品预览（尚未写入）</h2>
          <ul className="syn6-fields">
            {mergedFields.map((f) => (
              <li key={f.key}>
                <span>{f.key}</span>
                <b>{f.value}</b>
              </li>
            ))}
          </ul>
          <p className="syn6-source-line">
            来源：{actionMaterial!.source}；{answerMaterial!.source}
          </p>
          {blocked ? (
            <div className="syn6-conflict" role="alert">
              字段冲突，已暂停确认：
              {[...new Set(overlappingKeys)].map((k) => `「${k}」同时来自行动与答案`).join('；')}
              。请明确选择后再继续（样稿中关闭“模拟冲突”即可解决）。
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="syn6-options">
        <label className="syn6-check">
          <input
            type="checkbox"
            checked={conflict}
            onChange={(e) => setConflict(e.target.checked)}
          />{' '}
          模拟同字段冲突
        </label>
        <label className="syn6-check">
          <input
            type="checkbox"
            checked={failNext}
            onChange={(e) => setFailNext(e.target.checked)}
          />{' '}
          下次确认时模拟失败
        </label>
      </div>

      {error ? (
        <div className="syn6-error" role="alert">
          {error}
        </div>
      ) : null}
      {committed ? (
        <div className="syn6-done" role="status">
          合成完成：两张本次牌已被一张成品替代并进入手牌；工坊原卡仍保留，可再次拿牌。
        </div>
      ) : null}

      <div className="syn6-actions toolbar">
        <button
          type="button"
          className="primary"
          onClick={confirm}
          disabled={!ready || blocked || committed}
        >
          确认合成
        </button>
        <button type="button" onClick={reset} disabled={committed}>
          取消／清空
        </button>
        {committed ? (
          <button type="button" onClick={reset}>
            再合一次
          </button>
        ) : null}
      </div>
    </div>
  );
}
