// A0 时间线日记样稿：表盘自动段与独立感想穿插（P13/P14/P16/P18，合同 10）。
// 早餐移时更新同一条、收回移除自动段但感想保留；随记保留原时间并附修改标记；
// 底部文件状态条为样稿模拟：主数据保存与文本文件队列分离（P15/P17）。
import { useState } from 'react';
import {
  SAMPLE_AUTO_BLOCKS,
  SAMPLE_NOTES,
  addMinutes,
  type SampleAutoBlock,
  type SampleNote,
} from './sample-data.ts';
import './journal-sample.css';

type FileState = 'synced' | 'pending' | 'error';
type TimelineItem = Readonly<{
  key: string;
  sortKey: string;
  kind: 'block' | 'note';
  block?: SampleAutoBlock;
  note?: SampleNote;
}>;

const BREAKFAST_DEFAULT: SampleAutoBlock = SAMPLE_AUTO_BLOCKS[1];

export function TimelineJournalSample() {
  const [blocks, setBlocks] = useState<readonly SampleAutoBlock[]>(SAMPLE_AUTO_BLOCKS);
  const [notes, setNotes] = useState<readonly SampleNote[]>(SAMPLE_NOTES);
  const [draft, setDraft] = useState('');
  const [nextClock, setNextClock] = useState('09:30');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [fileState, setFileState] = useState<FileState>('synced');

  const breakfast = blocks.find((b) => b.id === 'a-breakfast') ?? null;

  const markPending = () => setFileState('pending');

  const moveBreakfast = () => {
    setBlocks((prev) =>
      prev.map((b) => (b.id === 'a-breakfast' ? { ...b, start: '10:00', end: '10:30' } : b)),
    );
    markPending();
  };
  const retractBreakfast = () => {
    setBlocks((prev) => prev.filter((b) => b.id !== 'a-breakfast'));
    markPending();
  };
  const restoreBreakfast = () => {
    setBlocks((prev) =>
      prev.some((b) => b.id === 'a-breakfast')
        ? prev.map((b) => (b.id === 'a-breakfast' ? BREAKFAST_DEFAULT : b))
        : [...prev, BREAKFAST_DEFAULT].sort((a, b) => a.start.localeCompare(b.start)),
    );
    markPending();
  };

  const addNote = () => {
    const text = draft.trim();
    if (!text) return;
    setNotes((prev) => [...prev, { id: `n-${nextClock}`, createdAt: nextClock, text }]);
    setNextClock(addMinutes(nextClock, 1));
    setDraft('');
    markPending();
  };

  const startEdit = (note: SampleNote) => {
    setEditingId(note.id);
    setEditText(note.text);
  };
  const saveEdit = () => {
    if (!editingId) return;
    const text = editText.trim();
    setNotes((prev) =>
      prev.map((n) =>
        n.id === editingId
          ? { ...n, text: text || n.text, modifiedAt: addMinutes(n.createdAt, 125) }
          : n,
      ),
    );
    setEditingId(null);
    setEditText('');
    markPending();
  };

  const timeline: readonly TimelineItem[] = [
    ...blocks.map((b) => ({ key: b.id, sortKey: b.start, kind: 'block' as const, block: b })),
    ...notes.map((n) => ({ key: n.id, sortKey: n.createdAt, kind: 'note' as const, note: n })),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  return (
    <div className="jn6">
      <div className="jn6-legend" role="note">
        <span>
          <i className="jn6-key jn6-key-auto" /> 自动段：表盘投影，随放置／移动／收回更新
        </span>
        <span>
          <i className="jn6-key jn6-key-note" /> 感想：独立随记，保留原时间
        </span>
      </div>

      <div className={`jn6-filebar jn6-file-${fileState}`} data-state={fileState} role="status">
        {fileState === 'synced' ? (
          <span>文本文件已同步 · 最后成功输出 09:30（样稿模拟）</span>
        ) : fileState === 'pending' ? (
          <span>主数据已保存，当日文本排队待写入…（样稿模拟）</span>
        ) : (
          <span>文件写入失败：主数据与随记仍保留，可重试（样稿模拟）</span>
        )}
        <span className="jn6-file-actions">
          {fileState !== 'synced' ? (
            <button
              type="button"
              className="act-mini primary"
              onClick={() => setFileState('synced')}
            >
              {fileState === 'error' ? '重试写入' : '立即写入'}
            </button>
          ) : null}
          <button type="button" className="act-mini" onClick={() => setFileState('pending')}>
            模拟待写入
          </button>
          <button type="button" className="act-mini" onClick={() => setFileState('error')}>
            模拟失败
          </button>
        </span>
      </div>

      <div className="jn6-compose panel">
        <label htmlFor="jn6-draft">写一条随记（样稿时间 {nextClock}）</label>
        <textarea
          id="jn6-draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="随时写下的话，独立保存…"
        />
        <div className="jn6-compose-actions">
          <button type="button" className="primary" onClick={addNote}>
            保存随记
          </button>
        </div>
      </div>

      <div className="jn6-timeline">
        {timeline.map((item) => {
          if (item.kind === 'block' && item.block) {
            const b = item.block;
            return (
              <article key={item.key} className={`jn6-block jn6-kind-${b.kind}`}>
                <div className="jn6-item-head">
                  <time>
                    {b.start}–{b.end}
                  </time>
                  <strong>{b.name}</strong>
                  <span className="jn6-tag">表盘</span>
                </div>
                {b.reference ? <p className="jn6-reference">{b.reference}</p> : null}
                {b.id === 'a-breakfast' ? (
                  <div className="jn6-row-actions">
                    <button type="button" className="act-mini" onClick={moveBreakfast}>
                      移到 10:00
                    </button>
                    <button type="button" className="act-mini danger" onClick={retractBreakfast}>
                      收回
                    </button>
                  </div>
                ) : null}
              </article>
            );
          }
          const n = item.note!;
          return (
            <article key={item.key} className="jn6-note">
              <div className="jn6-item-head">
                <time>{n.createdAt}</time>
                <strong className="jn6-note-title">随记</strong>
                <span className="jn6-tag jn6-tag-note">感想</span>
              </div>
              {editingId === n.id ? (
                <div className="jn6-edit">
                  <textarea
                    value={editText}
                    rows={2}
                    onChange={(e) => setEditText(e.target.value)}
                    aria-label={`修改 ${n.createdAt} 随记`}
                  />
                  <div className="jn6-row-actions">
                    <button type="button" className="act-mini primary" onClick={saveEdit}>
                      保存修改
                    </button>
                    <button type="button" className="act-mini" onClick={() => setEditingId(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="jn6-note-text">{n.text}</p>
                  <div className="jn6-item-foot">
                    {n.modifiedAt ? (
                      <span className="jn6-modified">
                        原时间 {n.createdAt} · 已修改 {n.modifiedAt}
                      </span>
                    ) : (
                      <button type="button" className="act-mini" onClick={() => startEdit(n)}>
                        编辑
                      </button>
                    )}
                  </div>
                </>
              )}
            </article>
          );
        })}
      </div>

      {!breakfast ? (
        <div className="jn6-retracted-note" role="note">
          早餐自动段已收回；08:12 的感想仍保留在上方。
          <button type="button" className="act-mini" onClick={restoreBreakfast}>
            放回早餐 08:00
          </button>
        </div>
      ) : breakfast.start === '10:00' ? (
        <div className="jn6-retracted-note" role="note">
          早餐已移到 10:00（仍是同一条记录）。
          <button type="button" className="act-mini" onClick={restoreBreakfast}>
            放回 08:00
          </button>
        </div>
      ) : null}
    </div>
  );
}
