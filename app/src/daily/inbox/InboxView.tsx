import { useRef, useState } from 'react';
import {
  archiveCapture,
  discardCapture,
  resolveCapture,
  type Planner,
  type Data,
} from '../../workspace/legacy/index.ts';
export function InboxView({
  data,
  onSave,
}: {
  data: Data;
  onSave: (data: Data, message: string) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const items = data.planner.captures.filter((x) => x.status === 'unprocessed');
  const active = items.find((x) => x.id === selected);
  async function run(mut: (p: Planner) => void, msg: string) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const next = structuredClone(data);
      mut(next.planner);
      const ok = await onSave(next, msg);
      if (ok) setSelected(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <section className="inbox-layout">
        <section className="panel">
          <h2>未处理记录</h2>
          {items.length ? (
            items.map((x) => (
              <button
                className="inbox-row"
                disabled={busy}
                key={x.id}
                onClick={() => {
                  setSelected(x.id);
                  setTitle(x.text);
                }}
              >
                <span>{x.text}</span>
                <small>{new Date(x.at).toLocaleString('zh-CN')}</small>
              </button>
            ))
          ) : (
            <p className="emptyline">Inbox 已清空。想到事情时，可以随时快速记录。</p>
          )}
        </section>
        {active && (
          <section className="panel">
            <h2>整理这条记录</h2>
            <p className="muted">原文：{active.text}</p>
            <label>
              Card 标题
              <input value={title} disabled={busy} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <div className="toolbar inbox-actions">
              <button
                disabled={busy}
                onClick={() => run((p) => discardCapture(p, active.id), '已丢弃 Inbox 记录')}
              >
                丢弃
              </button>
              <button
                className="quiet"
                disabled={busy}
                onClick={() => run((p) => archiveCapture(p, active.id), '已归档 Inbox 记录')}
              >
                归档
              </button>
              <button
                className="primary"
                disabled={busy || !title.trim()}
                onClick={() =>
                  run((p) => resolveCapture(p, active.id, title.trim(), ''), '已转为 Card')
                }
              >
                转为 Card
              </button>
            </div>
          </section>
        )}
      </section>
    </>
  );
}
