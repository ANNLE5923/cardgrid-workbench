import { useEffect, useRef, useState } from 'react';
import type { V06Host } from '../../workspace/index.ts';
import type { JournalRow } from '../../journal/index.ts';
import { dateAt } from '../../daily/time.ts';
import type {
  ArchivePreview,
  ArchiveExportArtifact,
  VerifiedArchiveEvidence,
  ArchiveView,
  ArchiveIndexEntry,
  RecoveryCoverage,
} from '../../workspace/v06.ts';
function saveZip(artifact: ArchiveExportArtifact) {
  const url = URL.createObjectURL(artifact.zip),
    a = document.createElement('a');
  a.href = url;
  a.download = artifact.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function V06Archives({
  host,
  onMessage,
}: {
  host: V06Host;
  onMessage: (message: string) => void;
}) {
  const [month, setMonth] = useState(''),
    [months, setMonths] = useState<readonly string[]>([]),
    [preview, setPreview] = useState<ArchivePreview | null>(null),
    [artifact, setArtifact] = useState<ArchiveExportArtifact | null>(null),
    [verified, setVerified] = useState<VerifiedArchiveEvidence | null>(null),
    [clear, setClear] = useState<Awaited<
      ReturnType<V06Host['archivePort']['previewArchiveClear']>
    > | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [index, setIndex] = useState<readonly ArchiveIndexEntry[]>([]),
    [view, setView] = useState<ArchiveView | null>(null),
    [coverage, setCoverage] = useState<RecoveryCoverage | null>(null),
    [results, setResults] = useState<string[]>([]),
    [points, setPoints] = useState<readonly Extract<JournalRow, { kind: 'reference' }>[]>([]);
  const version = useRef(0),
    current = useRef<string | null>(null);
  const refresh = async () => {
    const seq = ++version.current,
      s = await host.loadV5();
    if (!s.ok) return;
    const r = await host.archivePort.readArchivableMonths({
        token: s.value.token,
        zone: s.value.data.settings.zone ?? 'UTC',
      }),
      i = await host.archivePort.readArchiveIndex(),
      c = await host.archivePort.readRecoveryCoverage();
    if (seq !== version.current) return;
    if (r.ok) setMonths(r.value.data.map((m) => m.month));
    else onMessage(r.message);
    if (i.ok) setIndex(i.value);
    if (c.ok) setCoverage(c.value);
  };
  useEffect(() => {
    void refresh();
    const off = host.subscribe(() => void refresh());
    return () => {
      ++version.current;
      off();
      host.cancelMonthlyArchivePreview();
      if (current.current) void host.archivePort.releaseArchive({ archiveId: current.current });
    };
  }, [host]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : '归档操作失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section style={{ overflowWrap: 'anywhere' }} aria-label="月度归档">
      <h2>月度归档与只读历史</h2>
      <p>
        导出并重新读取外部
        ZIP，核验通过后再确认移出封存记录。原库和仍有活动引用的记录继续保留；维护日志单独保存。
      </p>
      <p>归档后，完整历史恢复需要活动 JSON 与对应 ZIP。本机副本可能随浏览器数据清除而丢失。</p>
      {months.length > 0 && <p>待处理月份：{months.join('、')}；不会自动清理。</p>}
      <label>
        归档月份
        <input
          aria-label="归档月份"
          type="month"
          value={month}
          onChange={(e) => {
            host.cancelMonthlyArchivePreview();
            setMonth(e.target.value);
            setPreview(null);
            setArtifact(null);
            setVerified(null);
            setClear(null);
            setConfirmed(false);
          }}
        />
      </label>
      <button
        disabled={busy || !month}
        onClick={() =>
          void run(async () => {
            setArtifact(null);
            setVerified(null);
            setClear(null);
            setConfirmed(false);
            const s = await host.loadV5();
            if (!s.ok) throw Error(s.message);
            const r = await host.archivePort.previewMonthlyArchive({
              token: s.value.token,
              month,
              zone: s.value.data.settings.zone ?? 'UTC',
            });
            if (!r.ok) throw Error(r.message);
            setPreview(r.value);
          })
        }
      >
        预览月度归档
      </button>
      {preview && (
        <>
          <p>
            可移出 {preview.selected.length} 条；保留 {preview.retained.length} 条；正文{' '}
            {preview.bytes} 字节；日期 {preview.manifest.coveredDates.join('、')}。
          </p>
          {preview.retained.length > 0 && (
            <details>
              <summary>保留原因</summary>
              {preview.retained.map((r) => (
                <p key={r.ref.collection + ':' + r.ref.id}>
                  {r.ref.collection} · {r.ref.id} ·{' '}
                  {
                    (
                      {
                        open: '仍在使用',
                        'cross-month': '跨月未封存',
                        'live-reference': '活动引用',
                        idempotency: '重复操作防护',
                      } as const
                    )[r.reason]
                  }
                </p>
              ))}
            </details>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await host.archivePort.exportMonthlyArchive({
                  token: preview.token,
                  previewId: preview.previewId,
                });
                if (!r.ok) throw Error(r.message);
                setArtifact(r.value);
                setVerified(null);
                setClear(null);
                setConfirmed(false);
                saveZip(r.value);
                onMessage('ZIP 已请求下载；请重新选择实际保存的外部文件进行核验');
              })
            }
          >
            下载归档 ZIP
          </button>
        </>
      )}
      {artifact && (
        <>
          <p>
            {artifact.filename} · {artifact.compressedBytes} 字节
          </p>
          <button
            disabled={busy}
            onClick={() => {
              const pending = host.archivePort.verifySavedArchive({
                token: artifact.token,
                exportId: artifact.exportId,
              });
              void run(async () => {
                setVerified(null);
                setClear(null);
                setConfirmed(false);
                const v = await pending;
                if (!v.ok) throw Error(v.message);
                const c = await host.archivePort.previewArchiveClear({
                  token: artifact.token,
                  previewId: artifact.previewId,
                  verificationId: v.value.verificationId,
                });
                if (!c.ok) throw Error(c.message);
                setVerified(v.value);
                setClear(c);
              });
            }}
          >
            重新选择外部 ZIP 并核验
          </button>
        </>
      )}
      {verified && clear?.ok && (
        <>
          <p>外部文件核验通过：{verified.recordsSha256}</p>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            确认移出这次预览中的 {clear.value.removableCount} 条封存记录；历史只能只读查看
          </label>
          <button
            disabled={busy || !confirmed}
            onClick={() =>
              void run(async () => {
                const r = await host.submit({
                  contractVersion: 'v06-p0-1',
                  commandId: crypto.randomUUID(),
                  expected: clear.value.token,
                  type: 'CommitMonthlyArchive',
                  payload: {
                    previewId: artifact!.previewId,
                    verificationId: verified.verificationId,
                    clearPreviewId: clear.value.clearPreviewId,
                    removalConfirmed: true,
                  },
                });
                if (!r.ok) throw Error(r.message);
                setPreview(null);
                setArtifact(null);
                setVerified(null);
                setClear(null);
                setConfirmed(false);
                await refresh();
                onMessage('封存记录已归档；原库、活动依赖和清理前恢复点已保留');
              })
            }
          >
            确认归档并移出活动记录
          </button>
        </>
      )}
      <h3>导入与查看历史</h3>
      <input
        aria-label="导入多个归档 ZIP"
        type="file"
        accept=".zip"
        multiple
        disabled={busy}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void run(async () => {
            const messages = [];
            for (const file of files) {
              const r = await host.archivePort.importArchive({ zip: file, filename: file.name });
              messages.push(
                `${file.name}：${r.ok ? (r.value.disposition === 'duplicate' ? '重复包，已保留原副本' : '已登记只读归档') : r.message}`,
              );
            }
            setResults(messages);
            await refresh();
          });
        }}
      />
      {results.map((r, i) => (
        <p key={i}>{r}</p>
      ))}
      {coverage && (
        <p role={coverage.complete ? 'status' : 'alert'}>
          {coverage.complete
            ? '本机已登记所有必需 ZIP'
            : '历史覆盖不完整；缺少 ' +
              coverage.missing.map((r) => r.archiveId).join('、') +
              '。活动 JSON 仍可使用。'}
        </p>
      )}
      {index.map((i) => (
        <p key={i.archiveId}>
          {i.month} · {i.zone} · 来源 {i.workspaceId} · {i.archiveId}{' '}
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setView(null);
                setPoints([]);
                if (current.current)
                  await host.archivePort.releaseArchive({ archiveId: current.current });
                current.current = i.archiveId;
                const r = await host.archivePort.readArchive({ archiveId: i.archiveId });
                if (!r.ok) throw Error(r.message);
                const pointRows: Extract<JournalRow, { kind: 'reference' }>[] = [];
                for (const date of r.value.index.coveredDates) {
                  const p = await host.readArchivedJournalProjection({
                    archiveId: i.archiveId,
                    date,
                    zone: i.zone,
                  });
                  if (!p.ok) throw Error(p.message);
                  pointRows.push(
                    ...p.value.projection.rows.filter(
                      (row): row is Extract<JournalRow, { kind: 'reference' }> =>
                        row.kind === 'reference',
                    ),
                  );
                }
                setPoints(pointRows);
                setView(r.value);
              })
            }
          >
            只读查看 {i.archiveId}
          </button>
        </p>
      ))}
      {view && (
        <article aria-label="历史归档只读">
          <h3>{view.index.month} · 历史归档／只读</h3>
          <p>
            事实 {view.facts.length}；计划 {view.plans.length}；批注 {view.annotations.length}
            。查看只加载一个包。
          </p>
          {view.journal.map((day) => (
            <div key={day.date}>
              <h4>{day.date}</h4>
              {day.automatic.map((a) => (
                <div key={a.sourceKey}>
                  <p>
                    {a.title} · {a.clippedRange.localStart} — {a.clippedRange.localEnd}
                  </p>
                  {a.referenceAnswers.map((answer, i) => (
                    <p key={i}>
                      参考：{answer.question} · {answer.entry.title}
                    </p>
                  ))}
                </div>
              ))}
              {points
                .filter((row) => dateAt(row.point.at, view.index.zone) === day.date)
                .map((row) => (
                  <p key={row.id}>
                    独立参考 {row.point.localTime}：{row.answer.question} · {row.answer.entry.title}
                  </p>
                ))}
              {day.notes.map((n) => (
                <p key={n.id} style={{ whiteSpace: 'pre-wrap' }}>
                  {n.recordedAt} · {n.text}
                  {n.updatedAt !== n.createdAt && <> · 修改于 {n.updatedAt}</>}
                </p>
              ))}
              {day.legacyBlocks.map((b) => (
                <pre key={b.id} style={{ whiteSpace: 'pre-wrap' }}>
                  {b.text}
                </pre>
              ))}
            </div>
          ))}
          {view.annotations.length > 0 && (
            <>
              <h4>事实批注</h4>
              {view.annotations.map((a) => (
                <p key={a.id} style={{ whiteSpace: 'pre-wrap' }}>
                  {a.createdAt} · {a.text}
                </p>
              ))}
            </>
          )}
          <button
            onClick={() =>
              void run(async () => {
                await host.archivePort.releaseArchive({ archiveId: view.index.archiveId });
                current.current = null;
                setView(null);
                setPoints([]);
              })
            }
          >
            关闭历史并释放内存
          </button>
        </article>
      )}
    </section>
  );
}
