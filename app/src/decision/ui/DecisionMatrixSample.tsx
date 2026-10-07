// A0 决策矩阵样稿：明确触发抽取后翻出答案（P03）；支持重抽、手选、取消（零新增）。
// 两种接受路径（P08/5.3）：“只取答案”与“同时拿行动牌”；答案在刷新后不重新随机。
import { useEffect, useState } from 'react';
import { SAMPLE_QUESTIONS, type SampleAnswer, type SampleQuestionId } from './sample-data.ts';
import './decision-sample.css';

export type DecisionMatrixSampleProps = Readonly<{
  questionId: SampleQuestionId;
  onAcceptAnswer?: (answer: SampleAnswer, withAction: boolean) => void;
}>;

type Phase = 'question' | 'revealed';

export function DecisionMatrixSample(props: DecisionMatrixSampleProps) {
  const { questionId, onAcceptAnswer } = props;
  const question = SAMPLE_QUESTIONS.find((q) => q.id === questionId)!;
  const [phase, setPhase] = useState<Phase>('question');
  const [drawCount, setDrawCount] = useState(0);
  const [showManual, setShowManual] = useState(false);
  const [accepted, setAccepted] = useState(false);

  // 切换问题即回到正面，答案不跨问题携带。
  useEffect(() => {
    setPhase('question');
    setDrawCount(0);
    setShowManual(false);
    setAccepted(false);
  }, [questionId]);

  const candidate = question.candidates[drawCount % question.candidates.length];
  const answer: SampleAnswer = {
    candidateId: candidate.id,
    name: candidate.name,
    detail: candidate.detail,
    question: question.question,
    actionName: question.actionName,
    source: question.deckName,
  };

  const draw = () => {
    setAccepted(false);
    setShowManual(false);
    setPhase('revealed');
  };
  const redraw = () => {
    setAccepted(false);
    setDrawCount((n) => n + 1);
    setPhase('revealed');
  };
  const chooseManual = (index: number) => {
    setDrawCount(index);
    setAccepted(false);
    setShowManual(false);
    setPhase('revealed');
  };
  const cancel = () => {
    setPhase('question');
    setShowManual(false);
    setAccepted(false);
  };
  const accept = (withAction: boolean) => {
    if (accepted) return;
    onAcceptAnswer?.(answer, withAction);
    setAccepted(true);
  };

  return (
    <div className="dc6">
      <div className="dc6-stage">
        <div className={`dc6-flip ${phase === 'revealed' ? 'is-revealed' : ''}`}>
          <div className="dc6-inner">
            {/* 正面：问题 */}
            <div className="dc6-face dc6-front">
              <span className="dc6-mark">？</span>
              <h2>{question.question}</h2>
              <p>
                候选 {question.candidates.length} 个 · 来自「{question.deckName}」
              </p>
            </div>
            {/* 背面：抽取前只渲染静态卡背，答案文本不进入 DOM，避免提前剧透；抽取后才出现 */}
            <div className="dc6-face dc6-back">
              {phase === 'revealed' ? (
                <>
                  <span className="dc6-source">答案 · 来自「{answer.source}」</span>
                  <strong>{answer.name}</strong>
                  {answer.detail ? <small>{answer.detail}</small> : null}
                  <p className="dc6-stable">答案已固定：刷新或导航不会重新抽取</p>
                </>
              ) : (
                <span className="dc6-back-pattern">答</span>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="dc6-controls toolbar">
        {phase === 'question' ? (
          <>
            <button type="button" className="primary" onClick={draw}>
              翻牌抽取
            </button>
            <button type="button" onClick={() => setShowManual((v) => !v)}>
              手选候选
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={redraw}>
              重抽
            </button>
            <button type="button" onClick={() => setShowManual((v) => !v)}>
              手选候选
            </button>
            <button type="button" onClick={cancel}>
              取消
            </button>
            <span className="dc6-spacer" />
            <button
              type="button"
              className="primary"
              onClick={() => accept(false)}
              disabled={accepted}
            >
              只取答案
            </button>
            <button type="button" onClick={() => accept(true)} disabled={accepted}>
              同时拿行动牌：{question.actionName}
            </button>
          </>
        )}
      </div>

      {accepted ? (
        <div className="dc6-note" role="status">
          已加入右下角手牌（样稿模拟）；不会重复加入。
        </div>
      ) : null}

      {showManual ? (
        <div className="dc6-manual panel">
          <div className="dc6-manual-head">
            <h2>手选：{question.question}</h2>
            <button type="button" aria-label="关闭手选" onClick={() => setShowManual(false)}>
              ×
            </button>
          </div>
          <ul className="dc6-candidates">
            {question.candidates.map((c, index) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={phase === 'revealed' && c.id === candidate.id ? 'is-chosen' : ''}
                  onClick={() => chooseManual(index)}
                >
                  <span>{c.name}</span>
                  {c.detail ? <small>{c.detail}</small> : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
