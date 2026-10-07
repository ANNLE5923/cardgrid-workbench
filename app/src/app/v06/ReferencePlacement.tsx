import { useEffect, useRef, useState } from 'react';
import type { V06Host, Token, VersionRef } from '../../workspace/index.ts';
import type { DataV5, ReferenceDraft } from '../../workspace/v06.ts';
import type { DayBoardView } from '../../daily/index.ts';

type Props = Readonly<{
  host: V06Host;
  data: DataV5;
  view: DayBoardView;
  answer: VersionRef & Readonly<{ token: Token }>;
  busy: boolean;
  onMessage: (message: string) => void;
  onSubmit: (command: Parameters<V06Host['submit']>[0]) => Promise<boolean>;
  onClose: () => void;
}>;

/** A preview belongs to one form revision; edits, cancellation and unmount
 * invalidate it before a pending request can return. */
export function ReferencePlacement({
  host,
  data,
  view,
  answer,
  busy,
  onMessage,
  onSubmit,
  onClose,
}: Props) {
  const material = data.handCards.find((c) => c.id === answer.id && c.version === answer.version);
  const owner = material?.kind === 'answer' ? material.answer.ownerAction : null;
  const candidates = data.planner.plans.filter(
    (p) =>
      p.status === 'active' &&
      data.handCards.some(
        (c) =>
          (c.kind === 'action' || c.kind === 'composite') &&
          c.actionInstanceId === p.instanceId &&
          c.ownerAction.id === owner?.id &&
          c.ownerAction.version === owner?.version,
      ),
  );
  const [mode, setMode] = useState<'attached' | 'point'>('attached');
  const [target, setTarget] = useState(candidates.length === 1 ? candidates[0].instanceId : '');
  const [point, setPoint] = useState('09:00');
  const [offset, setOffset] = useState('');
  const [preview, setPreview] = useState<Awaited<ReturnType<V06Host['previewReference']>> | null>(
    null,
  );
  const [reading, setReading] = useState(false);
  const generation = useRef(0);
  useEffect(
    () => () => {
      ++generation.current;
    },
    [],
  );
  const cancelGrant = (result: typeof preview) => {
    if (result?.ok)
      void host
        .cancelPreview({ token: result.value.token, previewId: result.value.previewId })
        .catch(() => {});
  };
  const invalidate = () => {
    ++generation.current;
    cancelGrant(preview);
    setPreview(null);
    setReading(false);
  };
  const readPreview = async () => {
    invalidate();
    const seq = generation.current;
    const instance = candidates.some((p) => p.instanceId === target)
      ? data.planner.instances.find((i) => i.id === target)
      : undefined;
    if (mode === 'attached' && !instance) {
      onMessage('请选择已安排的相关行动');
      return;
    }
    const draft: ReferenceDraft =
      mode === 'attached'
        ? {
            answer: { id: answer.id, version: answer.version },
            mode,
            instance: { id: instance!.id, version: instance!.version },
          }
        : {
            answer: { id: answer.id, version: answer.version },
            mode,
            local: { date: view.date, time: point, zone: view.zone, ...(offset ? { offset } : {}) },
          };
    setReading(true);
    try {
      const result = await host.previewReference({ token: answer.token, draft });
      if (seq !== generation.current) {
        cancelGrant(result);
        return;
      }
      setPreview(result);
      if (!result.ok) onMessage(result.message);
    } catch (error) {
      if (seq === generation.current)
        onMessage(error instanceof Error ? error.message : '参考预览未完成');
    } finally {
      if (seq === generation.current) setReading(false);
    }
  };
  return (
    <section role="dialog" aria-modal="false" aria-label="放置答案参考">
      <h2>放置答案参考</h2>
      <label>
        位置
        <select
          aria-label="位置"
          disabled={busy}
          value={mode}
          onChange={(e) => {
            invalidate();
            setMode(e.target.value as typeof mode);
          }}
        >
          <option value="attached">贴在相关行动旁</option>
          <option value="point">独立参考时点</option>
        </select>
      </label>
      {mode === 'attached' ? (
        <label>
          已安排行动
          <select
            aria-label="已安排行动"
            disabled={busy}
            value={target}
            onChange={(e) => {
              invalidate();
              setTarget(e.target.value);
            }}
          >
            <option value="">请选择相关行动</option>
            {candidates.map((p) => (
              <option key={p.id} value={p.instanceId}>
                {p.contentSnapshot.title} · {p.id}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label>
            当地时点
            <input
              disabled={busy}
              type="time"
              step={300}
              value={point}
              onChange={(e) => {
                invalidate();
                setPoint(e.target.value);
              }}
            />
          </label>
          <label>
            重复时段的时区偏移（如 -04:00，可留空）
            <input
              disabled={busy}
              value={offset}
              onChange={(e) => {
                invalidate();
                setOffset(e.target.value);
              }}
            />
          </label>
        </>
      )}
      <button disabled={busy || reading} onClick={() => void readPreview()}>
        预览参考
      </button>
      {preview?.ok && (
        <>
          <p>占用 0 分钟，确认后保存位置。</p>
          <button
            disabled={busy || reading}
            onClick={() => {
              void onSubmit({
                contractVersion: 'v06-p0-1',
                commandId: crypto.randomUUID(),
                expected: preview.value.token,
                type: 'CommitReferencePlacement',
                payload: { previewId: preview.value.previewId },
              }).then((ok) => {
                if (ok) {
                  invalidate();
                  onClose();
                }
              });
            }}
          >
            确认放置参考
          </button>
        </>
      )}
      <button
        disabled={busy}
        onClick={() => {
          invalidate();
          onClose();
        }}
      >
        取消参考
      </button>
    </section>
  );
}
