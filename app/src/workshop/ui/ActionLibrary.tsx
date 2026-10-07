import { useCallback, useEffect, useRef, useState } from 'react';
import type { Command, Content, Id, SubmitResult } from '../../workspace/index.ts';
import type { WorkspaceClient } from '../../workspace/index.ts';
import type { WorkspaceSnapshot } from '../../workspace/index.ts';
import type { BackupPreparation } from '../../workspace/index.ts';
import { ActionCard, type ActionBadge } from '../../shared/ui/index.ts';
import '../../shared/ui/action.css';

type View = 'definitions' | 'json';
const PALETTE = [
  '#315e50',
  '#3c745f',
  '#336699',
  '#8a6d3b',
  '#7a4e6b',
  '#4f6d7a',
  '#9a5b47',
  '#5b6e45',
];

type FormState = {
  mode: 'new' | 'edit';
  id: Id | null;
  expectedVersion: number | null;
  title: string;
  criteria: string;
  presetText: string;
  color: string;
  categoryId: Id | null;
  minimum: boolean;
  enabled: boolean;
  parentDefinitionId: Id | null;
  projectIds: Id[];
  goalIds: Id[];
  projectLabels: Content['projectLabels'];
  goalLabels: Content['goalLabels'];
};

type Notice = { kind: 'ok' | 'err'; text: string };
type ImportPreview = Extract<
  Awaited<ReturnType<WorkspaceClient['previewDefinitions']>>,
  { ok: true }
>['value'];

function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], {
      type: 'application/json',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function ActionLibrary({ client }: { client: WorkspaceClient }) {
  const [snap, setSnap] = useState<WorkspaceSnapshot | null>(null);
  const [view, setView] = useState<View>('definitions');
  const [form, setForm] = useState<FormState | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);

  const [importText, setImportText] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [backup, setBackup] = useState<BackupPreparation | null>(null);
  const [savedConfirm, setSavedConfirm] = useState(false);

  const reload = useCallback(async () => {
    const r = await client.load();
    if (r.ok) setSnap(r.value);
    else setNotice({ kind: 'err', text: r.message });
  }, [client]);
  useEffect(() => {
    void reload();
    const off = client.subscribe(() => {
      void reload();
    });
    return () => off();
  }, [client, reload]);

  const data = snap?.data ?? null;
  const readOnly = snap?.mode === 'legacy-readonly';
  const definitions = data?.planner.definitions ?? [];
  const categories = data?.settings.categories ?? [];

  async function run(type: Command['type'], payload: unknown): Promise<boolean> {
    if (lock.current || !snap) return false;
    lock.current = true;
    setBusy(true);
    try {
      const command = {
        commandId: crypto.randomUUID(),
        expected: snap.token,
        type,
        payload,
      } as Command;
      const r: SubmitResult = await client.submit(command);
      if (!r.ok) {
        setNotice({ kind: 'err', text: r.message });
        if (r.code === 'REVISION_CONFLICT' || r.code === 'WORKSPACE_REPLACED') await reload();
        return false;
      }
      await reload();
      setNotice({ kind: 'ok', text: '已保存到本机' });
      return true;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  function patch(p: Partial<FormState>) {
    setForm((f) => (f ? { ...f, ...p } : f));
  }
  function startNew() {
    if (!data) return;
    setForm({
      mode: 'new',
      id: null,
      expectedVersion: null,
      title: '',
      criteria: '',
      presetText: String(data.settings.preferences.defaultMinutes ?? ''),
      color: PALETTE[definitions.length % PALETTE.length],
      categoryId: null,
      minimum: false,
      enabled: true,
      parentDefinitionId: null,
      projectIds: [],
      goalIds: [],
      projectLabels: [],
      goalLabels: [],
    });
    setNotice(null);
  }
  function edit(d: (typeof definitions)[number]) {
    setForm({
      mode: 'edit',
      id: d.id,
      expectedVersion: d.version,
      title: d.content.title,
      criteria: d.content.criteria,
      presetText: d.content.presetMinutes === null ? '' : String(d.content.presetMinutes),
      color: d.content.color,
      categoryId: d.content.categoryId,
      minimum: d.content.minimum,
      enabled: d.enabled,
      parentDefinitionId: d.parentDefinitionId,
      projectIds: [...d.content.projectIds],
      goalIds: [...d.content.goalIds],
      projectLabels: d.content.projectLabels,
      goalLabels: d.content.goalLabels,
    });
    setNotice(null);
  }
  function toContent(f: FormState): Content {
    const cat = f.categoryId ? (categories.find((c) => c.id === f.categoryId) ?? null) : null;
    const preset = f.presetText.trim() === '' ? null : Number(f.presetText);
    return {
      title: f.title.trim(),
      criteria: f.criteria,
      presetMinutes: preset,
      color: f.color,
      categoryId: f.categoryId,
      categoryLabel: cat?.name ?? null,
      minimum: f.minimum,
      projectIds: f.projectIds,
      goalIds: f.goalIds,
      projectLabels: f.projectLabels,
      goalLabels: f.goalLabels,
    };
  }
  async function save() {
    if (!form || busy) return;
    if (!form.title.trim()) {
      setNotice({ kind: 'err', text: '请填写定义名称' });
      return;
    }
    const payload = {
      id: form.id,
      expectedVersion: form.expectedVersion,
      content: toContent(form),
      enabled: form.enabled,
      parentDefinitionId: form.parentDefinitionId,
    };
    if (await run('SaveDefinition', payload)) setForm(null);
  }
  async function archive(d: (typeof definitions)[number]) {
    if (await run('ArchiveDefinition', { definition: { id: d.id, version: d.version } })) {
      if (form?.id === d.id) setForm(null);
    }
  }
  async function exportPack() {
    const r = await client.exportDefinitions();
    if (r.ok) {
      download('CardGrid-配置.json', r.value);
      setNotice({ kind: 'ok', text: '配置已导出' });
    } else setNotice({ kind: 'err', text: r.message });
  }
  async function doPreview() {
    if (!snap) return;
    const r = await client.previewDefinitions({ token: snap.token, text: importText, mode });
    if (!r.ok) {
      setNotice({ kind: 'err', text: r.message });
      setPreview(null);
    } else {
      setPreview(r.value);
      setBackup(null);
      setSavedConfirm(false);
      setNotice(null);
    }
  }
  async function makeBackup() {
    const r = await client.prepareBackup();
    if (!r.ok) {
      setNotice({ kind: 'err', text: r.message });
      return;
    }
    setBackup(r.value);
    setSavedConfirm(false);
    download(`CardGrid-完整备份.json`, JSON.parse(r.value.text));
    setNotice({ kind: 'ok', text: '完整备份已生成，请确认文件已保存。' });
  }
  async function commitImport() {
    if (!preview || !backup || !savedConfirm || busy) return;
    const evidence = {
      token: backup.token,
      dataFingerprint: backup.dataFingerprint,
      fileSavedConfirmed: true as const,
    };
    if (await run('ImportDefinitions', { previewId: preview.previewId, mode, backup: evidence })) {
      setPreview(null);
      setImportText('');
      setBackup(null);
      setSavedConfirm(false);
    }
  }

  const badges = (d: (typeof definitions)[number]): ActionBadge[] => [
    { id: 'state', label: d.enabled ? '启用中' : '已停用', tone: d.enabled ? 'on' : 'off' },
    ...(d.content.minimum ? [{ id: 'min', label: '最低限度' }] : []),
    ...(d.content.categoryLabel ? [{ id: 'cat', label: d.content.categoryLabel }] : []),
  ];
  const meta = (d: (typeof definitions)[number]) =>
    `${d.content.presetMinutes === null ? '无预设时长' : d.content.presetMinutes + ' 分钟'} · v${d.version}`;

  return (
    <div className="action-shell">
      <div className="action-workbar">
        <div>
          <h1>行动定义</h1>
          <p className="sub">定义是可抽取的行动模板；编辑定义不会改动已生成的快照。</p>
        </div>
        <div className="action-viewtabs" role="tablist" aria-label="定义管理视图">
          <button
            type="button"
            role="tab"
            aria-pressed={view === 'definitions'}
            onClick={() => setView('definitions')}
          >
            表单与列表
          </button>
          <button
            type="button"
            role="tab"
            aria-pressed={view === 'json'}
            onClick={() => setView('json')}
          >
            JSON 导入导出
          </button>
        </div>
      </div>
      {notice ? (
        <div className="message action-notice" role="status">
          <span>{notice.text}</span>
          <button aria-label="关闭提示" onClick={() => setNotice(null)}>
            ×
          </button>
        </div>
      ) : null}
      {readOnly ? (
        <div className="message action-notice">
          <span>旧工作区只读：请先在“数据与备份”升级后再管理定义。</span>
        </div>
      ) : null}

      {view === 'definitions' && data ? (
        <div className="action-layout">
          <section className="panel">
            <div className="sectiontitle">
              <h2>定义列表（{definitions.length}）</h2>
              <button
                type="button"
                className="act-mini primary"
                disabled={busy || readOnly}
                onClick={startNew}
              >
                ＋ 新建定义
              </button>
            </div>
            <div className="action-list">
              {definitions.length ? (
                definitions.map((d) => (
                  <ActionCard
                    key={d.id}
                    color={d.content.color}
                    title={d.content.title}
                    meta={meta(d)}
                    badges={badges(d)}
                    selected={form?.id === d.id}
                    onOpen={() => edit(d)}
                    openLabel={`编辑 ${d.content.title}`}
                    footer={
                      <>
                        <button
                          type="button"
                          className="act-mini"
                          disabled={busy || readOnly}
                          onClick={() => edit(d)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="act-mini"
                          disabled={busy || readOnly || !d.enabled}
                          onClick={() =>
                            void run('AcceptOffer', {
                              definition: { id: d.id, version: d.version },
                              targetDate: null,
                            })
                          }
                        >
                          加入手牌（手选）
                        </button>
                        <button
                          type="button"
                          className="act-mini"
                          disabled={busy || readOnly || !d.enabled}
                          onClick={() => void archive(d)}
                        >
                          停用归档
                        </button>
                      </>
                    }
                  />
                ))
              ) : (
                <p className="emptyline">还没有定义。点击“新建定义”开始。</p>
              )}
            </div>
          </section>

          <section className="panel">
            <h2>
              {form
                ? form.mode === 'new'
                  ? '新建定义'
                  : `编辑：${form.title || form.id}`
                : '选择或新建定义'}
            </h2>
            {form ? (
              <>
                <div className="formgrid">
                  <label>
                    名称
                    <input
                      aria-label="定义名称"
                      value={form.title}
                      disabled={busy}
                      onChange={(e) => patch({ title: e.target.value })}
                      placeholder="例如 晨间阅读"
                    />
                  </label>
                  <label>
                    预设时长（分钟，5 的倍数；留空为无）
                    <input
                      aria-label="预设时长"
                      inputMode="numeric"
                      value={form.presetText}
                      disabled={busy}
                      onChange={(e) => patch({ presetText: e.target.value })}
                      placeholder="例如 30"
                    />
                  </label>
                  <label>
                    分类
                    <select
                      aria-label="分类"
                      value={form.categoryId ?? ''}
                      disabled={busy}
                      onChange={(e) => patch({ categoryId: e.target.value || null })}
                    >
                      <option value="">不分类</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    颜色
                    <input
                      type="color"
                      aria-label="颜色"
                      value={form.color}
                      disabled={busy}
                      onChange={(e) => patch({ color: e.target.value })}
                    />
                  </label>
                  <label>
                    父定义（可选）
                    <select
                      aria-label="父定义"
                      value={form.parentDefinitionId ?? ''}
                      disabled={busy}
                      onChange={(e) => patch({ parentDefinitionId: e.target.value || null })}
                    >
                      <option value="">无</option>
                      {definitions
                        .filter((x) => x.id !== form.id)
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.content.title}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
                <label style={{ marginTop: 14 }}>
                  完成标准
                  <textarea
                    aria-label="完成标准"
                    rows={3}
                    value={form.criteria}
                    disabled={busy}
                    onChange={(e) => patch({ criteria: e.target.value })}
                    placeholder="描述一个可核对的结果"
                  />
                </label>
                <div className="action-inline" style={{ marginTop: 14 }}>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.enabled}
                      disabled={busy}
                      onChange={(e) => patch({ enabled: e.target.checked })}
                    />
                    启用定义
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.minimum}
                      disabled={busy}
                      onChange={(e) => patch({ minimum: e.target.checked })}
                    />
                    最低限度事项
                  </label>
                </div>
                <div className="toolbar" style={{ marginTop: 18 }}>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || readOnly}
                    onClick={() => void save()}
                  >
                    保存定义
                  </button>
                  <button type="button" disabled={busy} onClick={() => setForm(null)}>
                    取消
                  </button>
                </div>
                {!!form.projectLabels.length || !!form.goalLabels.length ? (
                  <p className="muted" style={{ marginTop: 14 }}>
                    关联项目/目标在原页面管理，本次保存会保留这些关联。
                  </p>
                ) : null}
              </>
            ) : (
              <p className="emptyline">从左侧选择一个定义编辑，或新建定义。</p>
            )}
          </section>
        </div>
      ) : null}

      {view === 'json' && data ? (
        <div className="action-layout" style={{ gridTemplateColumns: '1fr' }}>
          <section className="panel">
            <h2>配置包导入 / 导出</h2>
            <p className="muted">
              配置包含定义、模板与例行；导入不会生成行动实例。替换模式会停用缺失的定义。
            </p>
            <div className="action-inline" style={{ margin: '10px 0' }}>
              <button type="button" disabled={busy || readOnly} onClick={() => void exportPack()}>
                导出当前配置
              </button>
              <label>
                导入方式
                <select
                  value={mode}
                  disabled={busy}
                  onChange={(e) => {
                    setMode(e.target.value as 'merge' | 'replace');
                    setPreview(null);
                  }}
                >
                  <option value="merge">合并</option>
                  <option value="replace">替换目录（保留历史身份）</option>
                </select>
              </label>
            </div>
            <textarea
              className="jsonbox"
              aria-label="配置JSON"
              value={importText}
              disabled={busy}
              onChange={(e) => {
                setImportText(e.target.value);
                setPreview(null);
              }}
              placeholder="把配置包 JSON 粘贴到这里"
            />
            <div className="toolbar" style={{ marginTop: 12 }}>
              <button
                type="button"
                disabled={busy || readOnly || !importText.trim()}
                onClick={() => void doPreview()}
              >
                预览导入
              </button>
            </div>

            {preview ? (
              <>
                <div className="import-counts">
                  <span>
                    定义 {preview.before.definitions} → {preview.after.definitions}
                  </span>
                  <span>
                    模板 {preview.before.templates} → {preview.after.templates}
                  </span>
                  <span>
                    例行 {preview.before.rules} → {preview.after.rules}
                  </span>
                  {preview.retiredDefinitions.length ? (
                    <span>停用：{preview.retiredDefinitions.join(', ')}</span>
                  ) : null}
                </div>
                <div className="import-diff">
                  <strong>差异（{preview.changes.length}）</strong>
                  <ul>
                    {preview.changes.length ? (
                      preview.changes.map((c, i) => (
                        <li key={`${c.kind}-${c.id}-${i}`}>
                          [{c.kind}] {c.id}
                          {c.before ? `（v${c.before.version} → v${c.after.version}）` : '（新增）'}
                        </li>
                      ))
                    ) : (
                      <li>无内容差异</li>
                    )}
                  </ul>
                </div>
                <div className="action-inline">
                  <button
                    type="button"
                    disabled={busy || readOnly}
                    onClick={() => void makeBackup()}
                  >
                    1. 生成并确认完整备份
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      checked={savedConfirm}
                      disabled={!backup || busy}
                      onChange={(e) => setSavedConfirm(e.target.checked)}
                    />
                    2. 我已保存这份完整备份
                  </label>
                </div>
                <div className="toolbar" style={{ marginTop: 14 }}>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || readOnly || !backup || !savedConfirm}
                    onClick={() => void commitImport()}
                  >
                    执行导入
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setPreview(null);
                      setBackup(null);
                      setSavedConfirm(false);
                    }}
                  >
                    取消
                  </button>
                </div>
              </>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
