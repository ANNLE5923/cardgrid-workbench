import { useEffect, useRef, useState } from 'react';
import type { V06Host } from '../../workspace/index.ts';
import type {
  FileResult,
  TextConnectionView,
  TextOutputState,
  TextSyncStatus,
} from '../../workspace/v06.ts';
import './v06-text-files.css';
const labels: Record<TextSyncStatus, string> = {
  unsupported: '此浏览器不支持目录自动写入，可下载文本',
  disconnected: '未连接',
  idle: '已连接',
  pending: '待同步',
  writing: '正在写入',
  synced: '已同步',
  'permission-required': '需要重新授权',
  failed: '文件写入失败',
  'conflict-copy-failed': '外部修改副本失败，原文件未覆盖',
  'reconcile-required': '落盘状态待核对',
  'paused-after-replace': '工作区已替换，同步暂停',
};

/** B-owned composition. A7 can use the same Host file port. */
export function V06TextFiles({
  host,
  date,
  zone,
  epoch,
}: Readonly<{ host: V06Host; date: string; zone: string; epoch: string }>) {
  const files = host.textFilePort;
  const [connection, setConnection] = useState<TextConnectionView | null>(null),
    [outputs, setOutputs] = useState<readonly TextOutputState[]>([]),
    [suffix, setSuffix] = useState<'md' | 'txt'>('md'),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const refresh = async () => {
    const seq = ++generation.current,
      r = await files.readActiveTextConnection();
    if (seq !== generation.current) return;
    if (!r.ok) {
      setMessage(r.message);
      return;
    }
    setConnection(r.value);
    if (r.value) {
      const s = await files.readTextSyncState({ bindingId: r.value.bindingId });
      if (seq === generation.current) {
        if (s.ok) setOutputs(s.value.outputs);
        else setMessage(s.message);
      }
    } else setOutputs([]);
  };
  useEffect(() => {
    void refresh();
    const off = files.subscribe(() => void refresh());
    return () => {
      ++generation.current;
      off();
    };
  }, [files]);
  const perform = async <T,>(pending: Promise<FileResult<T>>) => {
    setBusy(true);
    try {
      const r = await pending;
      setMessage(r.ok ? '文件请求已处理，请查看同步状态' : r.message);
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const reconnect = () =>
    connection &&
    perform(
      files.reconnectTextDirectory({
        bindingId: connection.bindingId,
        connectionVersion: connection.connectionVersion,
        epoch,
        suffix,
      }),
    );
  const download = async (kind: 'journal' | 'maintenance') => {
    const r = await files.prepareTextDownload({ kind, date, zone });
    if (!r.ok) {
      setMessage(r.message);
      return;
    }
    const url = URL.createObjectURL(new Blob([r.value.text], { type: 'text/plain;charset=utf-8' })),
      a = document.createElement('a');
    a.href = url;
    a.download = `CardGrid-${kind}-${date}.${suffix}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setMessage('已请求下载文本，请核对下载文件；自动同步状态未改变');
  };
  return (
    <section className="v06-text-files" aria-label="文本文件">
      <h2>文本文件</h2>
      <p role="status">
        文件状态：
        {!files.supported ? labels.unsupported : connection ? labels[connection.status] : '未连接'}
        {connection ? ` · 待写 ${connection.pendingCount} 项` : ''}
      </p>
      <p>业务保存与文件同步分别显示。外部修改会先保存原字节副本，再恢复最近成功输出。</p>
      <label>
        文本后缀
        <select
          value={suffix}
          disabled={busy}
          onChange={(e) => setSuffix(e.target.value as 'md' | 'txt')}
        >
          <option value="md">.md</option>
          <option value="txt">.txt</option>
        </select>
      </label>
      <button
        disabled={busy || !files.supported}
        onClick={() => void perform(files.connectTextDirectory({ epoch, suffix }))}
      >
        连接文本目录
      </button>
      {connection && (
        <>
          <p>
            目录连接 {connection.bindingId} · 版本 {connection.connectionVersion} · 工作区{' '}
            {connection.epoch} · 当前 .{connection.suffix}
          </p>
          <button disabled={busy || !files.supported} onClick={() => void reconnect()}>
            {connection.status === 'paused-after-replace'
              ? '确认继续为当前工作区写入'
              : suffix !== connection.suffix
                ? '确认启用新后缀（保留旧文件）'
                : '重新授权并补写'}
          </button>
          <button
            disabled={busy || connection.epoch !== epoch || connection.status === 'disconnected'}
            onClick={() =>
              void perform(
                files.refreshTextFiles({
                  bindingId: connection.bindingId,
                  connectionVersion: connection.connectionVersion,
                  epoch,
                }),
              )
            }
          >
            主动刷新文件
          </button>
          <button
            disabled={busy || connection.status === 'disconnected'}
            onClick={() =>
              void perform(
                files.disconnectTextDirectory({
                  bindingId: connection.bindingId,
                  connectionVersion: connection.connectionVersion,
                }),
              )
            }
          >
            断开目录
          </button>
        </>
      )}
      <div>
        <button onClick={() => void download('journal')}>下载本日日记文本</button>
        <button onClick={() => void download('maintenance')}>下载本日维护文本</button>
      </div>
      {message && <p role="status">{message}</p>}
      {outputs
        .filter((o) => o.key.date === date && o.key.zone === zone)
        .map((o) => (
          <article key={JSON.stringify(o.key)}>
            <p>
              {o.key.kind === 'journal' ? '日记' : '维护日志'} · {o.key.date} · {o.key.zone} ·{' '}
              {labels[o.status]}
            </p>
            {o.lastSuccess && (
              <p>
                最近核验成功：{o.lastSuccess.succeededAt} · SHA-256 {o.lastSuccess.sha256}
              </p>
            )}
            {o.error && <p role="alert">{o.error}</p>}
            {o.externalCopyPath && <p>外部修改副本：{o.externalCopyPath}</p>}
            <button
              disabled={busy || connection?.epoch !== epoch}
              onClick={() => void perform(files.retryTextOutput({ key: o.key }))}
            >
              补写此文件
            </button>
          </article>
        ))}
    </section>
  );
}
