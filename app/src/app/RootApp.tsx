import { useEffect, useMemo, useRef, useState } from 'react';
import { createV06Host } from '../workspace/index.ts';
import { App as LegacyApp } from './App.tsx';
import { V06App } from './v06/V06App.tsx';
import { download } from './files.ts';
export function RootApp() {
  const host = useMemo(() => createV06Host(), []),
    flush = useRef<() => Promise<boolean>>(async () => true);
  const [current, setCurrent] = useState<{ version: number; epoch: string } | null>(null),
    [error, setError] = useState(''),
    [preview, setPreview] = useState<Awaited<ReturnType<typeof host.previewMigrationV5>> | null>(
      null,
    ),
    [backup, setBackup] = useState<Awaited<ReturnType<typeof host.prepareBackup>> | null>(null),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true,
      seq = 0;
    const read = async () => {
      const generation = ++seq,
        r = await host.load();
      if (!active || generation !== seq) return;
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setCurrent({
        version:
          r.value.data && typeof r.value.data === 'object' && 'version' in r.value.data
            ? Number(r.value.data.version)
            : 0,
        epoch: r.value.token.epoch,
      });
    };
    void read();
    const off = host.subscribe(() => void read());
    return () => {
      active = false;
      off();
      void flush.current().finally(() => host.close());
    };
  }, [host]);
  const prepare = async () => {
    setBusy(true);
    try {
      const b = await host.prepareBackup();
      setBackup(b);
      setSaved(false);
      if (!b.ok) {
        setError(b.message);
        return;
      }
      download('CardGrid-升级前完整备份.json', JSON.parse(b.value.text));
      const p = await host.previewMigrationV5({ token: b.value.token });
      setPreview(p);
      if (!p.ok) setError(p.message);
    } finally {
      setBusy(false);
    }
  };
  const migrate = async () => {
    if (!preview?.ok || !backup?.ok || !saved) return;
    setBusy(true);
    const r = await host.submit({
      type: 'CommitMigration',
      commandId: crypto.randomUUID(),
      expected: preview.value.token,
      payload: {
        previewId: preview.value.previewId,
        backup: {
          token: backup.value.token,
          dataFingerprint: backup.value.dataFingerprint,
          fileSavedConfirmed: true,
        },
        discardDraftsConfirmed: true,
      },
    });
    setBusy(false);
    if (!r.ok) setError(r.message);
    else {
      setPreview(null);
      setBackup(null);
      setError('');
    }
  };
  if (!current) return <p role="status">{error || '正在读取本地工作区'}</p>;
  if (current.version === 5)
    return (
      <V06App
        key={current.epoch}
        host={host}
        registerFlush={(fn) => {
          flush.current = fn;
        }}
      />
    );
  return (
    <>
      {current.version === 4 && (
        <aside className="v06-upgrade" aria-label="通用卡牌升级">
          <button disabled={busy} onClick={() => void prepare()}>
            预览通用卡牌升级
          </button>
          {preview?.ok && (
            <>
              <p>将保留原事实、原库版本、旧日记全文及升级前恢复点。确认后启用 v0.6 通用卡牌。</p>
              <p>
                升级后入口为 Today、工坊、抽卡与决策、时间线日记、维护日志、备份与恢复。旧
                Inbox、行动定义和项目数据保留在备份中，这些独立页面尚未接入新入口；需要继续使用时，可精确恢复升级前备份。
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={saved}
                  onChange={(e) => setSaved(e.target.checked)}
                />
                升级前完整备份已保存
              </label>
              <button disabled={!saved || busy} onClick={() => void migrate()}>
                确认升级并丢弃旧草稿
              </button>
              <button
                onClick={() => {
                  host.invalidateCapabilities();
                  setPreview(null);
                }}
              >
                取消升级
              </button>
            </>
          )}
          {error && <p role="alert">{error}</p>}
        </aside>
      )}
      <LegacyApp />
    </>
  );
}
