import { useState } from 'react';
import {
  configurationExample,
  CONFIGURATION_AI_PROMPT,
  MAX_INPUT_BYTES,
  type V06Host,
} from '../../workspace/index.ts';
import { download } from '../files.ts';
export function V06Configuration({
  host,
  onMessage,
}: {
  host: V06Host;
  onMessage: (text: string) => void;
}) {
  const [preview, setPreview] = useState<Awaited<
      ReturnType<V06Host['previewCatalogImport']>
    > | null>(null),
    [mode, setMode] = useState<'merge' | 'replace'>('merge'),
    [saved, setSaved] = useState(false),
    [evidence, setEvidence] = useState<Awaited<ReturnType<V06Host['prepareBackup']>> | null>(null),
    [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : '配置操作失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section style={{ overflowWrap: 'anywhere' }} aria-label="通用配置">
      <h2>通用配置与 AI 生成</h2>
      <button
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const r = await host.exportConfiguration();
            if (r.ok) download('CardGrid-config-v4.json', r.value);
            else onMessage(r.message);
          })
        }
      >
        导出配置
      </button>
      <button onClick={() => download('CardGrid-config-v4-示例.json', configurationExample())}>
        下载吃饭／阅读／锻炼与独立清单示例
      </button>
      <details>
        <summary>AI 生成提示与校验入口</summary>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{CONFIGURATION_AI_PROMPT}</pre>
        <p>将 AI 生成的配置保存为 JSON，再选择文件预览。确认前会检查格式、引用和容量。</p>
      </details>
      <input
        aria-label="选择通用配置"
        type="file"
        accept=".json"
        disabled={busy}
        onChange={(e) => {
          setPreview(null);
          setEvidence(null);
          setSaved(false);
          const f = e.target.files?.[0];
          if (f)
            void run(async () => {
              if (f.size > MAX_INPUT_BYTES) throw Error('配置超过 64 MiB');
              const s = await host.loadV5();
              if (!s.ok) throw Error(s.message);
              const r = await host.previewCatalogImport({
                token: s.value.token,
                text: await f.text(),
              });
              setPreview(r);
              if (!r.ok) onMessage(r.message);
            });
        }}
      />
      {preview?.ok && (
        <>
          {preview.value.legacyMapping && (
            <details open>
              <summary>旧 ConfigV3 的自动映射（确认前不写入）</summary>
              {preview.value.legacyMapping.fields.map((a) => (
                <p key={a.actionId}>
                  行动 {a.actionId}：{a.fields.map((f) => f.id + ' / ' + f.label).join('、')}
                </p>
              ))}
              {preview.value.legacyMapping.decisions.map((d) => (
                <p key={d.id}>
                  决策 {d.id}：{d.question} → {d.ownerActionId}
                </p>
              ))}
            </details>
          )}
          <p>
            目录变更 {preview.value.changes.length}{' '}
            项；表盘设置、计划定义、模板和生成规则一并导入。原库、事实和旧日记保留。
          </p>
          <label>
            导入方式
            <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="merge">合并并更新同 ID</option>
              <option value="replace">替换配置，停用缺失对象</option>
            </select>
          </label>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await host.prepareBackup();
                setEvidence(r);
                setSaved(false);
                if (r.ok) download('CardGrid-导入前备份.json', JSON.parse(r.value.text));
                else onMessage(r.message);
              })
            }
          >
            下载导入前活动 JSON 备份
          </button>
          {evidence?.ok && JSON.parse(evidence.value.text).requiredArchives?.length > 0 && (
            <p>这份 JSON 包含归档索引；完整历史还需要此前保存的归档 ZIP。</p>
          )}
          <label>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            确认已保存这份 JSON 及所需归档 ZIP
          </label>
          <button
            disabled={busy || !saved || !evidence?.ok}
            onClick={() =>
              void run(async () => {
                if (!evidence?.ok) return;
                const proof = await host.confirmBackupEvidence({
                  ...evidence.value,
                  fileSavedConfirmed: true,
                });
                if (!proof.ok) throw Error(proof.message);
                const r = await host.submit({
                  contractVersion: 'v06-p0-1',
                  commandId: crypto.randomUUID(),
                  expected: preview.value.token,
                  type: 'ImportCatalogV4',
                  payload: {
                    previewId: preview.value.previewId,
                    mode,
                    backupEvidenceId: proof.value.evidenceId,
                  },
                });
                if (!r.ok) throw Error(r.message);
                setPreview(null);
                onMessage('通用配置已导入，原事实与日记已保留');
              })
            }
          >
            确认导入配置
          </button>
        </>
      )}
    </section>
  );
}
