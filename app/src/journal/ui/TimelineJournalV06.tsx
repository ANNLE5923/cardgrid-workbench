// A6 timeline journal (v0.6). Automatic behavior segments are projected from
// the dial (B3 projectJournalTimeline) and interleaved with independent
// reflections by time. Reflections keep their original recorded time and gain
// an updated-time marker on edit; retracting a dial segment never removes a
// reflection; sleep is read from the dial. File state comes from the injected
// session. Live dates are editable; monthly archives are read-only. Dial
// place/move/retract controls appear only under the test adapter.
import { useCallback, useEffect, useState } from 'react';
import { displayInstant } from '../../daily/time.ts';
import type { JournalNote } from '../../workspace/v06.ts';
import type { Id } from '../../workspace/index.ts';
import type { JournalRow } from '../model.ts';
import type {
  JournalFileState,
  JournalSessionPort,
  JournalTimelineView,
} from './journal-session.ts';
import './timeline-journal-v06.css';

const DEFAULT_DATE = '2026-10-06';
const DEFAULT_ZONE = 'Asia/Shanghai';
const ARCHIVE_DATE = '2026-09-30';

// Structural subset of the test adapter's dial controls (defined in tests), so
// this production file never imports test code. Only invoked for the test stamp.
type DialTestControls = Readonly<{
  moveBreakfastTo10(): void;
  retractBreakfast(): void;
  restoreBreakfast(): void;
  setFileStatus(status: 'error' | 'permission-required'): JournalFileState;
}>;

const statusLabel = (s: 'planned' | 'fixed' | 'confirmed'): string =>
  s === 'confirmed' ? '已确认事实' : s === 'planned' ? '计划' : '固定安排';

export function TimelineJournalV06(props: Readonly<{ session: JournalSessionPort }>) {
  const { session } = props;
  const isTest = session.stamp.backend === 'test-adapter';
  const [date, setDate] = useState(DEFAULT_DATE);
  const [zone, setZone] = useState(DEFAULT_ZONE);
  const [view, setView] = useState<JournalTimelineView | null>(null);
  const [file, setFile] = useState<JournalFileState | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: Id; text: string; version: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(
    async (d: string, z: string) => {
      const t = await session.readTimeline({ date: d, zone: z });
      if (t.ok) setView(t.value);
      else setFormError(t.message);
      const f = await session.readFileState({ date: d, zone: z });
      if (f.ok) setFile(f.value);
    },
    [session],
  );
  useEffect(() => {
    load(date, zone);
  }, [load, date, zone]);

  const editable = view?.editable === true;

  const addNote = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setFormError('');
    const r = await session.saveNote({ id: null, date, zone, text, expectedVersion: null });
    setBusy(false);
    if (!r.ok) {
      setFormError(`（${r.code}）${r.message}`);
      return;
    }
    setDraft('');
    await load(date, zone);
  };

  const saveEdit = async () => {
    if (!editing || busy) return;
    setBusy(true);
    setFormError('');
    const r = await session.saveNote({
      id: editing.id,
      date,
      zone,
      text: editing.text,
      expectedVersion: editing.version,
    });
    setBusy(false);
    if (!r.ok) {
      setFormError(`（${r.code}）${r.message}`);
      return;
    }
    setEditing(null);
    await load(date, zone);
  };

  const runFile = async (kind: 'write' | 'retry' | 'reauth') => {
    setBusy(true);
    const r =
      kind === 'write'
        ? await session.writeFileNow({ date, zone })
        : kind === 'retry'
          ? await session.retryFile({ date, zone })
          : await session.reauthorizeFile({ date, zone });
    setBusy(false);
    if (!r.ok) {
      setFormError(`（${r.code}）${r.message}`);
      return;
    }
    setFile(r.value);
    if (kind === 'reauth') {
      const w = await session.writeFileNow({ date, zone });
      if (w.ok) setFile(w.value);
    }
  };

  // Test-only dial mutation, then re-project.
  const dialAction = async (
    action: 'moveBreakfastTo10' | 'retractBreakfast' | 'restoreBreakfast',
  ) => {
    const dial = session as unknown as DialTestControls;
    dial[action]();
    await load(date, zone);
  };
  // Test-only file fault injection; the adapter returns the new state so React
  // re-renders (mutating the adapter's map alone would not refresh the UI).
  const applyTestFileStatus = (status: 'error' | 'permission-required') => {
    const dial = session as unknown as DialTestControls;
    setFile(dial.setFileStatus(status));
  };

  const renderRow = (row: JournalRow) => {
    if (row.kind === 'automatic') {
      const seg = row.segment;
      const isBreakfast = seg.sourceKind === 'plan' && seg.title === '早餐';
      return (
        <article key={row.id} className={`tj6-seg tj6-status-${seg.status}`}>
          <div className="tj6-head">
            <time>
              {seg.clippedRange.localStart} {seg.clippedRange.startOffset} –
              {seg.clippedRange.localEnd} {seg.clippedRange.endOffset}
            </time>
            <strong>{seg.title}</strong>
            <span className="tj6-tag">{statusLabel(seg.status)}</span>
          </div>
          {seg.referenceAnswers.length ? (
            <p className="tj6-answer">
              {seg.referenceAnswers.map((a) => `参考：${a.question} → ${a.entry.title}`).join('；')}
            </p>
          ) : null}
          {isTest && isBreakfast ? (
            <div className="tj6-test-actions">
              <button
                type="button"
                className="act-mini"
                onClick={() => dialAction('moveBreakfastTo10')}
              >
                测试：移到 10:00
              </button>
              <button
                type="button"
                className="act-mini danger"
                onClick={() => dialAction('retractBreakfast')}
              >
                测试：收回
              </button>
              <button
                type="button"
                className="act-mini"
                onClick={() => dialAction('restoreBreakfast')}
              >
                测试：放回 08:00
              </button>
            </div>
          ) : null}
        </article>
      );
    }
    if (row.kind === 'reference') {
      const d = displayInstant(row.point.at, row.point.zone);
      return (
        <article key={row.id} className="tj6-ref">
          <div className="tj6-head">
            <time>
              {d.time} {d.offset}
            </time>
            <strong>
              {row.answer.question} → {row.answer.entry.title}
            </strong>
            <span className="tj6-tag">独立参考</span>
          </div>
        </article>
      );
    }
    const note: JournalNote = row.note;
    const modified = note.updatedAt !== note.recordedAt;
    const recorded = displayInstant(note.recordedAt, note.zone);
    const updated = displayInstant(note.updatedAt, note.zone);
    return (
      <article key={row.id} className="tj6-note">
        <div className="tj6-head">
          <time>
            {recorded.time} {recorded.offset}
          </time>
          <strong className="tj6-note-title">随记</strong>
          <span className="tj6-tag tj6-tag-note">感想</span>
        </div>
        {editing?.id === note.id ? (
          <div className="tj6-edit">
            <textarea
              aria-label={`修改 ${recorded.time} 随记`}
              rows={2}
              value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            />
            <div className="tj6-row-actions">
              <button type="button" className="act-mini primary" onClick={saveEdit}>
                保存修改
              </button>
              <button type="button" className="act-mini" onClick={() => setEditing(null)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="tj6-text">{note.text || '（已清空，保留条目及原时间）'}</p>
            <div className="tj6-foot">
              {modified ? (
                <span className="tj6-modified">
                  原时间 {recorded.time} · 修改于 {updated.time}
                </span>
              ) : editable ? (
                <button
                  type="button"
                  className="act-mini"
                  onClick={() =>
                    setEditing({ id: note.id, text: note.text, version: note.version })
                  }
                >
                  编辑
                </button>
              ) : null}
            </div>
          </>
        )}
      </article>
    );
  };

  return (
    <div className="tj6">
      <div className="tj6-banner" role="note">
        {isTest ? (
          <>
            测试适配器：随记与表盘改动仅存在于内存，<strong>刷新即丢失</strong>
            ，文件状态为模拟；正式随记/文件会话在 A7 接入。
          </>
        ) : (
          <>
            正式存储模式：随记具名保存、<strong>刷新后保留</strong>
            ，自动段由表盘投影；保存失败明确提示，不会假成功。
          </>
        )}
      </div>

      <div className="tj6-controls panel">
        <label className="tj6-field">
          <span>日期</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="tj6-field">
          <span>时区</span>
          <select value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="Asia/Shanghai">Asia/Shanghai</option>
            <option value="Asia/Tokyo">Asia/Tokyo</option>
            <option value="UTC">UTC</option>
          </select>
        </label>
        <button
          type="button"
          className="act-mini"
          onClick={() => setDate((d) => (d === ARCHIVE_DATE ? DEFAULT_DATE : ARCHIVE_DATE))}
        >
          {date === ARCHIVE_DATE ? '返回今天' : '查看历史归档（09-30）'}
        </button>
        {view?.access === 'archive' ? (
          <span className="tj6-archive-flag">历史归档 · 只读</span>
        ) : null}
      </div>

      {file ? (
        <div className={`tj6-filebar tj6-file-${file.status}`} role="status">
          <span>{file.message}</span>
          <span className="tj6-file-actions">
            {file.status === 'pending' ? (
              <button
                type="button"
                className="act-mini primary"
                disabled={busy}
                onClick={() => runFile('write')}
              >
                立即写入
              </button>
            ) : null}
            {file.status === 'error' ? (
              <button
                type="button"
                className="act-mini primary"
                disabled={busy}
                onClick={() => runFile('retry')}
              >
                重试写入
              </button>
            ) : null}
            {file.status === 'permission-required' ? (
              <button
                type="button"
                className="act-mini primary"
                disabled={busy}
                onClick={() => runFile('reauth')}
              >
                重新授权后写入
              </button>
            ) : null}
            {isTest ? (
              <>
                <button
                  type="button"
                  className="act-mini"
                  onClick={() => applyTestFileStatus('error')}
                >
                  测试：模拟失败
                </button>
                <button
                  type="button"
                  className="act-mini"
                  onClick={() => applyTestFileStatus('permission-required')}
                >
                  测试：模拟失权
                </button>
              </>
            ) : null}
          </span>
        </div>
      ) : null}

      {editable ? (
        <div className="tj6-compose panel">
          <label htmlFor="tj6-draft">写一条随记（归属 {date}）</label>
          <textarea
            id="tj6-draft"
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="随时写下的话，独立保存，不随表盘收回而删除…"
          />
          <div className="tj6-row-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !draft.trim()}
              onClick={addNote}
            >
              保存随记
            </button>
          </div>
        </div>
      ) : (
        <div className="tj6-readonly panel">历史归档为只读视图，不能在此新增或修改随记。</div>
      )}

      {formError ? (
        <div className="tj6-form-error" role="alert">
          {formError}
        </div>
      ) : null}

      {view ? (
        <>
          <div className="tj6-timeline">
            {view.projection.rows.length ? (
              view.projection.rows.map(renderRow)
            ) : (
              <p className="tj6-empty">当天无自动安排、参考或随记。</p>
            )}
          </div>

          <section className="tj6-legacy panel">
            <h2>历史正文（迁移的旧整篇，不拆段）</h2>
            {view.projection.timeline.legacyBlocks.length ? (
              view.projection.timeline.legacyBlocks.map((b) => {
                const c = displayInstant(b.createdAt, b.zone);
                const u = displayInstant(b.updatedAt, b.zone);
                return (
                  <article key={b.id} className="tj6-legacy-block">
                    <div className="tj6-head">
                      <time>
                        {b.date} [{b.zone}]
                      </time>
                      <strong>旧正文 {b.id}</strong>
                    </div>
                    <p className="tj6-text">{b.text}</p>
                    <small className="tj6-modified">
                      原篇创建 {c.date} {c.time} · 原篇修改 {u.date} {u.time}
                    </small>
                  </article>
                );
              })
            ) : (
              <p className="tj6-empty">无旧正文。</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
