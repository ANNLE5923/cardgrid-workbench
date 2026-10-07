import type { V06JournalSession, V06JournalState } from '../../journal/index.ts';
import { dateAt } from '../../daily/time.ts';
import './v06-journal.css';

const saveLabels: Record<V06JournalState['status'], string> = {
  loading: '正在读取',
  idle: '尚无未保存修改',
  dirty: '草稿待保存',
  saving: '正在保存',
  saved: '已保存到本机',
  error: '保存未完成，草稿保留',
};
const segmentLabels = { planned: '计划', confirmed: '已确认事实', fixed: '固定安排' };
const timestamp = (at: string, zone: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).format(new Date(at));

/** B-owned view of the authoritative session; A6's isolated sample is retained. */
export function V06JournalView({
  journal,
  session,
  archived,
  future,
}: Readonly<{
  journal: V06JournalState;
  session: V06JournalSession;
  archived: boolean;
  future: boolean;
}>) {
  const readOnly = archived || future;
  return (
    <section className="v06-journal" aria-label="时间线日记">
      <h2>时间线日记</h2>
      <label>
        归属日
        <input
          type="date"
          value={journal.date}
          onChange={(e) => {
            if (e.target.value) void session.changeDay(e.target.value);
          }}
        />
      </label>
      <p>查看时区：{journal.zone}。自动段来自表盘；随记独立保存。</p>
      <p role="status">随记保存：{saveLabels[journal.status]}</p>
      {future && <p>未来日期只读；可在当天记录或补记过去日期。</p>}
      {archived && <p>已归档日期只读；完整历史需要匹配的 ZIP，可在备份与恢复页查看。</p>}
      {journal.error && <p role="alert">{journal.error}</p>}
      <div className="v06-journal-timeline" aria-label="自动段与随记">
        {journal.projection?.rows.map((row) => (
          <article key={row.id} data-journal-row={row.kind} data-row-id={row.id}>
            {row.kind === 'automatic' ? (
              <>
                <h3>
                  {row.segment.title} · {segmentLabels[row.segment.status]}
                </h3>
                <p>
                  <time dateTime={row.segment.clippedRange.startAt}>
                    {row.segment.clippedRange.localStart} {row.segment.clippedRange.startOffset}
                  </time>{' '}
                  —{' '}
                  <time dateTime={row.segment.clippedRange.endAt}>
                    {row.segment.clippedRange.localEnd} {row.segment.clippedRange.endOffset}
                  </time>{' '}
                  · {row.segment.clippedRange.zone}
                </p>
                {(row.segment.range.startAt !== row.segment.clippedRange.startAt ||
                  row.segment.range.endAt !== row.segment.clippedRange.endAt) && (
                  <p>
                    完整安排：{row.segment.range.localStart} — {row.segment.range.localEnd}
                  </p>
                )}
                {row.segment.referenceAnswers.map((answer, i) => (
                  <p key={i}>
                    参考：{answer.question} · {answer.entry.title}
                  </p>
                ))}
              </>
            ) : row.kind === 'reference' ? (
              <>
                <h3>独立参考 · 0 分钟</h3>
                <p>
                  {row.point.localTime} {row.point.offset} · {row.point.zone} ·{' '}
                  {row.answer.question}：{row.answer.entry.title}
                </p>
              </>
            ) : (
              <>
                <h3>独立感想</h3>
                <p>
                  {dateAt(row.note.recordedAt, row.note.zone) !== row.note.date
                    ? '补记于'
                    : '记录于'}{' '}
                  <time dateTime={row.note.recordedAt}>
                    {timestamp(row.note.recordedAt, row.note.zone)}
                  </time>{' '}
                  · {row.note.zone}
                </p>
                {row.note.updatedAt !== row.note.recordedAt && (
                  <p>
                    修改于{' '}
                    <time dateTime={row.note.updatedAt}>
                      {timestamp(row.note.updatedAt, row.note.zone)}
                    </time>
                  </p>
                )}
                <p className="v06-journal-text">
                  {row.note.text || '（感想已清空，原时间与历史仍保留）'}
                </p>
                <button
                  disabled={readOnly}
                  onClick={() =>
                    void session.select({
                      kind: 'note',
                      id: row.note.id,
                      version: row.note.version,
                    })
                  }
                >
                  编辑感想
                </button>
              </>
            )}
          </article>
        ))}
      </div>
      {journal.projection?.plannedComparisons.map((item) => (
        <p key={item.sourceKey}>
          原计划：{item.clippedRange.localStart} — {item.clippedRange.localEnd}；实际：
          {item.actualRange.localStart} — {item.actualRange.localEnd}
        </p>
      ))}
      <label>
        {journal.target?.kind === 'legacy' ? '旧正文' : '独立感想'}
        <textarea
          rows={5}
          readOnly={readOnly}
          aria-label="独立感想"
          value={journal.text}
          onChange={(e) => session.edit(e.target.value)}
          onBlur={() => void session.flush()}
        />
      </label>
      <div className="v06-journal-actions">
        <button disabled={readOnly} onClick={() => void session.flush()}>
          立即保存
        </button>
        <button disabled={readOnly} onClick={() => void session.select(null)}>
          新建感想
        </button>
        <button onClick={() => session.discardDraft()}>丢弃当前草稿</button>
      </div>
      {journal.projection?.timeline.legacyBlocks.map((block) => (
        <article key={block.id}>
          <h3>历史正文 {block.date}</h3>
          <p>
            原记录于 {timestamp(block.createdAt, block.zone)} · {block.zone}
          </p>
          {block.updatedAt !== block.createdAt && (
            <p>修改于 {timestamp(block.updatedAt, block.zone)}</p>
          )}
          <pre className="v06-journal-text">{block.text}</pre>
          <button
            disabled={readOnly}
            onClick={() =>
              void session.select({ kind: 'legacy', id: block.id, version: block.version })
            }
          >
            编辑历史正文
          </button>
        </article>
      ))}
    </section>
  );
}
