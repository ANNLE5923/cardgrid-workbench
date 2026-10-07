import type { V06Host, Token } from '../../workspace/index.ts';
import type { V06Result } from '../../workspace/v06.ts';
import {
  materialDockItems,
  legacyDockItems,
  type HandDockView,
  type HandDockItem,
} from './unified.ts';

type Host = Pick<V06Host, 'loadV5' | 'readUnifiedHand' | 'subscribe'>;
type Failure = Extract<V06Result<never>, { ok: false }>;
const fail = (code: Failure['code'], message: string): Failure => ({
  ok: false,
  code,
  message,
  retry: 'reload',
});
const freeze = <T>(v: T): T => {
  if (v && typeof v === 'object') {
    Object.freeze(v);
    for (const c of Object.values(v)) freeze(c);
  }
  return v;
};
export type HandSessionState = Readonly<{
  view: HandDockView | null;
  loading: boolean;
  error: string;
}>;
/** An app-level disposable read session. It never writes, clones the workspace or closes its Host. */
export function createV06HandSession(host: Host) {
  let state: HandSessionState = freeze({ view: null, loading: true, error: '' }),
    sequence = 0,
    closed = false,
    off: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: HandSessionState) => {
    if (!closed) {
      state = freeze(next);
      for (const f of listeners) f();
    }
  };
  async function refresh(): Promise<V06Result<HandDockView>> {
    if (closed) return fail('PREVIEW_STALE', '手牌会话已关闭');
    const request = ++sequence;
    publish({ ...state, loading: true, error: '' });
    try {
      const source = await host.loadV5();
      if (closed || request !== sequence) return fail('PREVIEW_STALE', '忽略旧的手牌读取');
      if (!source.ok) {
        publish({ view: null, loading: false, error: source.message });
        return source;
      }
      const result = await host.readUnifiedHand({ token: source.value.token });
      if (closed || request !== sequence) return fail('PREVIEW_STALE', '忽略旧的手牌读取');
      if (!result.ok) {
        publish({ view: null, loading: false, error: result.message });
        return result;
      }
      const mapped = source.value.data.handCards.flatMap((c) =>
        (c.kind === 'action' || c.kind === 'composite') && c.actionInstanceId
          ? [c.actionInstanceId]
          : [],
      );
      const view: HandDockView = {
        token: result.value.token,
        items: [
          ...materialDockItems(result.value.data),
          ...legacyDockItems(source.value.data, mapped),
        ],
      };
      publish({ view, loading: false, error: '' });
      return { ok: true, value: view };
    } catch {
      const error = fail('STORAGE_FAILED', '手牌读取失败，请重新读取');
      if (request === sequence) publish({ view: null, loading: false, error: error.message });
      return error;
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start() {
      if (!off && !closed)
        off = host.subscribe(() => {
          void refresh();
        });
      return refresh();
    },
    refresh,
    /** Produces a guarded Today selection, not a saved plan. B7 owns its placement command. */
    async preparePlay(
      input: Readonly<{ isToday: boolean; token: Token; key: string; version: number }>,
    ): Promise<V06Result<Readonly<{ token: Token; item: HandDockItem }>>> {
      if (!input.isToday) return fail('INVALID_INPUT', '只有 Today 可以打出浮窗手牌');
      const result = await refresh();
      if (!result.ok) return result;
      const { token, items } = result.value;
      if (token.epoch !== input.token.epoch)
        return fail('WORKSPACE_REPLACED', '工作区已替换，请重新选择手牌');
      if (token.revision !== input.token.revision)
        return fail('REVISION_CONFLICT', '手牌已更新，请重新选择');
      const item = items.find((i) => i.key === input.key && i.version === input.version);
      if (!item) return fail('ENTRY_STALE', '这份手牌已不在手中，请重新选择');
      if (!item.usableInToday)
        return fail(
          item.unavailableReason === 'INCOMPLETE'
            ? 'REQUIRED_FIELD_EMPTY'
            : (item.unavailableReason ?? 'ENTRY_UNAVAILABLE'),
          '这份素材当前不能打出',
        );
      return { ok: true, value: { token, item } };
    },
    close() {
      if (closed) return;
      closed = true;
      sequence++;
      off?.();
      off = null;
      listeners.clear();
      state = freeze({ view: null, loading: false, error: '' });
    },
  };
}
export type V06HandSession = ReturnType<typeof createV06HandSession>;
