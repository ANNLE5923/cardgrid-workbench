import { useCallback, useEffect, useState } from 'react';
import type {
  ActionCard, BookEntry, GenerationRule, Id, Pool,
} from '../../workspace/index.ts';
import type { SaveOutcome, WorkshopHost } from '../workshop-host.ts';
import {
  type ActionForm, type BookForm, type PoolForm, type RuleForm,
  actionToForm, bookToForm, poolToForm, ruleToForm,
  emptyActionForm, emptyBookForm, emptyPoolForm, emptyRuleForm,
  formToAction, formToBook, formToPool, formToRule, parseWorkshopJson,
} from '../drafts.ts';
import type { WorkshopContext } from '../model.ts';
import {POOL_CAPACITY} from '../capacity.ts';
import {allowedParentPools} from '../hierarchy.ts';
import {PoolHierarchy} from './PoolHierarchy.tsx';
import {Sphere} from '../../shared/ui/index.ts';
import '../../shared/ui/action.css';

type Kind = 'book' | 'action' | 'pool' | 'rule';
type AnyForm = BookForm | ActionForm | PoolForm | RuleForm;
type WorkshopEntity = ActionCard | BookEntry | Pool | GenerationRule;
type Notice = { kind: 'ok' | 'err'; text: string };

const KIND_LABEL: Record<Kind, string> = { book: '书目', action: '行动原卡', pool: '卡池', rule: '生成规则' };

function listFor(kind: Kind, ctx: WorkshopContext): readonly { id: Id; version: number }[] {
  if (kind === 'book') return ctx.bookEntries;
  if (kind === 'action') return ctx.actionCards;
  if (kind === 'pool') return ctx.pools;
  return ctx.rules;
}
/** Pools carry no status in the frozen contract. */
function statusOf(kind: Kind, entity: { id: Id }): string | null {
  if (kind === 'pool') return null;
  return (entity as { status?: string }).status ?? null;
}
function nameOf(kind: Kind, entity: { id: Id }): string {
  if (kind === 'book') return (entity as BookEntry).title;
  if (kind === 'action') return (entity as ActionCard).content.title;
  if (kind === 'pool') return (entity as Pool).name;
  return (entity as GenerationRule).name;
}

function buildEntity(kind: Kind, form: AnyForm) {
  if (kind === 'book') return formToBook(form as BookForm);
  if (kind === 'action') return formToAction(form as ActionForm);
  if (kind === 'pool') return formToPool(form as PoolForm);
  return formToRule(form as RuleForm);
}
function entityToForm(kind: Kind, entity: unknown): AnyForm {
  if (kind === 'book') return bookToForm(entity as BookEntry);
  if (kind === 'action') return actionToForm(entity as ActionCard);
  if (kind === 'pool') return poolToForm(entity as Pool);
  return ruleToForm(entity as GenerationRule);
}
function emptyForm(kind: Kind): AnyForm {
  if (kind === 'book') return emptyBookForm();
  if (kind === 'action') return emptyActionForm();
  if (kind === 'pool') return emptyPoolForm();
  return emptyRuleForm();
}
type SaveEntity = (draft: WorkshopEntity) => Promise<SaveOutcome<WorkshopEntity>>;
function saveFor(kind: Kind, host: WorkshopHost): SaveEntity {
  if (kind === 'book') return host.saveBookEntry as SaveEntity;
  if (kind === 'action') return host.saveActionCard as SaveEntity;
  if (kind === 'pool') return host.savePool as SaveEntity;
  return host.saveGenerationRule as SaveEntity;
}
function fullEntityFor(kind: Kind, ctx: WorkshopContext, id: Id): WorkshopEntity | undefined {
  if (kind === 'book') return ctx.bookEntries.find(x => x.id === id);
  if (kind === 'action') return ctx.actionCards.find(x => x.id === id);
  if (kind === 'pool') return ctx.pools.find(x => x.id === id);
  return ctx.rules.find(x => x.id === id);
}
function ensureId<T extends { id: Id; version: number }>(entity: T): T {
  return { ...entity, id: entity.id || crypto.randomUUID(), version: entity.version || 1 };
}

export function WorkshopEditor({ host, onUpgrade }: Readonly<{ host: WorkshopHost; onUpgrade?: () => void }>) {
  const [ctx, setCtx] = useState<WorkshopContext | null>(null);
  const [loadError, setLoadError] = useState<SaveOutcome<unknown> | null>(null);
  const [kind, setKind] = useState<Kind>('book');
  const [editKind, setEditKind] = useState<Kind>('book');
  const [spherePoolId, setSpherePoolId] = useState<string | null>(null);
  const [sphereCardId, setSphereCardId] = useState<string | null>(null);
  const [navId, setNavId] = useState<Id | null>(null);
  const [form, setForm] = useState<AnyForm | null>(null);
  const [editor, setEditor] = useState<'form' | 'json'>('form');
  const [json, setJson] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const r = await host.load();
    if (r.ok) { setCtx(r.value); setLoadError(null); }
    else { setCtx(null); setLoadError(r); setNotice({ kind: 'err', text: r.message }); }
  }, [host]);
  useEffect(() => { void reload(); }, [reload]);

  const isTestAdapter = 'adapter' in host && host.adapter === 'in-memory-test';

  const startNew = (k: Kind) => { setKind(k); setEditKind(k); setForm({...emptyForm(k),id:crypto.randomUUID()}); setEditor('form'); setNotice(null); };
  const startNewPool = (parentId: Id | null) => {
    setKind('pool'); setEditKind('pool'); setForm({...emptyPoolForm('book'),id:crypto.randomUUID(), parentPoolId: parentId ?? ''}); setEditor('form'); setNotice(null);
  };
  const editEntity = (k: Kind, id: Id) => {
    if (!ctx) return;
    const entity = listFor(k, ctx).find(item => item.id === id);
    if (entity) { if (!spherePoolId) setKind(k); setEditKind(k); setForm(entityToForm(k, entity)); setEditor('form'); setNotice(null); }
  };
  const discard = () => { setForm(null); setJson(''); setNotice(null); };

  const showFailure = (r: SaveOutcome<unknown>) => {
    if (r.ok) return;
    const text = r.issues?.length ? r.issues.map(i => `${i.path}: ${i.message}`).join('；') : r.message;
    setNotice({ kind: 'err', text });
  };

  const saveForm = async () => {
    if (!form || busy) return;
    setBusy(true);
    try {
      const r = await saveFor(editKind, host)(ensureId(buildEntity(editKind, form)));
      if (!r.ok) { showFailure(r); return; } // draft preserved on failure
      setNotice({ kind: 'ok', text: '已保存' }); setForm(null); await reload();
    } finally { setBusy(false); }
  };

  const applyJson = async () => {
    if (busy || !json.trim()) return;
    setBusy(true);
    try {
      let parsed: unknown;
      try { parsed = parseWorkshopJson(json); } catch { setNotice({ kind: 'err', text: 'JSON 格式错误' }); return; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {setNotice({kind:'err',text:'JSON 必须是一个实体对象'});return;}
      const normalized = ensureId(parsed as WorkshopEntity);
      setJson(JSON.stringify(normalized,null,2));
      const r = await saveFor(editKind, host)(normalized);
      if (!r.ok) { showFailure(r); return; }
      setNotice({ kind: 'ok', text: 'JSON 已通过同一校验并保存' }); setJson(''); setForm(null); await reload();
    } finally { setBusy(false); }
  };

  const changeStatus = async (k: Kind, id: Id, status: string) => {
    if (!ctx || busy) return;
    setBusy(true);
    try {
      const entity = fullEntityFor(k, ctx, id);
      if (!entity) return;
      const r = await saveFor(k, host)({ ...(entity as object), status } as WorkshopEntity);
      if (!r.ok) { showFailure(r); return; }
      await reload();
    } finally { setBusy(false); }
  };

  const switchToJson = () => {
    if (!form) return;
    setJson(JSON.stringify(buildEntity(editKind, form), null, 2)); setEditor('json');
  };
  const switchToForm = () => {
    try {
      setForm(entityToForm(editKind, parseWorkshopJson(json))); setEditor('form');
    } catch { setNotice({ kind: 'err', text: 'JSON 无效，不能切回表单' }); }
  };

  function editorContent() {
    if (!ctx) return null;
    return form ? <>
      <div className="segmented">
        <button aria-pressed={editor === 'form'} onClick={switchToForm}>表单</button>
        <button aria-pressed={editor === 'json'} onClick={switchToJson}>高级 JSON</button>
      </div>
      {editor === 'form' ? <>
        {editKind === 'book' && <BookFields form={form as BookForm} set={setForm}/>}
        {editKind === 'action' && <ActionFields form={form as ActionForm} set={setForm} ctx={ctx}/>}
        {editKind === 'pool' && <PoolFields form={form as PoolForm} set={setForm} ctx={ctx}/>}
        {editKind === 'rule' && <RuleFields form={form as RuleForm} set={setForm} ctx={ctx}/>}
        <div className="toolbar" style={{marginTop:18}}><button type="button" className="primary" disabled={busy} onClick={() => void saveForm()}>保存</button>
          <button type="button" disabled={busy} onClick={discard}>取消</button></div>
      </> : <>
        <textarea className="jsonbox" aria-label="实体 JSON" value={json} onChange={e => setJson(e.target.value)} rows={16}/>
        <div className="toolbar"><button type="button" className="primary" disabled={busy} onClick={() => void applyJson()}>应用 JSON（同一校验）</button>
          <button type="button" disabled={busy} onClick={discard}>取消</button></div>
      </>}
    </> : <p className="emptyline">从左侧选择一项编辑，或新建。</p>;
  }

  if (!ctx) {
    if (loadError && !loadError.ok) return (
      <div className="action-shell">
        <div className="message action-notice" role="alert"><span>{loadError.message}</span></div>
        {loadError.code === 'UNSUPPORTED_VERSION'
          ? <section className="panel"><p>工坊需要 Data v3。请先到“数据与备份”生成完整备份、预览并显式升级，再回来制卡。</p>
              <div className="toolbar">{onUpgrade ? <button className="primary" type="button" onClick={onUpgrade}>去升级</button> : null}
                <button type="button" onClick={() => void reload()}>重新载入</button></div></section>
          : <section className="panel"><div className="toolbar"><button className="primary" type="button" onClick={() => void reload()}>重新载入</button></div></section>}
      </div>
    );
    return <div className="action-shell"><p>加载工坊中…</p></div>;
  }

  const spherePool = ctx.pools.find(p => p.id === spherePoolId);
  const sphereMembers = spherePool ? (spherePool.poolKind === 'book' ? ctx.bookEntries : ctx.actionCards).filter(item => spherePool.memberIds.includes(item.id)) : [];
  return (
    <div className="action-shell">
      <div className="action-workbar">
        <div><h1>制卡工坊</h1>
          <p className="sub">维护行动原卡、书目、卡池与生成规则；编辑不改已生成的快照。</p></div>
        <div className="action-viewtabs" role="tablist" aria-label="工坊实体">
          <button type="button" disabled={busy} onClick={() => void reload()}>重新读取</button>
          {(Object.keys(KIND_LABEL) as Kind[]).map(k => (
            <button type="button" role="tab" aria-pressed={kind === k} key={k} onClick={() => { setKind(k); setForm(null); }}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      {isTestAdapter ? (
        <div className="message action-notice" role="status"><span>测试适配器：数据仅在内存、刷新即失，并未真正保存到本机。</span></div>
      ) : null}
      {notice ? (
        <div className={`message action-notice ${notice.kind === 'ok' ? 'ok' : ''}`} role="status">
          <span>{notice.text}</span><button aria-label="关闭提示" onClick={() => setNotice(null)}>×</button>
        </div>
      ) : null}

      <div className="action-layout">
        <section className="panel">
          {kind === 'pool' ? (
            <PoolHierarchy pools={ctx.pools} currentId={navId} onNavigate={setNavId} paused={Boolean(spherePoolId)}
              onOpenPool={p => editEntity('pool', p.id)} onNewHere={startNewPool} contentDisabled={Boolean(form) || busy}
              onContents={p => {setSpherePoolId(p.id);setSphereCardId(null);}}/>
          ) : <>
          <div className="sectiontitle">
            <h2>{KIND_LABEL[kind]}列表（{listFor(kind, ctx).length}）</h2>
            <button type="button" className="act-mini primary" disabled={busy} onClick={() => startNew(kind)}>＋ 新建</button>
          </div>
          <div className="action-list">
            {listFor(kind, ctx).length ? listFor(kind, ctx).map(entity => {
              const status = statusOf(kind, entity);
              return (
              <div key={entity.id} className="action-list-row">
                <button type="button" className="row-open" onClick={() => editEntity(kind, entity.id)}>
                  {nameOf(kind, entity)} <small>v{entity.version}{status ? ` · ${status}` : ''}</small>
                </button>
                {status !== null ? (
                <span className="row-actions">
                  {kind !== 'book' && status === 'active'
                    ? <button type="button" className="act-mini" disabled={busy} onClick={() => void changeStatus(kind, entity.id, 'paused')}>暂停</button> : null}
                  {status === 'paused'
                    ? <button type="button" className="act-mini" disabled={busy} onClick={() => void changeStatus(kind, entity.id, 'active')}>恢复</button> : null}
                  {status !== 'archived'
                    ? <button type="button" className="act-mini" disabled={busy} onClick={() => void changeStatus(kind, entity.id, 'archived')}>归档</button>
                    : <button type="button" className="act-mini" disabled={busy} onClick={() => void changeStatus(kind, entity.id, 'active')}>恢复</button>}
                </span>
                ) : null}
              </div>
              );
            }) : <p className="emptyline">还没有{KIND_LABEL[kind]}，点击“新建”开始。</p>}
          </div>
          </>}
        </section>

        <section className="panel">
          {spherePoolId ? <p>当前操作在牌堆球面中。</p> : editorContent()}
        </section>
      </div>
      {spherePool && <div className="sphere-modal"><Sphere mode="edit" cards={sphereMembers.map(item => ({id:item.id,face:'front',frontData:{title:'title' in item ? item.title : item.content.title,subtitle:`v${item.version} · ${item.status}`}}))}
        motionState={sphereCardId ? 'presented' : 'idle'} presentedId={sphereCardId} revealedId={sphereCardId}
        onSelectCard={id => {setSphereCardId(id);editEntity(spherePool.poolKind === 'book' ? 'book' : 'action',id);}}
        onReveal={() => {}} onReturn={() => {if (!busy) {setSphereCardId(null);setForm(null);}}}
        onClose={() => {if (!busy) {setSpherePoolId(null);setSphereCardId(null);setForm(null);}}} detail={sphereCardId ? editorContent() : null}/></div>}
    </div>
  );
}

/* ---------------- Field editors ---------------- */

function BookFields({ form, set }: Readonly<{ form: BookForm; set: (f: AnyForm) => void }>) {
  return (
    <div className="formgrid">
      <label>书名 *<input aria-label="书名" value={form.title} onChange={e => set({ ...form, title: e.target.value })} /></label>
      <label>作者（可空）<input aria-label="作者" value={form.author} onChange={e => set({ ...form, author: e.target.value })} /></label>
    </div>
  );
}

function ActionFields({ form, set, ctx }: Readonly<{ form: ActionForm; set: (f: AnyForm) => void; ctx: WorkshopContext }>) {
  const patchSlot = (id: string, patch: Partial<ActionForm['slots'][number]>) =>
    set({ ...form, slots: form.slots.map(s => (s.id === id ? { ...s, ...patch } : s)) });
  const addSlot = () =>
    set({ ...form, slots: [...form.slots, { id: crypto.randomUUID(), label: '新槽', poolId: ctx.pools[0]?.id ?? '', required: true }] });
  const removeSlot = (id: string) => set({ ...form, slots: form.slots.filter(s => s.id !== id) });

  return (
    <>
      <div className="formgrid">
        <label>行动名称 *<input aria-label="行动名称" value={form.title} onChange={e => set({ ...form, title: e.target.value })} /></label>
        <label>预设时长（分钟，留空为无）<input aria-label="预设时长" value={form.presetText} onChange={e => set({ ...form, presetText: e.target.value })} /></label>
        <label>颜色<input type="color" aria-label="颜色" value={form.color} onChange={e => set({ ...form, color: e.target.value })} /></label>
      </div>
      <label style={{ marginTop: 12 }}>完成标准<textarea aria-label="完成标准" rows={2} value={form.criteria} onChange={e => set({ ...form, criteria: e.target.value })} /></label>
      <div className="slot-editor" style={{ marginTop: 12 }}>
        <div className="sectiontitle"><h3>槽位</h3><button type="button" onClick={addSlot}>＋ 添加槽</button></div>
        {form.slots.length ? form.slots.map(s => (
          <div key={s.id} className="slot-edit-row">
            <input aria-label="槽标签" value={s.label} onChange={e => patchSlot(s.id, { label: e.target.value })} />
            <select aria-label="绑定书目池" value={s.poolId} onChange={e => patchSlot(s.id, { poolId: e.target.value })}>
              <option value="">选择书目池</option>
              {ctx.pools.filter(p => p.poolKind === 'book').map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <label><input type="checkbox" checked={s.required} onChange={e => patchSlot(s.id, { required: e.target.checked })} />必填</label>
            <button type="button" onClick={() => removeSlot(s.id)}>移除</button>
          </div>
        )) : <p className="muted">无槽，普通行动可直接接受。</p>}
      </div>
    </>
  );
}

function PoolFields({ form, set, ctx }: Readonly<{ form: PoolForm; set: (f: AnyForm) => void; ctx: WorkshopContext }>) {
  const candidates = form.poolKind === 'book' ? ctx.bookEntries : ctx.actionCards;
  const toggle = (id: Id) =>
    set({ ...form, memberIds: form.memberIds.includes(id) ? form.memberIds.filter(x => x !== id) : [...form.memberIds, id] });
  const candidateName = (entity: { id: Id }): string =>
    form.poolKind === 'book' ? (entity as BookEntry).title : (entity as ActionCard).content.title;

  return (
    <>
      <div className="formgrid">
        <label>池名称 *<input aria-label="池名称" value={form.name} onChange={e => set({ ...form, name: e.target.value })} /></label>
        <label>种类<select aria-label="池种类" value={form.poolKind}
          onChange={e => set({ ...form, poolKind: e.target.value as Pool['poolKind'], memberIds: [] })}>
          <option value="book">书目池</option><option value="action">行动池</option>
        </select></label>
        <label>父池（导航，可跨种类）<select aria-label="父池" value={form.parentPoolId}
          onChange={e => set({ ...form, parentPoolId: e.target.value as Id | '' })}>
          <option value="">无（顶层）</option>
          {allowedParentPools(ctx.pools, form.id).map(p =>
            <option key={p.id} value={p.id}>{p.name}（{p.poolKind === 'book' ? '书目' : '行动'}）</option>)}
        </select></label>
      </div>
      <fieldset className="member-picker" style={{ marginTop: 12 }}><legend>成员（同种类）</legend>
        <p role="status">已选 {form.memberIds.length} / {POOL_CAPACITY} 张</p>
        {form.memberIds.length > POOL_CAPACITY && <p role="alert">该池超出当前上限，原数据保持；新增成员已禁用。</p>}
        {candidates.length ? candidates.map(c => (
          <label key={c.id}><input type="checkbox" checked={form.memberIds.includes(c.id)}
            disabled={!form.memberIds.includes(c.id) && form.memberIds.length >= POOL_CAPACITY} onChange={() => toggle(c.id)} />{candidateName(c)}</label>
        )) : <p className="muted">还没有可加入的同种类实体。</p>}
      </fieldset>
    </>
  );
}

function RuleFields({ form, set, ctx }: Readonly<{ form: RuleForm; set: (f: AnyForm) => void; ctx: WorkshopContext }>) {
  const dayLabel = ['日', '一', '二', '三', '四', '五', '六'];
  const toggleDay = (d: number) =>
    set({ ...form, weekdays: form.weekdays.includes(d) ? form.weekdays.filter(x => x !== d) : [...form.weekdays, d] });
  return (
    <>
      <div className="formgrid">
        <label>规则名称 *<input aria-label="规则名称" value={form.name} onChange={e => set({ ...form, name: e.target.value })} /></label>
        <label>绑定行动原卡 *<select aria-label="绑定行动原卡" value={form.actionCardId}
          onChange={e => set({ ...form, actionCardId: e.target.value as Id | '' })}>
          <option value="">选择行动原卡</option>
          {ctx.actionCards.map(c => <option key={c.id} value={c.id}>{c.content.title}</option>)}
        </select></label>
        <label>开始日期 *<input type="date" aria-label="开始日期" value={form.startDate} onChange={e => set({ ...form, startDate: e.target.value })} /></label>
        <label>时区 *<input aria-label="时区" value={form.zone} onChange={e => set({ ...form, zone: e.target.value })} /></label>
      </div>
      <fieldset style={{ marginTop: 12 }}><legend>排期</legend>
        <label><input type="radio" name="rule-sched" checked={form.scheduleMode === 'daily'} onChange={() => set({ ...form, scheduleMode: 'daily' })} />每日</label>
        <label><input type="radio" name="rule-sched" checked={form.scheduleMode === 'weekdays'} onChange={() => set({ ...form, scheduleMode: 'weekdays' })} />指定星期</label>
        {form.scheduleMode === 'weekdays' ? (
          <div className="weekday-picker" style={{ marginTop: 8 }}>
            {[0, 1, 2, 3, 4, 5, 6].map(d => (
              <button type="button" key={d} aria-pressed={form.weekdays.includes(d)} onClick={() => toggleDay(d)}>{dayLabel[d]}</button>
            ))}
          </div>
        ) : null}
      </fieldset>
    </>
  );
}
