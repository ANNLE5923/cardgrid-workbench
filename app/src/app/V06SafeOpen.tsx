import { useEffect, useState } from 'react';
import {
  friendlyCollectionName,
  type V06Host,
  type SafeOpenDiagnostic,
} from '../workspace/index.ts';
import './safe-recovery.css';

type ViewState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'ready'; diagnostic: SafeOpenDiagnostic };

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * v0.6.5 P0-A：Data v5 当前数据认证失败时的只读安全打开面。
 * 与旧版 SafeRecoveryView 同源（parseSafeRecovery + safe-recovery.css），
 * 但数据来自 host.readSafeOpen()：不经过 v5 校验器、不需要 live token，
 * 且能列出 recovery/* 恢复点。本面只读：可浏览/导出原文与恢复点、可重试，
 * 不含任何编辑/出牌/确认/恢复写回。
 */
export function V06SafeOpen({
  host,
  fatal,
  onRetry,
}: Readonly<{ host: V06Host; fatal: string; onRetry: () => void }>) {
  const [state, setState] = useState<ViewState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    void host
      .readSafeOpen()
      .then((r) => {
        if (!active) return;
        if (r.ok) setState({ status: 'ready', diagnostic: r.value });
        else setState({ status: 'failed', message: r.message });
      })
      .catch((e: unknown) => {
        if (active)
          setState({ status: 'failed', message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      active = false;
    };
  }, [host]);

  return (
    <div className="failure safe-recovery">
      <h1>安全打开（只读）</h1>
      <p className="safe-banner">
        当前工作区没能通过校验，正常编辑已停用。以下内容是从本地存储中<b>尽力提取、未经校验</b>
        的，只能查看或导出，不能编辑、出牌或确认；原始记录不会被修改。请先导出原文留存，再重试正常打开。
      </p>
      {fatal ? (
        <details className="safe-fatal">
          <summary>校验失败原因</summary>
          <pre>{fatal}</pre>
        </details>
      ) : null}

      {state.status === 'failed' ? (
        <p className="safe-error">连只读诊断也读取失败：{state.message}</p>
      ) : null}
      {state.status === 'loading' ? <p>正在读取本地诊断…</p> : null}

      {state.status === 'ready' ? (
        <>
          <p className="safe-meta">
            信封 schemaVersion {state.diagnostic.report.outer.schemaVersion} · mode{' '}
            {state.diagnostic.report.outer.mode} · dataFormat{' '}
            {state.diagnostic.report.outer.dataFormat} · 工作区{' '}
            {state.diagnostic.report.outer.epoch} · revision{' '}
            {state.diagnostic.report.outer.revision}
          </p>
          <p className="safe-summary">
            当前数据共 {state.diagnostic.report.totals.arrayCollections} 个集合、
            {state.diagnostic.report.totals.entries} 个条目， 可读取{' '}
            <b>{state.diagnostic.report.totals.readable}</b> 个，损坏{' '}
            {state.diagnostic.report.totals.malformed} 个。
          </p>

          {state.diagnostic.report.problems.length ? (
            <ul className="safe-problems">
              {state.diagnostic.report.problems.map((p, i) => (
                <li key={i}>
                  <code>{p.path}</code>：{p.message}
                </li>
              ))}
            </ul>
          ) : null}

          {state.diagnostic.report.collections
            .filter((c) => c.kind === 'array')
            .map((c) => (
              <details key={c.key} className="safe-collection" open={c.malformed > 0}>
                <summary>
                  {friendlyCollectionName(c.key)}
                  <span className={c.malformed > 0 ? 'safe-count bad' : 'safe-count'}>
                    {c.readable}/{c.total} 可读
                  </span>
                </summary>
                {c.entries.length ? (
                  <ul>
                    {c.entries.map((e) => (
                      <li key={e.index}>
                        {e.id ? <code>{e.id}</code> : null}
                        <span>{e.label}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="safe-empty">没有可读取的条目。</p>
                )}
              </details>
            ))}

          <h2 className="safe-points-title">本地恢复点（只读）</h2>
          {state.diagnostic.recoveryPoints.length ? (
            state.diagnostic.recoveryPoints.map((p) => (
              <details key={p.key} className="safe-collection safe-point">
                <summary>
                  {p.key === 'previous' ? '上一份自动留存' : p.key}
                  <span className="safe-count">
                    {p.report.outer.dataFormat} · rev {p.report.outer.revision} ·{' '}
                    {p.report.totals.entries} 条
                    {p.report.totals.malformed ? ` · ${p.report.totals.malformed} 异常` : ''}
                  </span>
                </summary>
                <p className="safe-empty">
                  {[p.reason, p.createdAt].filter(Boolean).join(' · ') || '无备注'}
                </p>
                <button
                  type="button"
                  disabled={p.rawText === null}
                  onClick={() => downloadText(`CardGrid-恢复点-${p.key}.json`, p.rawText ?? '')}
                >
                  导出该恢复点原文
                </button>
              </details>
            ))
          ) : (
            <p className="safe-empty">本地没有可读取的恢复点，请务必先导出当前原文。</p>
          )}

          <div className="safe-actions">
            <button
              type="button"
              disabled={state.diagnostic.rawText === null}
              onClick={() => downloadText('CardGrid-诊断原文.json', state.diagnostic.rawText ?? '')}
            >
              导出当前原始数据
            </button>
            <button type="button" onClick={onRetry}>
              重试正常打开
            </button>
          </div>
          <p className="safe-empty">
            写回式“一键恢复”将在后续版本提供；本版先用导出原文保证数据不丢、可读。
          </p>
        </>
      ) : null}
    </div>
  );
}
