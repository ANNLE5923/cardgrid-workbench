import { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkspaceApp } from './use-workspace-app.ts';
import { TAB_META } from './navigation.ts';
import { download } from './files.ts';
import { ActionLibrary, ConfigurationPanel, WorkshopEditor } from '../workshop/index.ts';
import { DataPage, MAX_INPUT_BYTES } from '../workspace/index.ts';
import {
  DayBoard,
  GlobalHandDock,
  Today,
  ScheduleView,
  InboxView,
  type DayBoardView,
} from '../daily/index.ts';
import { legacyDockItems, type HandPlayRequest } from '../daily/model.ts';
import { JournalWorkbench } from '../journal/index.ts';
import { ActionHand } from './ActionWorkspace.tsx';
import { SafeRecoveryView } from './SafeRecoveryView.tsx';
import './style.css';
import '../journal/journal.css';
export function App() {
  const [todayView, setTodayView] = useState<{ epoch: string; view: DayBoardView } | null>(null);
  const journalSaveGuard = useRef<(() => Promise<boolean>) | null>(null);
  const registerJournalSaveGuard = useCallback((guard: (() => Promise<boolean>) | null) => {
    journalSaveGuard.current = guard;
  }, []);
  const {
    client,
    drawing,
    workshopHost,
    snapshot,
    fatal,
    message,
    setMessage,
    tab,
    setTab,
    templateId,
    setTemplateId,
    preparationRevision,
    date,
    setDate,
    zone,
    setZone,
    day,
    draft,
    setDraft,
    json,
    setJson,
    baseline,
    editor,
    setEditor,
    busy,
    backup,
    saved,
    setSaved,
    discard,
    setDiscard,
    resetText,
    setResetText,
    pending,
    setPending,
    fileText,
    merge,
    setMerge,
    recovery,
    readonlyPaths,
    setReadonlyPaths,
    offsets,
    setOffsets,
    capture,
    setCapture,
    file,
    retry,
    dirty,
    reload,
    submit,
    command,
    prepareBackup,
    previewFile,
    migration,
    execute,
    navigation,
    stepDate,
    changeSettings,
    saveSettings,
  } = useWorkspaceApp();
  const [handRequest, setHandRequest] = useState<HandPlayRequest | null>(null);
  const [safeOpen, setSafeOpen] = useState(false);
  const handRoute = useRef(tab);
  handRoute.current = tab;
  const handLock = useRef(false);
  const handHandled = useCallback(() => setHandRequest(null), []);
  useEffect(() => {
    setHandRequest(null);
  }, [tab, snapshot?.token.epoch]);
  async function navigate(next: Parameters<typeof navigation>[0]) {
    if (
      next !== tab &&
      tab === 'journal' &&
      journalSaveGuard.current &&
      !(await journalSaveGuard.current())
    )
      return;
    navigation(next);
  }
  if (fatal) {
    if (safeOpen)
      return (
        <SafeRecoveryView
          client={client}
          onExit={() => setSafeOpen(false)}
          onRetry={() => {
            setSafeOpen(false);
            void reload();
          }}
        />
      );
    return (
      <div className="failure">
        <h1>本地数据暂时无法打开</h1>
        <p>{fatal}</p>
        <p>原记录没有被空白数据覆盖。</p>
        <button onClick={() => void reload()}>重试</button>
        <button type="button" onClick={() => setSafeOpen(true)}>
          安全打开（只读）
        </button>
        <button
          onClick={() =>
            void client.exportRaw().then((r) => {
              if (r.ok) download('CardGrid-诊断原文.json', r.value);
            })
          }
        >
          导出原始数据
        </button>
      </div>
    );
  }
  if (!snapshot) return <div className="failure">正在打开本地工作台…</div>;
  const data = client.readCompatibilityView(snapshot),
    p = data.config.preferences,
    readOnly = snapshot.mode === 'legacy-readonly';
  const oldSave = async () => {
    setMessage('此旧版编辑入口只读，请使用新版命令入口。');
    return false;
  };
  const workspaceEpoch = snapshot.token.epoch;
  const currentTodayView = todayView?.epoch === workspaceEpoch ? todayView.view : undefined;
  const rememberTodayView = (view: DayBoardView) => {
    setTodayView({ epoch: workspaceEpoch, view });
    setDate(view.date);
    setZone(view.zone);
  };
  return (
    <div className={`app ${p.theme} ${p.density}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brandmark">▦</span>
          <div>
            CardGrid<small>卡格工作台</small>
          </div>
        </div>
        <div className="navcaption">我的空间</div>
        <nav>
          {(
            [
              ['agenda', 'Today', '▦'],
              ['inbox', 'Inbox', '＋'],
              ['schedule', 'Schedule', '◫'],
              ['definitions', '行动定义', '❖'],
              ['workshop', '制卡工坊', '❐'],
              ['hand', '抽卡手牌', '✦'],
              ['journal', '日记', '✎'],
              ['config', '配置工坊', '◇'],
              ['data', '数据与备份', '↗'],
            ] as const
          ).map(([id, label, icon]) => (
            <button
              key={id}
              aria-current={tab === id ? 'page' : undefined}
              className={tab === id ? 'active' : ''}
              onClick={() => void navigate(id)}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <span className="dot" />
          数据保存在本机
          <div className="version">
            {import.meta.env.VITE_CARDGRID_VERSION
              ? `v${import.meta.env.VITE_CARDGRID_VERSION}`
              : '开发构建'}
            {' · 每日日记'}
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumbs">
            工作台 / <strong>{TAB_META[tab].en}</strong> {TAB_META[tab].zh}
          </div>
          <button
            onClick={() => {
              if (dirty && !confirm('重新载入将放弃配置草稿，继续？')) return;
              void reload();
            }}
          >
            重新载入
          </button>
        </header>
        {message && (
          <div className="message" role="status">
            <span>{message}</span>
            <button aria-label="关闭提示" onClick={() => setMessage('')}>
              ×
            </button>
            {retry.current && (
              <button disabled={busy} onClick={() => void submit(retry.current!)}>
                重试本次保存
              </button>
            )}
          </div>
        )}
        {readOnly && (
          <section className="message">
            <strong>旧工作区只读</strong>
            <span>原文已保留。查看、备份、恢复与清空可用；请在“数据与备份”审阅后显式升级。</span>
          </section>
        )}
        <section className="heading page-heading" aria-label="当前页面">
          <div className="eyebrow">{TAB_META[tab].en}</div>
          <h1>{TAB_META[tab].zh}</h1>
          <p>{TAB_META[tab].desc}</p>
        </section>
        {(tab === 'definitions' || tab === 'hand') &&
          (tab === 'definitions' ? (
            <ActionLibrary key={snapshot.token.epoch} client={client} />
          ) : (
            <ActionHand
              key={snapshot.token.epoch}
              client={client}
              drawing={drawing}
              onData={() => navigation('data')}
              onToday={() => navigation('agenda')}
            />
          ))}
        {tab === 'workshop' && (
          <WorkshopEditor
            key={snapshot.token.epoch}
            host={workshopHost}
            onUpgrade={() => navigation('data')}
          />
        )}
        {tab === 'journal' && (
          <JournalWorkbench
            key={snapshot.token.epoch}
            client={client}
            readOnly={readOnly}
            registerSaveGuard={registerJournalSaveGuard}
          />
        )}
        {tab === 'agenda' && (
          <section className="panel">
            <button type="button" className="primary" onClick={() => navigation('hand')}>
              去抽卡
            </button>
          </section>
        )}
        {tab === 'agenda' && !readOnly && (
          <>
            <DayBoard
              key={workspaceEpoch}
              client={client}
              preparationRevision={preparationRevision}
              initialView={currentTodayView}
              onViewChange={rememberTodayView}
              handRequest={handRequest?.token.epoch === workspaceEpoch ? handRequest : null}
              onHandRequestHandled={handHandled}
            />
            <section className="panel">
              <h2>准备日型</h2>
              <div className="toolbar">
                <label>
                  准备日型
                  <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                    <option value="">按适用星期选择</option>
                    {snapshot.data?.planner.templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={busy || todayView?.epoch !== snapshot.token.epoch}
                  onClick={() =>
                    void command('PrepareDay', { date, zone, templateId: templateId || null })
                  }
                >
                  准备这一天
                </button>
              </div>
              <p className="muted">
                为当前查看日期 {date}（{zone}）准备日型。打开和切换日期不会生成安排。
              </p>
            </section>
          </>
        )}
        {(tab === 'schedule' || (tab === 'agenda' && readOnly)) && (
          <>
            <section className="panel">
              <div className="toolbar">
                <button aria-label="查看前一天" onClick={() => stepDate(-1)}>
                  前一天
                </button>
                <strong>{date}</strong>
                <button aria-label="查看后一天" onClick={() => stepDate(1)}>
                  后一天
                </button>
                <label>
                  显示时区
                  <input
                    aria-label="显示时区"
                    value={zone}
                    onChange={(e) => {
                      client.invalidateCapabilities();
                      setZone(e.target.value);
                    }}
                  />
                </label>
                <label>
                  准备日型
                  <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                    <option value="">按适用星期选择</option>
                    {snapshot.data?.planner.templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={busy || readOnly}
                  onClick={() =>
                    void command('PrepareDay', { date, zone, templateId: templateId || null })
                  }
                >
                  准备这一天
                </button>
              </div>
              <p className="muted">
                打开和切换日期不会生成安排。此处展示完整时间记录；排期、改期和实际确认请到 Today。
              </p>
            </section>
            {day && (
              <section className="panel">
                <h2>完整时间记录</h2>
                {!day.occupancyKnown && (
                  <p role="alert">有尚未解释的占用时间，当前不提供空闲时段。</p>
                )}
                {day.segments.length ? (
                  day.segments.map((segment) => (
                    <p key={segment.id}>
                      <strong>{segment.title}</strong> · {segment.label} {segment.offsetLabel}{' '}
                      {segment.continuesBefore ? '开始于 ' + segment.startDate : ''}{' '}
                      {segment.continuesAfter ? '续次日 →' : ''}
                    </p>
                  ))
                ) : (
                  <p>没有已保存的时间记录。</p>
                )}
                {day.legacyItems.map((item, i) => (
                  <p key={item.source.path + i}>
                    旧版只读 · {item.title} ·{' '}
                    {item.range
                      ? item.range.startAt + ' — ' + item.range.endAt
                      : item.occupancy === 'unknown'
                        ? '占用时间尚未解释，不作为空闲'
                        : '原文保留'}
                  </p>
                ))}
              </section>
            )}
            <fieldset
              disabled
              style={{ border: 0, padding: 0, minWidth: 0 }}
              aria-label="旧版页面只读"
              key={snapshot.token.epoch + tab}
            >
              {tab === 'agenda' ? (
                <Today data={data} date={date} onSave={oldSave} onDateChange={stepDate} />
              ) : (
                <ScheduleView data={data} date={date} onSave={oldSave} onDateChange={stepDate} />
              )}
            </fieldset>
          </>
        )}
        {(tab === 'agenda' || tab === 'inbox') && !readOnly && (
          <section className="panel">
            <h2>记录到收件箱</h2>
            <div className="captureline">
              <input
                aria-label="记录到收件箱"
                disabled={busy}
                value={capture}
                onChange={(e) => setCapture(e.target.value)}
                placeholder="先记下来，稍后整理"
              />
              <button
                disabled={busy || !capture.trim()}
                onClick={() =>
                  void command('CreateCapture', { text: capture, source: 'quick_capture' })
                }
              >
                保存记录
              </button>
            </div>
          </section>
        )}
        {tab === 'inbox' && (
          <>
            <p className="message">旧版整理操作只读；新版行动转换将在后续阶段接入。</p>
            <fieldset
              disabled
              style={{ border: 0, padding: 0, minWidth: 0 }}
              aria-label="旧版收件箱只读"
              key={snapshot.token.epoch}
            >
              <InboxView data={data} onSave={oldSave} />
            </fieldset>
          </>
        )}
        {tab === 'config' && (
          <ConfigurationPanel
            {...{
              readOnly,
              draft,
              editor,
              json,
              busy,
              setDraft,
              setEditor,
              setMessage,
              setJson,
              changeSettings,
              saveSettings,
              previewFile,
              setTab,
            }}
          />
        )}
        {tab === 'data' && (
          <DataPage
            dataVersion={snapshot?.data?.version}
            {...{
              client,
              readOnly,
              backup,
              saved,
              setSaved,
              file,
              merge,
              setMerge,
              setPending,
              fileText,
              previewFile,
              prepareBackup,
              setMessage,
              download,
              recovery,
              zone,
              setZone,
              offsets,
              setOffsets,
              migration,
              pending,
              readonlyPaths,
              setReadonlyPaths,
              resetText,
              setResetText,
              discard,
              setDiscard,
              busy,
              execute,
            }}
          />
        )}
        <input
          ref={file}
          aria-label="导入文件选择"
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const selected = e.target.files?.[0];
            if (selected) {
              if (selected.size > MAX_INPUT_BYTES)
                setMessage(`文件超过 ${MAX_INPUT_BYTES / 1024 / 1024} MiB`);
              else void selected.text().then(previewFile);
            }
            e.target.value = '';
          }}
        />
        <footer>
          <span>CardGrid · 卡格工作台</span>
          <span>所有改动保存在此浏览器 · 建议定期导出备份</span>
        </footer>
      </main>
      <GlobalHandDock
        view={
          snapshot.data ? { token: snapshot.token, items: legacyDockItems(snapshot.data) } : null
        }
        isToday={tab === 'agenda' && !readOnly}
        busy={busy}
        onPlay={
          !readOnly
            ? async (item, view) => {
                if (handRoute.current !== 'agenda' || handLock.current) return;
                handLock.current = true;
                try {
                  const live = await client.load();
                  if (handRoute.current !== 'agenda') return;
                  if (!live.ok) {
                    setMessage(live.message);
                    return;
                  }
                  if (
                    live.value.token.epoch !== view.token.epoch ||
                    live.value.token.revision !== view.token.revision
                  ) {
                    setMessage('手牌已更新，请重新选择');
                    return;
                  }
                  if (
                    !live.value.data ||
                    !legacyDockItems(live.value.data).some(
                      (i) => i.key === item.key && i.version === item.version,
                    )
                  ) {
                    setMessage('这份手牌已不在手中，请重新选择');
                    return;
                  }
                  setHandRequest({ requestId: crypto.randomUUID(), token: view.token, item });
                } finally {
                  handLock.current = false;
                }
              }
            : undefined
        }
      />
    </div>
  );
}
