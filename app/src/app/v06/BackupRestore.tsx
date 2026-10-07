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
  useEffect(
    () => () => {
      ++selection.current;
      ++preparation.current;
    },
    [],
  );

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
    </section>
  );
}
