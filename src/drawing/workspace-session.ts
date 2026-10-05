import type {WorkspaceClient, WorkspaceSnapshot, Command, Token, SlotSelection, DailyCopy} from '../workspace/index.ts';
import {dateAt, nextDate} from '../daily/time.ts';
import {INITIAL_SESSION, drawReducer, type DrawSession} from './draw-session.ts';
import {selectCandidate, shuffleCandidates} from './selection.ts';
import type {ComboPreview} from './composition.ts';

type Status = 'loading' | 'ready' | 'working' | 'submitting' | 'retry' | 'success' | 'invalidated' | 'unsupported' | 'error';
export type WorkspaceDrawState = Readonly<{
  snapshot: WorkspaceSnapshot | null; copies: readonly DailyCopy[]; todayIds: readonly string[];
  at: string | null; session: DrawSession; selections: readonly SlotSelection[]; preview: ComboPreview | null;
  status: Status; busy: boolean; message: string; canRetry: boolean;
}>;
type Host = Pick<WorkspaceClient, 'load' | 'readInventory' | 'previewGeneration' | 'previewCombo' | 'selectEntry' | 'submit' | 'subscribe'>;
type Pending = {command: Command; purpose: 'accept' | 'archive' | 'generate'; title?: string};
const sameToken = (a: Token | undefined, b: Token) => a?.epoch === b.epoch && a.revision === b.revision;

/** Production session owns drafts and retry identity, never workspace data or persistence. */
export function createWorkspaceDrawSession(host: Host, options: {id?: () => string; random?: () => number} = {}) {
  const id = options.id ?? (() => crypto.randomUUID()), random = options.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]);
  let state: WorkspaceDrawState = {snapshot: null, copies: [], todayIds: [], at: null, session: INITIAL_SESSION,
    selections: [], preview: null, status: 'loading', busy: false, message: '', canRetry: false};
  let pending: Pending | null = null, locked = false, writing = false, closed = false, generation = 0, reading = 0;
  let off: (() => void) | null = null;
  const listeners = new Set<() => void>();
  function emit(change: Partial<WorkspaceDrawState>) {if (closed) return; state = {...state, ...change}; listeners.forEach(fn => fn());}
  function discard(message = '', status: Status = 'ready') {
    generation++; pending = null;
    emit({session: INITIAL_SESSION, selections: [], preview: null, canRetry: false, message, status});
  }
  async function refresh(invalidate = true): Promise<boolean> {
    const request = ++reading;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await host.load(); if (closed || request !== reading) return false;
      if (!result.ok) {emit({status: 'error', message: result.message}); return false;}
      const snapshot = result.value, replaced = !!state.snapshot && !sameToken(state.snapshot.token, snapshot.token);
      if (invalidate && replaced) discard('工作区已更新，抽卡草稿已失效，请重新选择。', 'invalidated');
      if (snapshot.data?.version !== 3) {
        discard('请先到“数据与备份”备份并升级，再使用每日库存。', 'unsupported');
        emit({snapshot, copies: [], todayIds: [], at: null}); return true;
      }
      const [inventory, planned] = await Promise.all([host.readInventory({token: snapshot.token}), host.previewGeneration({token: snapshot.token})]);
      if (closed || request !== reading) return false;
      if (!inventory.ok || !planned.ok) {
        const error = !inventory.ok ? inventory : !planned.ok ? planned : null;
        if (error?.code === 'REVISION_CONFLICT' || error?.code === 'WORKSPACE_REPLACED') continue;
        emit({status: 'error', message: error?.message ?? '库存读取失败'}); return false;
      }
      const at = planned.value.at, rules = snapshot.data.generationRules;
      const copies = inventory.value.copies.filter(copy => {
        const rule = rules.find(r => r.id === copy.ruleId);
        return rule && dateAt(at, rule.zone) < nextDate(copy.sourceDate, 7);
      });
      const todayIds = copies.filter(copy => {
        const rule = rules.find(r => r.id === copy.ruleId)!;
        return copy.sourceDate === dateAt(at, rule.zone);
      }).map(copy => copy.id);
      emit({snapshot, copies, todayIds, at, status: state.status === 'loading' || state.status === 'error' ? 'ready' : state.status});
      return true;
    }
    emit({status: 'error', message: '工作区正在更新，请重新读取库存。'}); return false;
  }
  async function execute(request: Pending): Promise<boolean> {
    writing = true; emit({busy: true, canRetry: false, status: request.purpose === 'accept' ? 'submitting' : 'working'});
    try {
      const response = await host.submit(request.command);
      if (closed) return false;
      if (!response.ok) {
        if (response.retry === 'same-command') {
          pending = request;
          await refresh(false);
          // A replacement epoch must never revive an old request or draft.
          if (state.snapshot && state.snapshot.token.epoch !== request.command.expected.epoch) {
            discard('工作区已被替换，旧抽卡请求已清除。', 'invalidated'); return false;
          }
          emit({status: 'retry', canRetry: true, message: response.message});
        } else {
          discard(response.message, 'invalidated'); await refresh(false);
        }
        return false;
      }
      pending = null;
      discard(request.purpose === 'accept' ? `已保存到本机：${request.title}` : request.title ?? '今日库存已更新。', request.purpose === 'accept' ? 'success' : 'ready');
      await refresh(false); return true;
    } finally {writing = false;}
  }
  async function coordinate(): Promise<boolean> {
    if (locked || closed || pending) return false;
    locked = true; emit({busy: true});
    try {
      if (!await refresh() || state.snapshot?.data?.version !== 3) return false;
      for (let step = 0; step < 3; step++) {
        const snapshot = state.snapshot!; if (snapshot.data?.version !== 3 || !state.at) return false;
        const data = snapshot.data;
        const due = data.dailyCopies.some(copy => {
          const rule = data.generationRules.find(r => r.id === copy.ruleId);
          return rule && dateAt(state.at!, rule.zone) >= nextDate(copy.sourceDate, 7);
        });
        const planned = await host.previewGeneration({token: snapshot.token});
        if (!planned.ok) {discard(planned.message, 'invalidated'); await refresh(false); return false;}
        const type = due ? 'ArchiveDueCopies' : planned.value.planned.length ? 'GenerateDailyCopies' : null;
        if (!type) return true;
        discard('库存正在更新，请稍候。');
        pending = {purpose: due ? 'archive' : 'generate', command: {commandId: id(), expected: snapshot.token, type,
          payload: type === 'ArchiveDueCopies' ? {} : {target: 'current'}} as Command};
        if (!await execute(pending)) return false;
      }
      return true;
    } finally {locked = false; emit({busy: false});}
  }
  async function query(run: (token: Token, stamp: number) => Promise<void>) {
    if (locked || pending || closed || !state.snapshot || state.status === 'unsupported') return;
    locked = true; const stamp = generation, token = state.snapshot.token; emit({busy: true, status: 'working', message: ''});
    try {await run(token, stamp);} finally {locked = false; emit({busy: false, status: state.status === 'working' ? 'ready' : state.status});}
  }
  const current = (stamp: number, token: Token) => !closed && generation === stamp && sameToken(state.snapshot?.token, token);
  async function preview(token: Token, stamp: number, selections: readonly SlotSelection[]) {
    const phase = state.session.phase; if (phase.kind !== 'combo') return;
    const result = await host.previewCombo({token, copy: {id: phase.copy.id, version: phase.copy.version}, selections});
    if (!current(stamp, token)) return;
    if (!result.ok) {discard(result.message, 'invalidated'); await refresh(false); return;}
    const session = drawReducer(state.session, {type: 'validated-combo', copyId: phase.copy.id, selections: phase.selections.map(s => ({...s,
      entryId: selections.find(value => value.slotId === s.slotId)?.entryId ?? null})), composedText: result.value.composedText, ready: result.value.ready});
    emit({session, selections: structuredClone(selections), preview: result.value});
  }
  function choose(copyId: string) {
    if (locked || pending || closed) return;
    const copy = state.copies.find(c => c.id === copyId); if (!copy) return;
    discard();
    emit({session: drawReducer(drawReducer(INITIAL_SESSION, {type: 'start', copies: state.copies}), {type: 'present-copy', copyId})});
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) {listeners.add(fn); return () => {listeners.delete(fn);};},
    async start() {
      if (!off) off = host.subscribe(() => {if (!writing) void refresh();});
      return coordinate();
    },
    coordinate, refresh,
    async supplement(ruleId: string, date: string) {
      if (locked || pending || closed) return false;
      locked = true; emit({busy:true});
      try {
        if (!await refresh() || state.snapshot?.data?.version !== 3) return false;
        const token = state.snapshot.token, target = {ruleId,date};
        const planned = await host.previewGeneration({token,target});
        if (!planned.ok) {emit({status:'error',message:planned.message});return false;}
        if (!planned.value.planned.length) {emit({message:'该规则在这一天已记账或不适用，无需重复生成。'});return true;}
        discard();
        pending = {purpose:'generate',title:`已补生成 ${date} 的库存。`,command:{commandId:id(),expected:token,type:'GenerateDailyCopies',payload:{target}}};
        return await execute(pending);
      } finally {locked = false;emit({busy:false});}
    },
    choose,
    async openSphere() {
      if (!await coordinate()) return false;
      const copies = shuffleCandidates(state.copies.filter(c => state.todayIds.includes(c.id)), random);
      if (!copies.length) {discard('今天没有可抽取副本；可明确手选保留期内的旧副本。'); return false;}
      discard();
      emit({session: drawReducer(INITIAL_SESSION, {type: 'start', copies})});
      return true;
    },
    present(copyId: string) {
      if (locked || pending || closed || state.session.phase.kind !== 'shuffling') return;
      emit({session: drawReducer(state.session, {type: 'present-copy', copyId})});
    },
    async drawToday() {
      if (!await coordinate()) return;
      const copy = selectCandidate(state.copies.filter(c => state.todayIds.includes(c.id)), random);
      if (!copy) {discard('今天没有可抽取副本；可明确手选保留期内的旧副本。'); return;}
      choose(copy.id);
    },
    reveal() {if (!locked && !pending) emit({session: drawReducer(state.session, {type: 'second-tap'})});},
    async beginCombo() {
      await query(async (token, stamp) => {
        emit({session: drawReducer(state.session, {type: 'continue-to-combo'})});
        await preview(token, stamp, []);
      });
    },
    async setMode(slotId: string, mode: 'random' | 'manual') {
      await query(async (token, stamp) => {
        emit({session: drawReducer(state.session, {type: 'set-slot-mode', slotId, mode})});
        await preview(token, stamp, state.selections.filter(s => s.slotId !== slotId));
      });
    },
    async select(slotId: string, choice: {mode: 'random'} | {mode: 'manual'; entryId: string}) {
      await query(async (token, stamp) => {
        const phase = state.session.phase; if (phase.kind !== 'combo') return;
        const selected = await host.selectEntry({token, copy: {id: phase.copy.id, version: phase.copy.version}, slotId, choice});
        if (!current(stamp, token)) return;
        if (!selected.ok) {discard(selected.message, 'invalidated'); await refresh(false); return;}
        const selections = state.selections.filter(s => s.slotId !== slotId);
        if (selected.value.selection) selections.push(selected.value.selection);
        emit({session: drawReducer(state.session, {type: 'set-slot-mode', slotId, mode: choice.mode})});
        await preview(token, stamp, selections);
      });
    },
    async accept() {
      const phase = state.session.phase;
      if (locked || pending || closed || !state.snapshot || phase.kind !== 'combo' || !state.preview?.ready) return false;
      pending = {purpose: 'accept', title: state.preview.composedText, command: {commandId: id(), expected: state.snapshot.token,
        type: 'AcceptDailyCopy', payload: {copy: {id: phase.copy.id, version: phase.copy.version}, selections: structuredClone(state.selections), composedText: state.preview.composedText}}};
      locked = true; try {return await execute(pending);} finally {locked = false; emit({busy: false});}
    },
    async retry() {
      if (locked || !pending || closed) return false;
      locked = true; let accepted = false;
      try {accepted = await execute(pending);} finally {locked = false; emit({busy: false});}
      // A receipt may replay days after its commit. Resume deferred expiry/generation even
      // after acceptance, so a resolved uncertain save cannot leave expired hand active.
      if (accepted) await coordinate();
      return accepted;
    },
    cancel() {
      if (writing) return;
      if (pending) {emit({message: '保存结果尚未确认，请重试本次保存；重试不会重复创建行动。'}); return;}
      if (state.session.deck.length) discard('已取消，本次抽卡没有创建行动。');
    },
    close() {closed = true; generation++; reading++; off?.(); off = null; listeners.clear();},
  };
}
export type WorkspaceDrawSession = ReturnType<typeof createWorkspaceDrawSession>;
