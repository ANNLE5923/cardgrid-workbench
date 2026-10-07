/** B5 action-deck session. Scope and the exact presented original stay private;
 * a view/refresh/reveal never takes a card or changes the old daily inventory. */
import type { V06Host, Token, VersionRef } from '../workspace/index.ts';
import type {
  ActionCardV5,
  CatalogV06,
  Deck,
  HandCard,
  V06Command,
  V06Result,
} from '../workspace/v06.ts';
import { shuffleCandidates } from './selection.ts';

type Host = Pick<V06Host, 'loadV5' | 'readCatalog' | 'readMaterials' | 'submit' | 'subscribe'>;
export type ActionDrawPhase = 'idle' | 'shuffling' | 'presented' | 'revealed' | 'saved';
export type V06ActionDrawState = Readonly<{
  decks: readonly Deck[];
  deckIds: readonly string[];
  candidates: readonly ActionCardV5[];
  phase: ActionDrawPhase;
  selected: ActionCardV5 | null;
  saved: HandCard | null;
  token: Token | null;
  busy: boolean;
  canRetry: boolean;
  message: string;
  error: boolean;
}>;
const sameToken = (a: Token, b: Token) => a.epoch === b.epoch && a.revision === b.revision;
const error = (
  code:
    | 'INVALID_INPUT'
    | 'PREVIEW_STALE'
    | 'REVISION_CONFLICT'
    | 'WORKSPACE_REPLACED'
    | 'UNSUPPORTED_VERSION'
    | 'STORAGE_FAILED',
  message: string,
  retry: 'none' | 'reload' | 'preview' | 'same-command' = 'preview',
): Extract<V06Result<unknown>, { ok: false }> => ({ ok: false, code, message, retry });
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}

export function createV06ActionSession(
  host: Host,
  options: { id?: () => string; random?: () => number } = {},
) {
  const id = options.id ?? (() => crypto.randomUUID()),
    random = options.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]);
  let catalog: CatalogV06 | null = null,
    token: Token | null = null,
    deckIds: string[] = [],
    candidates: ActionCardV5[] = [],
    selected: ActionCardV5 | null = null;
  let selectedToken: Token | null = null,
    phase: ActionDrawPhase = 'idle',
    saved: HandCard | null = null,
    pending: V06Command | null = null;
  let locked = false,
    closed = false,
    off: (() => void) | null = null,
    reading = 0,
    refreshRequested = false;
  let state: V06ActionDrawState = frozen({
    decks: [],
    deckIds: [],
    candidates: [],
    phase,
    selected: null,
    saved: null,
    token: null,
    busy: false,
    canRetry: false,
    message: '',
    error: false,
  });
  const listeners = new Set<() => void>();
  function emit(message = state.message, failed = state.error) {
    if (closed) return;
    state = frozen(
      structuredClone({
        decks: catalog?.decks.filter((d) => d.deckKind === 'action') ?? [],
        deckIds,
        candidates,
        phase,
        selected,
        saved,
        token,
        busy: locked,
        canRetry: pending !== null,
        message,
        error: failed,
      }),
    );
    listeners.forEach((f) => f());
  }
  function reset() {
    selected = null;
    selectedToken = null;
    phase = 'idle';
    saved = null;
  }
  function scope(): V06Result<readonly ActionCardV5[]> {
    if (!catalog) return error('PREVIEW_STALE', '请先读取行动牌堆');
    if (new Set(deckIds).size !== deckIds.length) return error('INVALID_INPUT', '牌堆不能重复选择');
    const selectedDecks = deckIds.map((id) => catalog!.decks.find((d) => d.id === id));
    if (selectedDecks.some((d) => !d || d.deckKind !== 'action'))
      return error('INVALID_INPUT', '请仅勾选现有行动牌堆');
    const seen = new Set<string>(),
      result: ActionCardV5[] = [];
    for (const deck of selectedDecks)
      for (const memberId of deck!.memberIds) {
        if (seen.has(memberId)) continue;
        seen.add(memberId);
        const action = catalog.actionCards.find((a) => a.id === memberId);
        if (action?.status === 'active') result.push(structuredClone(action));
      }
    return { ok: true, value: result };
  }
  async function refresh(): Promise<V06Result<Readonly<{ loaded: true }>>> {
    const request = ++reading,
      r = await host.loadV5();
    if (closed || request !== reading) return error('PREVIEW_STALE', '读取已被更新', 'none');
    if (!r.ok) {
      if (r.code === 'UNSUPPORTED_VERSION') {
        reset();
        pending = null;
        catalog = null;
        candidates = [];
      }
      emit(r.message, true);
      return r;
    }
    const read = await host.readCatalog({ token: r.value.token });
    if (!read.ok) {
      emit(read.message, true);
      return read;
    }
    if (closed || request !== reading) return error('PREVIEW_STALE', '读取已被更新', 'none');
    const changed = token !== null && !sameToken(token, read.value.token),
      replaced = token !== null && token.epoch !== read.value.token.epoch;
    if (replaced) {
      pending = null;
      reset();
    } else if (changed && !pending) reset();
    catalog = structuredClone(read.value.data);
    token = read.value.token;
    // Preserve explicit selection, removing only decks that no longer exist.
    deckIds = deckIds.filter((id) =>
      catalog!.decks.some((d) => d.id === id && d.deckKind === 'action'),
    );
    const scoped = scope();
    candidates = scoped.ok ? [...scoped.value] : [];
    emit(
      replaced
        ? '工作区已被替换，请重新选择。'
        : changed && !pending
          ? '工作区已更新，原抽卡预览已失效。'
          : state.message,
      changed,
    );
    return { ok: true, value: { loaded: true } };
  }
  async function run<T>(fn: () => Promise<V06Result<T>>): Promise<V06Result<T>> {
    if (closed) return error('PREVIEW_STALE', '会话已关闭', 'none');
    if (locked) return error('PREVIEW_STALE', '正在处理本次操作', 'none');
    locked = true;
    emit();
    try {
      return await fn();
    } catch (e) {
      const r = error(
        'STORAGE_FAILED',
        e instanceof Error ? e.message : '读取或保存失败',
        pending ? 'same-command' : 'reload',
      );
      emit(r.message, true);
      return r;
    } finally {
      locked = false;
      emit();
      if (refreshRequested && !pending) {
        refreshRequested = false;
        void refresh();
      }
    }
  }
  async function execute(): Promise<V06Result<Readonly<{ card: HandCard; token: Token }>>> {
    if (!pending) return error('PREVIEW_STALE', '没有待重试的保存');
    const command = pending,
      r = await host.submit(command);
    if (!r.ok) {
      if (r.retry !== 'same-command') {
        pending = null;
        reset();
        await refresh();
      }
      emit(r.message, true);
      return r;
    }
    const loaded = await host.loadV5({ epoch: command.expected.epoch });
    if (!loaded.ok) {
      if (loaded.code === 'WORKSPACE_REPLACED') {
        pending = null;
        reset();
      }
      emit(loaded.message, true);
      return loaded;
    }
    if (loaded.value.token.epoch !== command.expected.epoch) {
      pending = null;
      reset();
      emit('工作区已被替换，旧请求已清除。', true);
      return error('WORKSPACE_REPLACED', state.message, 'reload');
    }
    const cards = await host.readMaterials({ token: loaded.value.token });
    if (!cards.ok) {
      emit(cards.message, true);
      return cards;
    }
    const ids = r.value.resultRefs.filter((ref) => ref.kind === 'hand-card').map((ref) => ref.id),
      card = cards.value.data.find((c) => ids.includes(c.id) && c.kind === 'action');
    if (!card) {
      const failure = error('STORAGE_FAILED', '回执尚未完整读回，请重试原请求', 'same-command');
      emit(failure.message, true);
      return failure;
    }
    saved = structuredClone(card);
    pending = null;
    phase = 'saved';
    token = cards.value.token;
    selectedToken = null;
    emit('已保存到本机，本次行动素材已加入手牌。', false);
    return { ok: true, value: { card: structuredClone(card), token: cards.value.token } };
  }
  return {
    readonlyScope: 'b5-action-session' as const,
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: () =>
      run(async () => {
        if (!off)
          off = host.subscribe(() => {
            if (locked || pending) refreshRequested = true;
            else void refresh();
          });
        return refresh();
      }),
    refresh: () => run(refresh),
    setDeckIds(ids: readonly string[]): V06Result<Readonly<{ changed: boolean }>> {
      if (locked || pending || closed)
        return error('PREVIEW_STALE', '请先完成或重试当前保存', 'none');
      if (ids.length === deckIds.length && ids.every((id, i) => id === deckIds[i]))
        return { ok: true, value: { changed: false } };
      const before = deckIds;
      deckIds = [...ids];
      const checked = scope();
      if (!checked.ok) {
        deckIds = before;
        emit(checked.message, true);
        return checked;
      }
      candidates = [...checked.value];
      reset();
      emit(
        !ids.length
          ? '请勾选至少一个行动牌堆。'
          : !candidates.length
            ? '所选牌堆没有可用行动。'
            : '',
        false,
      );
      return { ok: true, value: { changed: true } };
    },
    openSphere: () =>
      run(async () => {
        if (pending) return error('PREVIEW_STALE', '请先重试本次保存', 'same-command');
        const r = await refresh();
        if (!r.ok) return r;
        if (!deckIds.length || !candidates.length) {
          emit(!deckIds.length ? '请勾选至少一个行动牌堆。' : '所选牌堆没有可用行动。', true);
          return error('INVALID_INPUT', state.message);
        }
        reset();
        candidates = shuffleCandidates(candidates, random);
        phase = 'shuffling';
        emit('', false);
        return { ok: true, value: { opened: true as const } };
      }),
    present(actionId: string) {
      if (locked || pending || closed || !['idle', 'shuffling'].includes(phase)) return;
      const action = candidates.find((a) => a.id === actionId);
      if (!action) return;
      selected = structuredClone(action);
      selectedToken = token;
      phase = 'presented';
      emit('', false);
    },
    reveal(actionId?: string) {
      if (
        locked ||
        pending ||
        closed ||
        phase !== 'presented' ||
        !selected ||
        (actionId && actionId !== selected.id)
      )
        return;
      phase = 'revealed';
      emit('', false);
    },
    cancel(): boolean {
      if (locked || pending || closed) {
        emit('保存结果尚未确认，请先重试原请求。', true);
        return false;
      }
      reset();
      emit('', false);
      return true;
    },
    accept: () =>
      run(async () => {
        if (pending) return execute();
        if (phase === 'saved' && saved && token) {
          const checked = await host.loadV5({ epoch: token.epoch });
          if (!checked.ok) {
            reset();
            emit(checked.message, true);
            return checked;
          }
          return { ok: true, value: { card: structuredClone(saved), token } };
        }
        if (phase !== 'revealed' || !selected || !selectedToken)
          return error('PREVIEW_STALE', '请先选定并翻开一张行动牌');
        const action: VersionRef = { id: selected.id, version: selected.version };
        pending = {
          contractVersion: 'v06-p0-1',
          commandId: id(),
          expected: selectedToken,
          type: 'TakeActionMaterial',
          payload: { action },
        };
        return execute();
      }),
    retry: () => run(execute),
    close() {
      closed = true;
      reading++;
      off?.();
      listeners.clear();
      catalog = null;
      selected = null;
      saved = null;
    },
  };
}
export type V06ActionSession = ReturnType<typeof createV06ActionSession>;
