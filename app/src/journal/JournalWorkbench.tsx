import { useCallback, useEffect, useRef, useState } from 'react';
import { Temporal } from '@js-temporal/polyfill';
import type { WorkspaceClient, WorkspaceSnapshot, JournalView } from '../workspace/index.ts';
import { dateAt } from '../daily/time.ts';
import { JournalMonthCalendar } from './JournalMonthCalendar.tsx';
import { useJournalAutosave } from './use-journal-autosave.ts';

const WEEK_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const splitDate = (date: string) => ({
  year: Number(date.slice(0, 4)),
  month: Number(date.slice(5, 7)),
});
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function JournalWorkbench({
  client,
  readOnly,
  registerSaveGuard,
}: {
  client: WorkspaceClient;
  readOnly: boolean;
  registerSaveGuard?: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [view, setView] = useState<JournalView | null>(null);
  const [loadingEntry, setLoadingEntry] = useState(false);
  const [neighbors, setNeighbors] = useState<{ prev: string | null; next: string | null }>({
    prev: null,
    next: null,
  });
  const [monthDates, setMonthDates] = useState<ReadonlySet<string>>(new Set());
  const [cal, setCal] = useState<{ year: number; month: number } | null>(null);
  const [notice, setNotice] = useState('');

  // This component instance belongs to one workspace epoch (App also keys it by epoch). The
  // first snapshot pins it; saves after a workspace replacement must be rejected.
  const initialized = useRef(false);
  const ownerEpochRef = useRef<string | null>(null);

  const zone = snapshot?.data?.settings.zone ?? browserZone();
  const today = dateAt(new Date().toISOString(), zone);
  const onV4 = snapshot?.data?.version === 4;
  const isFutureDay = date !== null && date > today;
  const editingLocked = date === null || readOnly || isFutureDay || !onV4;

  useEffect(() => {
    let active = true;
    const load = async () => {
      const r = await client.load();
      if (r.ok && active) setSnapshot(r.value);
    };
    void load();
    const unsub = client.subscribe(() => {
      void load();
    });
    return () => {
      active = false;
      unsub();
    };
  }, [client]);

  // First date is today in the workspace zone, computed only after the snapshot is loaded;
  // browsing before that shows a loading state instead of a browser-zone date.
  useEffect(() => {
    if (!snapshot || !snapshot.data || initialized.current) return;
    initialized.current = true;
    ownerEpochRef.current = snapshot.token.epoch;
    const t = dateAt(new Date().toISOString(), snapshot.data.settings.zone ?? browserZone());
    setDate(t);
    setCal(splitDate(t));
  }, [snapshot]);

  // Load the entry for the selected date. Deliberately not keyed on token.revision so an
  // autosave's own snapshot refresh does not reload (and flash) the entry being edited.
  useEffect(() => {
    if (date === null) return;
    let active = true;
    setView(null);
    setLoadingEntry(true);
    void Promise.all([
      client.readJournal({ date, zone }),
      client.readJournalNeighbors({ date }),
    ]).then(([r, n]) => {
      if (!active) return;
      if (r.ok) setView(r.value);
      if (n.ok) setNeighbors(n.value);
      setLoadingEntry(false);
    });
    return () => {
      active = false;
    };
  }, [client, date, zone]);

  // Month dots are keyed on revision so they refresh after saves and external changes.
  useEffect(() => {
    if (!cal) return;
    let active = true;
    void client.readJournalMonth(cal).then((r) => {
      if (r.ok && active) setMonthDates(new Set(r.value.dates));
    });
    return () => {
      active = false;
    };
  }, [client, cal, snapshot?.token.revision]);

  const save = useCallback(
    async (text: string) => {
      const current = await client.load();
      if (!current.ok || !current.value.data) return false;
      const ownerEpoch = ownerEpochRef.current ?? current.value.token.epoch;
      if (current.value.token.epoch !== ownerEpoch) return false; // workspace replaced: discard old draft
      const result = await client.submit({
        commandId: crypto.randomUUID(),
        expected: current.value.token,
        type: 'SaveJournalEntry',
        payload: { date: date!, zone, text },
      });
      if (result.ok) {
        setNotice('');
        const fresh = await client.load();
        if (fresh.ok) setSnapshot(fresh.value);
        return true;
      }
      setNotice(result.message);
      return false;
    },
    [client, date, zone],
  );

  // Identity of the loaded editing target. 'pending' while the new date is still loading, so
  // the editor adopts the blank first and the finished entry next; two blank dates are distinct.
  const entryKey =
    !view || loadingEntry
      ? 'pending'
      : `${date}#${view.entry?.id ?? 'blank'}@${view.fallbackZone ?? zone}`;
  const { text, setText, status, savedAt, flush, retry } = useJournalAutosave({
    initialText: view?.entry?.text ?? '',
    entryKey,
    save,
  });

  // Ordinary navigation must await the same drain as date switches. Epoch replacement
  // remains an explicit discard path and is rejected by the owner check inside save().
  useEffect(() => {
    registerSaveGuard?.(flush);
    return () => registerSaveGuard?.(null);
  }, [registerSaveGuard, flush]);

  const selectDate = useCallback(
    async (next: string) => {
      if (next === date) return;
      const ok = await flush();
      if (ok === false) return; // save failed: stay, keep the draft and the retry action
      setNotice('');
      // Synchronously enter the loading state in the same batch as setDate, so the first frame
      // never shows the old entry's text under the new heading.
      setView(null);
      setLoadingEntry(true);
      setDate(next);
      setCal(splitDate(next));
    },
    [date, flush],
  );

  const shiftMonth = (delta: number) => {
    if (!cal) return;
    const m = cal.month - 1 + delta;
    setCal({ year: cal.year + Math.floor(m / 12), month: (((m % 12) + 12) % 12) + 1 });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!editingLocked) void flush();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flush, editingLocked]);

  if (!snapshot || date === null || cal === null) {
    return <div className="journal-loading">加载中…</div>;
  }

  const pd = Temporal.PlainDate.from(date);
  const statusNode = (() => {
    if (status === 'saving') return <span className="journal-status saving">保存中…</span>;
    if (status === 'dirty') return <span className="journal-status dirty">编辑中…</span>;
    if (status === 'saved')
      return (
        <span className="journal-status saved">
          已保存
          {savedAt
            ? ` ${new Date(savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            : ''}
        </span>
      );
    if (status === 'error')
      return (
        <button type="button" className="journal-status error" onClick={() => void retry()}>
          保存失败，点着重试
        </button>
      );
    return <span className="journal-status idle" />;
  })();

  return (
    <div className="journal-layout">
      <aside className="journal-sidebar panel">
        <div className="journal-calendar-header">
          <button type="button" aria-label="上个月" onClick={() => shiftMonth(-1)}>
            ‹
          </button>
          <strong>
            {cal.year}年{cal.month}月
          </strong>
          <button type="button" aria-label="下个月" onClick={() => shiftMonth(1)}>
            ›
          </button>
        </div>
        <JournalMonthCalendar
          year={cal.year}
          month={cal.month}
          selectedDate={date}
          today={today}
          datesWithEntry={monthDates}
          onSelect={(d) => void selectDate(d)}
        />
        <button type="button" className="journal-today-btn" onClick={() => void selectDate(today)}>
          回到今天
        </button>
      </aside>
      <section className="journal-editor panel">
        <div className="journal-editor-head">
          <div className="journal-nav">
            <button
              type="button"
              disabled={!neighbors.prev}
              onClick={() => void selectDate(neighbors.prev!)}
            >
              ‹ 上一篇
            </button>
            <button
              type="button"
              disabled={!neighbors.next}
              onClick={() => void selectDate(neighbors.next!)}
            >
              下一篇 ›
            </button>
          </div>
          <h2>
            {pd.year}年{pd.month}月{pd.day}日 · {WEEK_LABELS[pd.dayOfWeek - 1]}
          </h2>
          {view?.fallbackZone && <p className="muted">这篇写于时区 {view.fallbackZone}</p>}
        </div>
        {editingLocked ? (
          <div className="journal-locked">
            {!onV4 ? (
              <p role="alert">日记需要先升级数据：请到“数据”页下载完整备份并预览升级。</p>
            ) : (
              <p role="alert">未来的日记还不能写；未来的事请用排期。</p>
            )}
          </div>
        ) : loadingEntry || !view ? (
          <div className="journal-loading">加载中…</div>
        ) : (
          <>
            <textarea
              className="journal-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="写点什么…"
              aria-label="日记正文"
            />
            <div className="journal-statusbar">
              {statusNode}
              {notice && (
                <span className="journal-notice" role="alert">
                  {notice}
                </span>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
