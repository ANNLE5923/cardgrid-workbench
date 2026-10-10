import { useEffect, useRef, useState } from 'react';
import { MAX_INPUT_BYTES, type V06Host } from '../../workspace/index.ts';
import { download } from '../files.ts';

type HostCommand = Parameters<V06Host['submit']>[0];
type Props = Readonly<{
  host: V06Host;
  busy: boolean;
  onMessage: (message: string) => void;
  onSubmit: (command: HostCommand) => Promise<boolean>;
}>;

/** Owns file selection and its preview together, so a late read cannot confirm
 * a different file. The parent owns the one durable command and its retry. */
export function BackupRestore({ host, busy, onMessage, onSubmit }: Props) {
  const [backup, setBackup] = useState<Awaited<ReturnType<V06Host['prepareBackup']>> | null>(null);
  const [saved, setSaved] = useState(false);
  const [restore, setRestore] = useState<Awaited<ReturnType<V06Host['previewRestore']>> | null>(
    null,
  );
  const [reading, setReading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [filename, setFilename] = useState('');
  const selection = useRef(0);
  const preparation = useRef(0);
  const [recoveryPoints, setRecoveryPoints] = useState<
    readonly { pointKey: string; createdAt: string; reason: string }[]
  >([]);
  const [recoveryTarget, setRecoveryTarget] = useState<Awaited<
    ReturnType<V06Host['previewRecoveryPoint']>
  > | null>(null);
  useEffect(
    () => () => {
      ++selection.current;
      ++preparation.current;
    },
    [],
  );
  const refreshRecoveryPoints = async () => {
    const result = await host.readRecoveryPoints();
    if (result.ok) setRecoveryPoints(result.value);
  };
  useEffect(() => {
    void refreshRecoveryPoints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);
  const askGoBack = async (pointKey: string) => {
    const snapshot = await host.loadV5();
    if (!snapshot.ok) {
      onMessage(snapshot.message);
      return;
    }
    const result = await host.previewRecoveryPoint({ token: snapshot.value.token, pointKey });
    if (!result.ok) onMessage(result.message);
    else if (result.value.blocked) onMessage(result.value.message);
    else setRecoveryTarget(result);
  };

  const prepare = async () => {
    const seq = ++preparation.current;
    setPreparing(true);
    setBackup(null);
    setSaved(false);
    try {
      const result = await host.prepareBackup();
      if (seq !== preparation.current) return;
      setBackup(result);
      if (result.ok) download('CardGrid-活动与归档索引备份.json', JSON.parse(result.value.text));
      else onMessage(result.message);
    } catch (error) {
      if (seq === preparation.current)
        onMessage(error instanceof Error ? error.message : '备份下载未完成');
    } finally {
      if (seq === preparation.current) setPreparing(false);
    }
  };

  const selectFile = async (file?: File) => {
    const seq = ++selection.current;
    setRestore(null);
    setFilename(file?.name ?? '');
    setReading(false);
    if (!file) return;
    if (file.size > MAX_INPUT_BYTES) {
      onMessage('输入超过 64 MiB，未读取或恢复');
      return;
    }
    setReading(true);
    try {
      const text = await file.text();
      if (seq !== selection.current) return;
      const snapshot = await host.loadV5();
      if (seq !== selection.current) return;
      if (!snapshot.ok) {
        onMessage(snapshot.message);
        return;
      }
      const result = await host.previewRestore({ token: snapshot.value.token, text });
      if (seq !== selection.current) return;
      setRestore(result);
      if (!result.ok) onMessage(result.message);
    } catch (error) {
      if (seq === selection.current)
        onMessage(error instanceof Error ? error.message : '备份读取未完成');
    } finally {
      if (seq === selection.current) setReading(false);
    }
  };

  return (
    <section aria-label="备份与恢复">
      <h2>备份与恢复</h2>
      <button disabled={busy || preparing} onClick={() => void prepare()}>
        下载活动 JSON 与归档索引备份
      </button>
      <label>
        <input
          type="checkbox"
          checked={saved}
          disabled={!backup?.ok || preparing || busy}
          onChange={(e) => setSaved(e.target.checked)}
        />
        确认备份已保存
      </label>
      <input
        aria-label="选择恢复备份"
        type="file"
        accept=".json"
        disabled={busy}
        onChange={(e) => void selectFile(e.target.files?.[0])}
      />
      {reading && <p role="status">正在读取恢复备份：{filename}</p>}
      {restore?.ok && (
        <>
          <p>待恢复文件：{filename}</p>
          {restore.value.coverage && (
            <p role={restore.value.coverage.complete ? 'status' : 'alert'}>
              完整历史另需 {restore.value.coverage.required.length} 个 ZIP；
              {restore.value.coverage.complete
                ? '本机已登记匹配包'
                : '缺少 ' +
                  restore.value.coverage.missing
                    .map((r) => r.archiveId + ' / ' + r.recordsSha256)
                    .join('、') +
                  '。恢复后活动区可用，历史覆盖不完整。'}
            </p>
          )}
          <p>恢复将精确替换当前工作区及日记，维护日志单独保留。</p>
          <button
            disabled={!saved || !backup?.ok || busy || reading || preparing}
            onClick={() => {
              if (!backup?.ok) return;
              void onSubmit({
                commandId: crypto.randomUUID(),
                type: 'RestoreWorkspace',
                expected: restore.value.token,
                payload: {
                  previewId: restore.value.previewId,
                  backup: {
                    token: backup.value.token,
                    dataFingerprint: backup.value.dataFingerprint,
                    fileSavedConfirmed: true,
                  },
                  discardDraftsConfirmed: true,
                },
              });
            }}
          >
            确认丢弃草稿并恢复
          </button>
        </>
      )}
      <h3>本机恢复点</h3>
      {recoveryPoints.length ? (
        recoveryPoints.map((point) => (
          <div
            key={point.pointKey}
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              alignItems: 'center',
              margin: '6px 0',
            }}
          >
            <span style={{ minWidth: 72 }}>{point.pointKey}</span>
            <button disabled={busy} onClick={() => void askGoBack(point.pointKey)}>
              回到刚才
            </button>
          </div>
        ))
      ) : (
        <p>尚无恢复点。</p>
      )}
      {recoveryTarget?.ok && (
        <div role="alert">
          <p>回到恢复点「{recoveryTarget.value.pointKey}」？</p>
          <p>会放弃这之后的全部改动；已确认事实不会被回退。</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              disabled={busy}
              onClick={() => {
                const target = recoveryTarget.value;
                setRecoveryTarget(null);
                void onSubmit({
                  commandId: crypto.randomUUID(),
                  type: 'RestoreRecoveryPoint',
                  expected: target.token,
                  payload: {
                    pointKey: target.pointKey,
                    targetFingerprint: target.targetFingerprint,
                    confirmed: true,
                  },
                }).then(() => void refreshRecoveryPoints());
              }}
            >
              确认回到刚才
            </button>
            <button onClick={() => setRecoveryTarget(null)}>取消</button>
          </div>
        </div>
      )}
    </section>
  );
}
