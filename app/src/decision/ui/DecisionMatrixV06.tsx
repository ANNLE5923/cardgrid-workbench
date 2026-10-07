// A4 decision matrix (contract 5.3, P03). Shows the question face; an explicit
// draw flips to a fixed answer. Redraw/manual/cancel are supported; rendering,
// navigation and reopening never re-draw. All randomization and writes go
// through the injected DecisionSessionPort — the component never calls
// Math.random or mutates the catalog. Two accept paths: answer only, or answer
// plus the owner action. Before a draw the answer is not in the DOM.
import { useEffect, useRef, useState } from 'react';
import type { DecisionCard, Scalar } from '../../workspace/v06.ts';
import type { Id } from '../../workspace/index.ts';
import type {
  AcceptDecisionAnswerResult,
  DecisionDrawPreview,
  DecisionSessionPort,
} from './decision-session.ts';
import './decision-matrix-v06.css';

type Phase = 'question' | 'revealed';
const scalarText = (v: Scalar): string => {
  if (v === null) return '（空）';
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
};

export function DecisionMatrixV06(
  props: Readonly<{
    port: DecisionSessionPort;
    decision: DecisionCard;
    onAccepted?: (result: AcceptDecisionAnswerResult, withAction: boolean) => void;
    onExit?: () => void;
  }>,
) {
  const { port, decision } = props;
  const [candidates, setCandidates] = useState<
    readonly { entry: { id: Id; version: number }; title: string }[]
  >([]);
  const [phase, setPhase] = useState<Phase>('question');
  const [preview, setPreview] = useState<DecisionDrawPreview | null>(null);
  const [showManual, setShowManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState(false);
  const generation = useRef(0),
    locked = useRef(false);

  // On open / decision change: load effective candidates, reset to the face.
  useEffect(() => {
    let cancelled = false;
    generation.current++;
    locked.current = true;
    setBusy(true);
    setCandidates([]);
    setPhase('question');
    setPreview(null);
    setShowManual(false);
    setError('');
    setAccepted(false);
    port
      .listDecisionCandidates({ decision: { id: decision.id, version: decision.version } })
      .then(async (r) => {
        if (cancelled) return;
        if (r.ok) {
          setCandidates(r.value.candidates);
          const remembered = await port.readDecisionDraw?.({
            decision: { id: decision.id, version: decision.version },
          });
          if (cancelled) return;
          if (remembered?.ok && remembered.value) {
            setPreview(remembered.value);
            setPhase('revealed');
          } else if (remembered && !remembered.ok)
            setError(`（${remembered.code}）${remembered.message}`);
        } else setError(`（${r.code}）${r.message}`);
        locked.current = false;
        setBusy(false);
      });
    return () => {
      cancelled = true;
      generation.current++;
    };
  }, [port, decision.id, decision.version]);

  const runDraw = async (
    choice: Parameters<DecisionSessionPort['previewDecisionDraw']>[0]['choice'],
  ) => {
    if (locked.current) return;
    locked.current = true;
    const request = generation.current;
    setBusy(true);
    setError('');
    const r = await port.previewDecisionDraw({
      decision: { id: decision.id, version: decision.version },
      choice,
    });
    if (request !== generation.current) return;
    locked.current = false;
    setBusy(false);
    if (!r.ok) {
      setError(`（${r.code}）${r.message}`);
      return;
    }
    setPreview(r.value);
    setPhase('revealed');
    setShowManual(false);
    setAccepted(false);
  };
  const cancel = async () => {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    const r = await port.cancelDecisionDraw?.();
    locked.current = false;
    setBusy(false);
    if (r && !r.ok) {
      setError(`（${r.code}）${r.message}`);
      return false;
    }
    setPhase('question');
    setPreview(null);
    setShowManual(false);
    setError('');
    setAccepted(false);
    return true;
  };

  const accept = async (alsoTakeAction: boolean) => {
    if (!preview || accepted || busy || locked.current) return;
    locked.current = true;
    const request = generation.current;
    setBusy(true);
    setError('');
    const r = await port.acceptDecisionAnswer({
      decision: { id: decision.id, version: decision.version },
      entry: { id: preview.selected.entry.id, version: preview.selected.entry.version },
      alsoTakeAction,
    });
    if (request !== generation.current) return;
    locked.current = false;
    setBusy(false);
    if (!r.ok) {
      setError(`（${r.code}）${r.message}`);
      return;
    }
    setAccepted(true);
    props.onAccepted?.(r.value, alsoTakeAction);
  };

  const noCandidates = candidates.length === 0;

  return (
    <div className="dm6">
      <div className="dm6-stage">
        <div className={`dm6-flip${phase === 'revealed' ? ' is-revealed' : ''}`}>
          <div className="dm6-inner">
            {/* Front: question */}
            <div className="dm6-face dm6-front">
              <span className="dm6-mark">？</span>
              <h2>{decision.question}</h2>
              {noCandidates ? (
                <p className="dm6-empty-hint">候选牌堆中没有可用条目，请先添加或解除归档</p>
              ) : (
                <p>
                  候选 {candidates.length} 个 · 来自 {decision.deckIds.length} 个牌堆
                </p>
              )}
            </div>
            {/* Back: static pattern until revealed, so the answer is not leaked. */}
            <div className="dm6-face dm6-back">
              {phase === 'revealed' && preview ? (
                <>
                  <span className="dm6-source">
                    答案 · 来自决策「{preview.selected.decision.id}」
                  </span>
                  <strong>{preview.selected.entry.title}</strong>
                  <ul className="dm6-values">
                    {preview.selected.fieldValues.map((f) => (
                      <li key={f.fieldId}>
                        <span>{f.fieldId}</span>
                        <b>{scalarText(f.value)}</b>
                      </li>
                    ))}
                  </ul>
                  <p className="dm6-stable">
                    答案已固定：刷新或导航不会重新抽取；重抽是一次新的选择
                  </p>
                </>
              ) : (
                <span className="dm6-back-pattern">答</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="dm6-controls toolbar">
        {phase === 'question' ? (
          <>
            <button
              type="button"
              className="primary"
              disabled={busy || noCandidates}
              onClick={() => runDraw({ kind: 'random' })}
            >
              翻牌抽取
            </button>
            <button
              type="button"
              disabled={busy || noCandidates}
              onClick={() => setShowManual((v) => !v)}
            >
              手选候选
            </button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => runDraw({ kind: 'random' })}>
              重抽
            </button>
            <button type="button" disabled={busy} onClick={() => setShowManual((v) => !v)}>
              手选候选
            </button>
            <button type="button" disabled={busy} onClick={cancel}>
              取消
            </button>
            <span className="dm6-spacer" />
            <button
              type="button"
              className="primary"
              disabled={busy || accepted}
              onClick={() => accept(false)}
            >
              只取答案
            </button>
            <button type="button" disabled={busy || accepted} onClick={() => accept(true)}>
              同时拿行动牌
            </button>
          </>
        )}
        {props.onExit ? (
          <button
            type="button"
            className="dm6-exit"
            disabled={busy}
            onClick={async () => {
              if (await cancel()) props.onExit?.();
            }}
          >
            退出
          </button>
        ) : null}
      </div>

      {accepted ? (
        <div className="dm6-note" role="status">
          已加入本次手牌；未接受前翻牌不会新增手牌，且不会重复加入。
        </div>
      ) : null}
      {error ? (
        <div className="dm6-error" role="alert">
          {error}
        </div>
      ) : null}

      {showManual ? (
        <div className="dm6-manual panel">
          <div className="dm6-manual-head">
            <h2>手选：{decision.question}</h2>
            <button type="button" aria-label="关闭手选" onClick={() => setShowManual(false)}>
              ×
            </button>
          </div>
          {candidates.length === 0 ? (
            <p className="dm6-empty-hint">暂无可用候选</p>
          ) : (
            <ul className="dm6-candidates">
              {candidates.map((c) => (
                <li key={c.entry.id}>
                  <button
                    type="button"
                    className={preview?.selected.entry.id === c.entry.id ? 'is-chosen' : ''}
                    disabled={busy}
                    onClick={() =>
                      runDraw({
                        kind: 'manual',
                        entry: { id: c.entry.id, version: c.entry.version },
                      })
                    }
                  >
                    <span>{c.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
