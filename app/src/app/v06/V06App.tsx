/** B7/B8 production composition. A-owned editors receive the formal Host. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createV06TodayClient, type V06Host, type Command } from '../../workspace/index.ts';
import type { DataV5, V06Command } from '../../workspace/v06.ts';
import {
  DayBoard,
  V06HandDock,
  type DayBoardView,
  type HandPlayRequest,
} from '../../daily/index.ts';
import { createV06JournalSession } from '../../journal/index.ts';
import { WorkshopEditorV06, createFormalCatalogEditor } from '../../workshop/index.ts';
import { dateAt } from '../../daily/time.ts';
import { V06CardWorkbench } from './V06CardWorkbench.tsx';
import { V06TextFiles } from './V06TextFiles.tsx';
import { V06JournalView } from './V06JournalView.tsx';
import { V06Archives } from './V06Archives.tsx';
import { V06Configuration } from './V06Configuration.tsx';
import { BackupRestore } from './BackupRestore.tsx';
import { ReferencePlacement } from './ReferencePlacement.tsx';
import '../style.css';
type Page = 'today' | 'workshop' | 'cards' | 'journal' | 'maintenance' | 'data';
type HostCommand = Parameters<V06Host['submit']>[0];
const labels: Record<Page, string> = {
  today: 'Today',
  workshop: '工坊',
  cards: '抽卡与决策',
  journal: '时间线日记',
  maintenance: '维护日志',
  data: '备份与恢复',
};
export function V06App({
  host,
  initialDate,
  registerFlush,
}: Readonly<{
  host: V06Host;
  initialDate?: string;
  registerFlush?: (fn: () => Promise<boolean>) => void;
}>) {
  const today = useMemo(() => createV06TodayClient(host), [host]),
    editor = useMemo(() => createFormalCatalogEditor(host), [host]);
  const [epoch, setEpoch] = useState('');
  const [page, setPage] = useState<Page>('today'),
    [data, setData] = useState<DataV5 | null>(null),
    [view, setView] = useState<DayBoardView | null>(null),
    [day, setDay] = useState<Awaited<ReturnType<V06Host['readDay']>> | null>(null),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [handRequest, setHandRequest] = useState<HandPlayRequest | null>(null);
  const [answer, setAnswer] = useState<{
      id: string;
      version: number;
      token: import('../../workspace/index.ts').Token;
    } | null>(null),
    [logs, setLogs] = useState<Awaited<ReturnType<V06Host['readMaintenanceDay']>> | null>(null);
  const lock = useRef(false),
    route = useRef(page),
    retry = useRef<HostCommand | null>(null),
    generation = useRef(0);
  route.current = page;
  const session = useMemo(
    () =>
      createV06JournalSession(host, {
        date: initialDate ?? dateAt(new Date().toISOString(), 'UTC'),
        zone: 'UTC',
      }),
    [host, initialDate],
  );
  const journal = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const refresh = async () => {
    const seq = ++generation.current,
      s = await host.loadV5();
    if (seq !== generation.current) return;
    if (!s.ok) {
      setMessage(s.message);
      return;
    }
    setData(s.value.data);
    setEpoch(s.value.token.epoch);
    if (view) {
      const d = await host.readDay({ date: view.date, zone: view.zone });
      if (seq === generation.current) setDay(d);
    }
    if (route.current === 'maintenance') {
      const r = await host.readMaintenanceDay({
        epoch: s.value.token.epoch,
        date: view?.date ?? dateAt(new Date().toISOString(), s.value.data.settings.zone ?? 'UTC'),
        zone: view?.zone ?? s.value.data.settings.zone ?? 'UTC',
      });
      if (seq === generation.current) setLogs(r);
    }
  };
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    void refresh();
    void session.start();
    registerFlush?.(() => session.flush());
    const off = host.subscribe(() => void refreshRef.current());
    return () => {
      ++generation.current;
      off();
      void session.close();
    };
  }, [host, session]);
  useEffect(() => {
    void host.textFilePort
      .start()
      .catch((e) => setMessage(e instanceof Error ? e.message : '文件连接恢复失败'));
  }, [host]);
  useEffect(() => {
    void refresh();
  }, [page, view]);
  useEffect(() => {
    if (data && !view) {
      const zone = data.settings.zone ?? 'UTC',
        date = initialDate ?? dateAt(new Date().toISOString(), zone);
      setView({ date, zone, focusTime: '09:00', followNow: false });
      void session.changeDay(date, zone);
      void host.loadV5().then((r) => {
        if (r.ok) void host.navigatePage({ token: r.value.token, page: 'today' });
      });
    }
  }, [data]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => {
      if (session.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', guard);
    const visibility = () => {
      if (document.visibilityState === 'hidden') void session.flush();
      else void session.refresh();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('beforeunload', guard);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [session]);
  const submit = async (command: HostCommand) => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    retry.current = command;
    try {
      const r = await host.submit(command);
      if (!r.ok) {
        setMessage(r.message);
        if (r.retry !== 'same-command') retry.current = null;
        return false;
      }
      retry.current = null;
      setMessage(r.value.replayed ? '原请求已保存，已读取回执' : '已保存到本机');
      await refresh();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存结果尚未收到，请重试原请求');
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const named = async (type: V06Command['type'] | Command['type'], payload: unknown) => {
    const s = await host.loadV5();
    if (!s.ok) {
      setMessage(s.message);
      return false;
    }
    return submit({
      commandId: crypto.randomUUID(),
      expected: s.value.token,
      type,
      payload,
      ...(['RetractReference', 'CommitReferencePlacement'].includes(type)
        ? { contractVersion: 'v06-p0-1' }
        : {}),
    } as V06Command | Command);
  };
  const navigate = async (next: Page) => {
    if (busy) return;
    if (!(await session.flush())) {
      setMessage('感想尚未保存，草稿保留在当前页面');
      return;
    }
    const s = await host.loadV5();
    if (s.ok) void host.navigatePage({ token: s.value.token, page: next, previousPage: page });
    setMessage('');
    setAnswer(null);
    setHandRequest(null);
    setPage(next);
  };
  const play = async (request: HandPlayRequest) => {
    if (route.current !== 'today') return;
    const s = await host.loadV5();
    if (!s.ok) throw Error(s.message);
    if (route.current !== 'today') return;
    if (JSON.stringify(s.value.token) !== JSON.stringify(request.token))
      throw Error('手牌已变化，请重新读取');
    if (request.item.selection.kind === 'legacy') {
      setHandRequest(request);
      return;
    }
    const card = s.value.data.handCards.find(
      (c) => c.id === request.item.id && c.version === request.item.version,
    );
    if (!card) throw Error('本次素材已变化');
    if (card.kind === 'answer') {
      setAnswer({ id: card.id, version: card.version, token: request.token });
      return;
    }
    if (card.kind === 'action' || card.kind === 'composite') {
      const instance = s.value.data.planner.instances.find((i) => i.id === card.actionInstanceId);
      if (!instance) throw Error('行动实例不存在');
      setHandRequest({
        ...request,
        item: {
          ...request.item,
          key: 'legacy:' + instance.id,
          id: instance.id,
          version: instance.version,
          selection: { kind: 'legacy', instanceId: instance.id },
        },
      });
    }
  };
  const archivedJournal = !!data?.archiveIndex.some((i) => i.coveredDates.includes(journal.date));
  const futureJournal =
    journal.date > dateAt(new Date().toISOString(), data?.settings.zone ?? journal.zone);
  const [monthlyReminder, setMonthlyReminder] = useState<readonly string[]>([]),
    reminderDismissed = useRef(false);
  const archiveIdentity = data?.archiveIndex.map((i) => i.archiveId).join('|') ?? '';
  useEffect(() => {
    let active = true;
    void host.loadV5().then(async (s) => {
      if (!s.ok) return;
      const r = await host.archivePort.readArchivableMonths({
        token: s.value.token,
        zone: s.value.data.settings.zone ?? 'UTC',
      });
      if (active && r.ok && !reminderDismissed.current)
        setMonthlyReminder(r.value.data.map((m) => m.month));
    });
    return () => {
      active = false;
    };
  }, [host, archiveIdentity, data?.settings.zone]);
  return (
    <div className={`app ${data?.settings.preferences.theme ?? 'paper'} comfortable`}>
      <main className="v06-app">
        <h1>CardGrid</h1>
        <p className="version">
          {import.meta.env.VITE_CARDGRID_VERSION
            ? `v${import.meta.env.VITE_CARDGRID_VERSION}`
            : '开发构建'}
        </p>
        <nav aria-label="主导航">
          {(Object.keys(labels) as Page[]).map((p) => (
            <button
              key={p}
              disabled={busy}
              aria-current={page === p ? 'page' : undefined}
              onClick={() => void navigate(p)}
            >
              {labels[p]}
            </button>
          ))}
        </nav>
        {monthlyReminder.length > 0 && (
          <aside aria-label="月度提醒">
            可归档月份：{monthlyReminder.join('、')}。导出并核验后由你决定是否清理。
            <button onClick={() => void navigate('data')}>查看月度归档</button>
            <button
              onClick={() => {
                reminderDismissed.current = true;
                setMonthlyReminder([]);
              }}
            >
              本次稍后处理
            </button>
          </aside>
        )}
        {message && <p role="status">{message}</p>}
        {retry.current && (
          <button disabled={busy} onClick={() => retry.current && void submit(retry.current)}>
            重试原请求
          </button>
        )}
        {page === 'today' && view && (
          <>
            <DayBoard
              client={today}
              initialView={view}
              onViewChange={setView}
              handRequest={handRequest}
              onHandRequestHandled={() => setHandRequest(null)}
            />
            <section aria-label="答案参考">
              <h2>答案参考 · 不重复计时</h2>
              {day?.ok &&
                day.value.references.map((r) => (
                  <p key={r.reference.id} data-reference-id={r.reference.id}>
                    {r.range
                      ? `${r.range.startAt} — ${r.range.endAt} · 共用行动安排`
                      : r.reference.mode === 'point'
                        ? `${r.reference.point.localTime} · 独立时点 · 0 分钟`
                        : ''}{' '}
                    · {r.answer.question}：{r.answer.entry.title}{' '}
                    <button
                      disabled={busy}
                      onClick={() =>
                        void named('RetractReference', {
                          reference: { id: r.reference.id, version: r.reference.version },
                        })
                      }
                    >
                      收回参考
                    </button>
                  </p>
                ))}
              {day?.ok &&
                day.value.factAnswers
                  .filter((f) => f.answers.length)
                  .map((f) => (
                    <p key={f.factId}>
                      事实 {f.factId} · 已冻结：{f.answers.map((a) => a.entry.title).join('、')}
                    </p>
                  ))}
            </section>
          </>
        )}
        {page === 'workshop' && (
          <WorkshopEditorV06
            host={editor}
            onOpenListUrl={(entry) => {
              void host.loadV5().then((s) => {
                if (s.ok)
                  void host
                    .openListUrl({
                      token: s.value.token,
                      entry: { id: entry.id, version: entry.version },
                    })
                    .then((r) =>
                      setMessage(
                        r.ok
                          ? r.value.outcome === 'requested'
                            ? '已请求浏览器打开网址'
                            : '浏览器未能打开网址'
                          : r.message,
                      ),
                    );
              });
            }}
          />
        )}
        <V06CardWorkbench host={host} showDock={false} active={page === 'cards'} />
        {page === 'data' && (
          <>
            <V06Configuration host={host} onMessage={setMessage} />
            <V06Archives host={host} onMessage={setMessage} />
          </>
        )}
        {page === 'cards' && (
          <>
            <section aria-label="每日库存">
              <h2>每日库存</h2>
              <button
                disabled={busy}
                onClick={() => void named('GenerateDailyCopies', { target: 'current' })}
              >
                生成今天副本
              </button>
              <button disabled={busy} onClick={() => void named('ArchiveDueCopies', {})}>
                归档到期副本
              </button>
              {data?.dailyCopies
                .filter((c) => 'format' in c)
                .map((c) => (
                  <p key={c.id}>
                    {c.sourceDate} · {c.contentSnapshot.title} · {c.id}{' '}
                    <button
                      disabled={busy}
                      onClick={() => {
                        void host.loadV5().then((s) => {
                          if (s.ok)
                            void submit({
                              contractVersion: 'v06-b7-1',
                              commandId: crypto.randomUUID(),
                              expected: s.value.token,
                              type: 'TakeDailyMaterial',
                              payload: { copy: { id: c.id, version: c.version } },
                            });
                        });
                      }}
                    >
                      取为本次素材
                    </button>
                  </p>
                ))}
            </section>
          </>
        )}
        {page === 'journal' && (
          <V06JournalView
            journal={journal}
            session={session}
            archived={archivedJournal}
            future={futureJournal}
          />
        )}
        {page === 'maintenance' && (
          <section aria-label="维护日志">
            <h2>维护日志</h2>
            <button onClick={() => void host.retryMaintenance().then(() => refresh())}>
              补写并刷新
            </button>
            {logs?.ok ? (
              <>
                <p>{logs.value.hasGaps ? '存在未落库事件缺口' : '本批采集无已知缺口'}</p>
                {logs.value.events.map((e) => (
                  <p key={e.eventId}>
                    {e.at} · {e.operation} · {e.stage} {e.errorCode ?? ''} {e.details.url ?? ''}
                  </p>
                ))}
              </>
            ) : (
              <p role="alert">{logs && !logs.ok ? logs.message : '正在读取'}</p>
            )}
          </section>
        )}
        {page === 'data' && (
          <BackupRestore
            key={epoch}
            host={host}
            busy={busy}
            onMessage={setMessage}
            onSubmit={submit}
          />
        )}
        {answer && page === 'today' && data && view && answer.token.epoch === epoch && (
          <ReferencePlacement
            key={JSON.stringify([epoch, answer.id, answer.version, view.date, view.zone])}
            host={host}
            data={data}
            view={view}
            answer={answer}
            busy={busy}
            onMessage={setMessage}
            onSubmit={submit}
            onClose={() => setAnswer(null)}
          />
        )}
        {(page === 'journal' || page === 'maintenance' || page === 'data') && data && (
          <V06TextFiles
            host={host}
            date={page === 'journal' ? journal.date : (view?.date ?? journal.date)}
            zone={page === 'journal' ? journal.zone : (view?.zone ?? journal.zone)}
            epoch={epoch}
          />
        )}
      </main>
      <V06HandDock host={host} isToday={page === 'today'} onPlay={play} />
    </div>
  );
}
