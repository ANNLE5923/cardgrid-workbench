import { useEffect, useState } from 'react';
import type { WorkspaceClient, SafeRecoveryReport } from '../workspace/index.ts';
import { parseSafeRecovery, friendlyCollectionName } from '../workspace/index.ts';
import { download } from './files.ts';
import './safe-recovery.css';

/**
 * Read-only recovery browser (v0.6.2). It shows best-effort extracted content
 * and never allows edits. The raw record stays untouched.
 */
export function SafeRecoveryView({
  client,
  onExit,
  onRetry,
}: Readonly<{
  client: WorkspaceClient;
  onExit: () => void;
  onRetry: () => void;
}>) {
  const [report, setReport] = useState<SafeRecoveryReport | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void client.exportRaw().then((r) => {
      if (!active) return;
      if (r.ok) setReport(parseSafeRecovery(r.value));
      else setError(r.message);
    });
    return () => {
      active = false;
    };
  }, [client]);

  const exportRaw = () =>
    void client.exportRaw().then((r) => {
      if (r.ok) download('CardGrid-诊断原文.json', r.value);
      else setError(r.message);
    });

  return (
    <div className="failure safe-recovery">
      <h1>安全打开（只读）</h1>
      <p className="safe-banner">
        以下内容是从原始记录中<b>尽力提取、未经校验</b>的，只能查看，不能编辑、出牌或确认。
        原始记录没有被修改。
      </p>

      {error ? <p className="safe-error">读取原始记录失败：{error}</p> : null}
      {!report && !error ? <p>正在读取原始记录…</p> : null}

      {report ? (
        <>
          <p className="safe-meta">
            信封 schemaVersion {report.outer.schemaVersion} · mode {report.outer.mode} · dataFormat{' '}
            {report.outer.dataFormat} · revision {report.outer.revision}
          </p>
          <p className="safe-summary">
            共 {report.totals.arrayCollections} 个集合、{report.totals.entries} 个条目， 可读取{' '}
            <b>{report.totals.readable}</b> 个，损坏 {report.totals.malformed} 个。
          </p>

          {report.problems.length ? (
            <ul className="safe-problems">
              {report.problems.map((p, i) => (
                <li key={i}>
                  <code>{p.path}</code>：{p.message}
                </li>
              ))}
            </ul>
          ) : null}

          {report.collections
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
        </>
      ) : null}

      <div className="safe-actions">
        <button type="button" onClick={exportRaw}>
          导出原始数据
        </button>
        <button type="button" onClick={onRetry}>
          重试正常打开
        </button>
        <button type="button" onClick={onExit}>
          返回
        </button>
      </div>
    </div>
  );
}
